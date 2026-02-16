/**
 * settings.ts — User Settings Store
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed key/value store for user-configurable settings.
 *
 * Priority chain for runtime config:
 *   1. User setting (this store)  ← highest
 *   2. Environment variable
 *   3. Schema default             ← lowest
 *
 * Settings are typed, validated, and have defaults. The UI can
 * read/write them via /api/settings endpoints.
 *
 * Migrated to PostgreSQL in ADR-018 Phase 3.
 */

import { initSchema, withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Schema ─────────────────────────────────────────────────────

/**
 * All known setting keys with their metadata.
 * Adding a new setting = add it here. Everything else flows from this.
 */
export interface SettingDef {
  key: string;
  category: "display" | "model" | "system" | "fleet";
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "json";
  default: string;
  /** If set, this env var provides the fallback before the default. */
  envVar?: string;
  /** If true, the value is masked in API responses (e.g. future API keys). */
  sensitive?: boolean;
  /** Validation constraint: minimum numeric value. */
  min?: number;
  /** Validation constraint: maximum numeric value. */
  max?: number;
}

export const SETTINGS_SCHEMA: SettingDef[] = [
  // ── Display ─────────────────────────────────────────────────
  {
    key: "display.admiralName",
    category: "display",
    label: "Admiral Name",
    description: "How Majel addresses you. Default: Admiral.",
    type: "string",
    default: "Admiral",
  },
  {
    key: "display.theme",
    category: "display",
    label: "UI Theme",
    description: "LCARS color theme. Options: default, red-alert, andorian.",
    type: "string",
    default: "default",
  },

  // ── Model ───────────────────────────────────────────────────
  {
    key: "model.apiKey",
    category: "model",
    label: "Gemini API Key",
    description: "Google Gemini API key for LLM access.",
    type: "string",
    default: "",
    envVar: "GEMINI_API_KEY",
    sensitive: true,
  },
  {
    key: "model.name",
    category: "model",
    label: "Model Name",
    description: "Gemini model identifier.",
    type: "string",
    default: "gemini-3-flash-preview",
  },
  {
    key: "model.temperature",
    category: "model",
    label: "Temperature",
    description: "Sampling temperature (0.0–2.0). Lower = more focused.",
    type: "number",
    default: "1.0",
  },
  {
    key: "model.topP",
    category: "model",
    label: "Top-P",
    description: "Nucleus sampling threshold (0.0–1.0).",
    type: "number",
    default: "0.95",
  },

  // ── System ──────────────────────────────────────────────────
  {
    key: "system.port",
    category: "system",
    label: "Server Port",
    description: "HTTP port for Majel.",
    type: "number",
    default: "3000",
    envVar: "MAJEL_PORT",
  },
  {
    key: "system.uiMode",
    category: "system",
    label: "UI Mode",
    description: "Controls UI complexity. BASIC hides power-user features; ADVANCED shows crew builder, conflict matrix, and bulk operations.",
    type: "string",
    default: "basic",
  },

  // ── Fleet ───────────────────────────────────────────────────
  {
    key: "fleet.opsLevel",
    category: "fleet",
    label: "Operations Level",
    description: "Your current Starbase Operations level (1–80). Determines what content and ships are relevant.",
    type: "number",
    default: "1",
    min: 1,
    max: 80,
  },
  {
    key: "fleet.drydockCount",
    category: "fleet",
    label: "Drydocks",
    description: "Number of drydocks you have unlocked (1–8). Each drydock holds one active ship.",
    type: "number",
    default: "1",
    min: 1,
    max: 8,
  },
  {
    key: "fleet.shipHangarSlots",
    category: "fleet",
    label: "Ship Hangar Slots",
    description: "Total ship inventory capacity from your Ship Hangar building.",
    type: "number",
    default: "43",
    min: 1,
    max: 999,
  },
];

/** Lookup map for fast access. */
const SCHEMA_MAP = new Map<string, SettingDef>(
  SETTINGS_SCHEMA.map((s) => [s.key, s])
);

// ─── SQL ────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];

const SQL = {
  get: `SELECT value FROM settings WHERE key = $1`,
  set: `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  del: `DELETE FROM settings WHERE key = $1`,
  all: `SELECT key, value FROM settings`,
  count: `SELECT COUNT(*) AS count FROM settings`,
};

// ─── Settings Store ─────────────────────────────────────────────

export interface SettingsStore {
  /** Get a single setting's resolved value (user → env → default). */
  get(key: string): Promise<string>;

  /** Get a setting parsed to its native type. */
  getTyped(key: string): Promise<string | number | boolean | unknown>;

  /** Set a user-level setting. */
  set(key: string, value: string): Promise<void>;

  /** Delete a user-level setting (reverts to env/default). */
  delete(key: string): Promise<boolean>;

  /** Get all settings with their resolved values and metadata. */
  getAll(): Promise<SettingEntry[]>;

  /** Get all settings in a specific category. */
  getByCategory(category: string): Promise<SettingEntry[]>;

  /** Export all user-set values as a flat object. */
  exportUserValues(): Promise<Record<string, string>>;

  /** Import multiple settings at once. */
  importValues(values: Record<string, string>): Promise<void>;

  /** No-op — pool lifecycle managed externally. */
  close(): void;

  /** Count how many settings have user-level overrides. */
  countUserOverrides(): Promise<number>;
}

export interface SettingEntry {
  key: string;
  value: string;
  source: "user" | "env" | "default";
  category: string;
  label: string;
  description: string;
  type: string;
  sensitive: boolean;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Create a settings store backed by PostgreSQL.
 */
export async function createSettingsStore(adminPool: Pool, runtimePool?: Pool): Promise<SettingsStore> {
  // Schema init (DDL on admin pool, queries on app pool — #39)
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  /**
   * Resolve a setting: user DB → env var → schema default.
   */
  async function resolve(key: string): Promise<{ value: string; source: "user" | "env" | "default" }> {
    // 1. User setting (DB)
    const result = await pool.query(SQL.get, [key]);
    const row = result.rows[0] as { value: string } | undefined;
    if (row) {
      return { value: row.value, source: "user" };
    }

    // 2. Env var
    const def = SCHEMA_MAP.get(key);
    if (def?.envVar) {
      const envVal = process.env[def.envVar];
      if (envVal !== undefined && envVal !== "") {
        return { value: envVal, source: "env" };
      }
    }

    // 3. Schema default
    return { value: def?.default ?? "", source: "default" };
  }

  function toTyped(value: string, type: string): string | number | boolean | unknown {
    switch (type) {
      case "number":
        return Number(value);
      case "boolean":
        return value === "true" || value === "1";
      case "json":
        try { return JSON.parse(value); } catch { return value; }
      default:
        return value;
    }
  }

  /** Validate a setting value against its schema. Throws on invalid. */
  function validate(key: string, value: string): SettingDef {
    if (!SCHEMA_MAP.has(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }
    const def = SCHEMA_MAP.get(key)!;
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
    return def;
  }

  const store: SettingsStore = {
    async get(key: string): Promise<string> {
      return (await resolve(key)).value;
    },

    async getTyped(key: string): Promise<string | number | boolean | unknown> {
      const { value } = await resolve(key);
      const def = SCHEMA_MAP.get(key);
      return def ? toTyped(value, def.type) : value;
    },

    async set(key: string, value: string): Promise<void> {
      const def = validate(key, value);
      await pool.query(SQL.set, [key, value]);
      log.settings.debug({ key, value: def.sensitive ? "[REDACTED]" : value }, "set");
    },

    async delete(key: string): Promise<boolean> {
      const result = await pool.query(SQL.del, [key]);
      log.settings.debug({ key, deleted: (result.rowCount ?? 0) > 0 }, "delete");
      return (result.rowCount ?? 0) > 0;
    },

    async getAll(): Promise<SettingEntry[]> {
      const entries: SettingEntry[] = [];
      for (const def of SETTINGS_SCHEMA) {
        const { value, source } = await resolve(def.key);
        entries.push({
          key: def.key,
          value: def.sensitive ? "••••••••" : value,
          source,
          category: def.category,
          label: def.label,
          description: def.description,
          type: def.type,
          sensitive: def.sensitive ?? false,
        });
      }
      return entries;
    },

    async getByCategory(category: string): Promise<SettingEntry[]> {
      return (await store.getAll()).filter((e: SettingEntry) => e.category === category);
    },

    async exportUserValues(): Promise<Record<string, string>> {
      const result = await pool.query(SQL.all);
      const out: Record<string, string> = {};
      for (const row of result.rows) {
        const r = row as { key: string; value: string };
        out[r.key] = r.value;
      }
      return out;
    },

    async importValues(values: Record<string, string>): Promise<void> {
      // Validate all settings first (throws before any writes)
      const valid: Array<[string, string]> = [];
      for (const [key, value] of Object.entries(values)) {
        if (SCHEMA_MAP.has(key)) {
          validate(key, value);
          valid.push([key, value]);
        }
      }

      // Write in a transaction
      await withTransaction(pool, async (client) => {
        for (const [key, value] of valid) {
          await client.query(SQL.set, [key, value]);
        }
      });
    },

    close(): void {
      // Pool lifecycle managed externally
    },

    async countUserOverrides(): Promise<number> {
      const result = await pool.query(SQL.count);
      return Number((result.rows[0] as { count: string | number }).count);
    },
  };

  return store;
}

/**
 * Get the schema definition for a setting key.
 */
export function getSettingDef(key: string): SettingDef | undefined {
  return SCHEMA_MAP.get(key);
}

/**
 * Get all known categories.
 */
export function getCategories(): string[] {
  const cats = new Set(SETTINGS_SCHEMA.map((s) => s.category));
  return [...cats];
}
