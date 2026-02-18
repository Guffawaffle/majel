/**
 * user-settings-store.ts — Per-User Settings Store (#86)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed per-user preferences with RLS isolation.
 * Resolution chain: user override → system default (settings table) → env → schema default.
 *
 * Table: user_settings
 *   - Composite PK (user_id, key)
 *   - RLS-scoped so each user only sees their own overrides
 *   - JSON-encoded values regardless of type (consistent with settings.ts)
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";
import { SETTINGS_SCHEMA, type SettingsStore } from "./settings.js";

// ─── Schema ─────────────────────────────────────────────────────

/** Allowed user-overridable setting key prefixes. System/model settings are admin-only. */
const USER_OVERRIDABLE_PREFIXES = ["display.", "fleet."];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id    UUID NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings (user_id)`,
];

const SQL = {
  get: `SELECT value FROM user_settings WHERE user_id = $1 AND key = $2`,
  set: `INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  del: `DELETE FROM user_settings WHERE user_id = $1 AND key = $2`,
  allForUser: `SELECT key, value FROM user_settings WHERE user_id = $1 ORDER BY key`,
  count: `SELECT COUNT(*) AS count FROM user_settings WHERE user_id = $1`,
};

// ─── Validation ─────────────────────────────────────────────────

const SCHEMA_MAP = new Map(SETTINGS_SCHEMA.map((s) => [s.key, s]));

function isUserOverridable(key: string): boolean {
  return USER_OVERRIDABLE_PREFIXES.some((p) => key.startsWith(p));
}

function validateUserSetting(key: string, value: string): void {
  const def = SCHEMA_MAP.get(key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (!isUserOverridable(key)) throw new Error(`Setting "${key}" is not user-overridable`);
  if (def.type === "number" && isNaN(Number(value))) {
    throw new Error(`Setting ${key} must be a number, got: ${value}`);
  }
  if (def.type === "number" && def.min !== undefined && Number(value) < def.min) {
    throw new Error(`Setting ${key} minimum is ${def.min}, got: ${value}`);
  }
  if (def.type === "number" && def.max !== undefined && Number(value) > def.max) {
    throw new Error(`Setting ${key} maximum is ${def.max}, got: ${value}`);
  }
  if (def.type === "boolean" && !["true", "false", "1", "0"].includes(value)) {
    throw new Error(`Setting ${key} must be a boolean, got: ${value}`);
  }
}

// ─── Types ──────────────────────────────────────────────────────

export interface UserSettingEntry {
  key: string;
  value: string;
  source: "user" | "system" | "env" | "default";
}

export interface UserSettingsStore {
  /** Get a single user setting (user override → system fallback). */
  getForUser(userId: string, key: string): Promise<UserSettingEntry>;

  /** Set a per-user override. Validates against SETTINGS_SCHEMA. */
  setForUser(userId: string, key: string, value: string): Promise<void>;

  /** Delete a per-user override (reverts to system default). */
  deleteForUser(userId: string, key: string): Promise<boolean>;

  /** Get all settings for a user (merged: user overrides + system defaults). */
  getAllForUser(userId: string): Promise<UserSettingEntry[]>;

  /** Get only user-overridable settings for a user. */
  getOverridableForUser(userId: string): Promise<UserSettingEntry[]>;

  /** Count how many per-user overrides exist for a user. */
  countForUser(userId: string): Promise<number>;
}

// ─── Factory ────────────────────────────────────────────────────

export async function createUserSettingsStore(
  adminPool: Pool,
  runtimePool: Pool | undefined,
  systemSettingsStore: SettingsStore,
): Promise<UserSettingsStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.settings.debug("user settings store initialized (pg)");

  const store: UserSettingsStore = {
    async getForUser(userId: string, key: string): Promise<UserSettingEntry> {
      // 1. User override
      const result = await pool.query(SQL.get, [userId, key]);
      const row = result.rows[0] as { value: string } | undefined;
      if (row) {
        return { key, value: row.value, source: "user" };
      }

      // 2. System setting (settings table → env → schema default)
      const systemValue = await systemSettingsStore.get(key);
      const def = SCHEMA_MAP.get(key);

      // Determine source: check if it's in the system DB, env, or schema default
      if (def?.envVar && process.env[def.envVar]) {
        // Could be env but system store resolves this for us
        return { key, value: systemValue, source: "system" };
      }
      return { key, value: systemValue, source: "default" };
    },

    async setForUser(userId: string, key: string, value: string): Promise<void> {
      validateUserSetting(key, value);
      await pool.query(SQL.set, [userId, key, value]);
      log.settings.debug({ userId, key }, "user setting set");
    },

    async deleteForUser(userId: string, key: string): Promise<boolean> {
      const result = await pool.query(SQL.del, [userId, key]);
      const deleted = (result.rowCount ?? 0) > 0;
      log.settings.debug({ userId, key, deleted }, "user setting deleted");
      return deleted;
    },

    async getAllForUser(userId: string): Promise<UserSettingEntry[]> {
      // Get all user overrides
      const userResult = await pool.query(SQL.allForUser, [userId]);
      const userOverrides = new Map<string, string>();
      for (const row of userResult.rows) {
        const r = row as { key: string; value: string };
        userOverrides.set(r.key, r.value);
      }

      // Merge with all overridable settings from schema
      const entries: UserSettingEntry[] = [];
      for (const def of SETTINGS_SCHEMA) {
        if (!isUserOverridable(def.key)) continue;
        const userVal = userOverrides.get(def.key);
        if (userVal !== undefined) {
          entries.push({ key: def.key, value: userVal, source: "user" });
        } else {
          const systemVal = await systemSettingsStore.get(def.key);
          entries.push({ key: def.key, value: systemVal, source: "default" });
        }
      }
      return entries;
    },

    async getOverridableForUser(userId: string): Promise<UserSettingEntry[]> {
      return store.getAllForUser(userId);
    },

    async countForUser(userId: string): Promise<number> {
      const result = await pool.query(SQL.count, [userId]);
      return Number((result.rows[0] as { count: string | number }).count);
    },
  };

  return store;
}
