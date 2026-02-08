/**
 * settings.ts — User Settings Store
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed key/value store for user-configurable settings.
 * Lives alongside Lex memory in .smartergpt/lex/settings.db.
 *
 * Priority chain for runtime config:
 *   1. User setting (this store)  ← highest
 *   2. Environment variable
 *   3. Schema default             ← lowest
 *
 * Settings are typed, validated, and have defaults. The UI can
 * read/write them via /api/settings endpoints.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { debug } from "./debug.js";

// ─── Schema ─────────────────────────────────────────────────────

/**
 * All known setting keys with their metadata.
 * Adding a new setting = add it here. Everything else flows from this.
 */
export interface SettingDef {
  key: string;
  category: "sheets" | "display" | "model" | "system";
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "json";
  default: string;
  /** If set, this env var provides the fallback before the default. */
  envVar?: string;
  /** If true, the value is masked in API responses (e.g. future API keys). */
  sensitive?: boolean;
}

export const SETTINGS_SCHEMA: SettingDef[] = [
  // ── Sheets ──────────────────────────────────────────────────
  {
    key: "sheets.spreadsheetId",
    category: "sheets",
    label: "Spreadsheet ID",
    description: "Google Sheets spreadsheet ID for fleet data.",
    type: "string",
    default: "",
    envVar: "MAJEL_SPREADSHEET_ID",
  },
  {
    key: "sheets.tabMapping",
    category: "sheets",
    label: "Tab Mapping",
    description:
      'Maps sheet tab names to data types. Format: "TabName:type,Tab2:type2". Types: officers, ships, custom.',
    type: "string",
    default: "",
    envVar: "MAJEL_TAB_MAPPING",
  },
  {
    key: "sheets.range",
    category: "sheets",
    label: "Sheet Range (legacy)",
    description: "Cell range for legacy single-tab fetch.",
    type: "string",
    default: "Sheet1!A1:Z1000",
    envVar: "MAJEL_SHEET_RANGE",
  },

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
    key: "model.name",
    category: "model",
    label: "Model Name",
    description: "Gemini model identifier.",
    type: "string",
    default: "gemini-2.5-flash-lite",
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
];

/** Lookup map for fast access. */
const SCHEMA_MAP = new Map<string, SettingDef>(
  SETTINGS_SCHEMA.map((s) => [s.key, s])
);

// ─── Settings Store ─────────────────────────────────────────────

export interface SettingsStore {
  /** Get a single setting's resolved value (user → env → default). */
  get(key: string): string;

  /** Get a setting parsed to its native type. */
  getTyped(key: string): string | number | boolean | unknown;

  /** Set a user-level setting. */
  set(key: string, value: string): void;

  /** Delete a user-level setting (reverts to env/default). */
  delete(key: string): boolean;

  /** Get all settings with their resolved values and metadata. */
  getAll(): SettingEntry[];

  /** Get all settings in a specific category. */
  getByCategory(category: string): SettingEntry[];

  /** Export all user-set values as a flat object. */
  exportUserValues(): Record<string, string>;

  /** Import multiple settings at once. */
  importValues(values: Record<string, string>): void;

  /** Close the database. */
  close(): void;
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

/**
 * Resolve the default DB path: .smartergpt/lex/settings.db
 * Colocated with Lex memory, git-ignored via .smartergpt/
 */
function defaultDbPath(): string {
  const dir = path.resolve(".smartergpt", "lex");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "settings.db");
}

/**
 * Create a settings store backed by SQLite.
 */
export function createSettingsStore(dbPath?: string): SettingsStore {
  const resolvedPath = dbPath ?? defaultDbPath();
  const db = new Database(resolvedPath);

  // WAL mode for concurrent reads during server operation
  db.pragma("journal_mode = WAL");

  // Create table if needed
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const stmtGet = db.prepare("SELECT value FROM settings WHERE key = ?");
  const stmtSet = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  const stmtDel = db.prepare("DELETE FROM settings WHERE key = ?");
  const stmtAll = db.prepare("SELECT key, value FROM settings");

  /**
   * Resolve a setting: user DB → env var → schema default.
   */
  function resolve(key: string): { value: string; source: "user" | "env" | "default" } {
    // 1. User setting (DB)
    const row = stmtGet.get(key) as { value: string } | undefined;
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

  return {
    get(key: string): string {
      return resolve(key).value;
    },

    getTyped(key: string): string | number | boolean | unknown {
      const { value } = resolve(key);
      const def = SCHEMA_MAP.get(key);
      return def ? toTyped(value, def.type) : value;
    },

    set(key: string, value: string): void {
      // Validate key exists in schema
      if (!SCHEMA_MAP.has(key)) {
        throw new Error(`Unknown setting: ${key}`);
      }

      // Basic type validation
      const def = SCHEMA_MAP.get(key)!;
      if (def.type === "number" && isNaN(Number(value))) {
        throw new Error(`Setting ${key} must be a number, got: ${value}`);
      }
      if (def.type === "boolean" && !["true", "false", "1", "0"].includes(value)) {
        throw new Error(`Setting ${key} must be a boolean, got: ${value}`);
      }

      stmtSet.run(key, value);
      debug.settings("set", { key, value: def.sensitive ? "[REDACTED]" : value });
    },

    delete(key: string): boolean {
      const result = stmtDel.run(key);
      debug.settings("delete", { key, deleted: result.changes > 0 });
      return result.changes > 0;
    },

    getAll(): SettingEntry[] {
      return SETTINGS_SCHEMA.map((def) => {
        const { value, source } = resolve(def.key);
        return {
          key: def.key,
          value: def.sensitive ? "••••••••" : value,
          source,
          category: def.category,
          label: def.label,
          description: def.description,
          type: def.type,
          sensitive: def.sensitive ?? false,
        };
      });
    },

    getByCategory(category: string): SettingEntry[] {
      return this.getAll().filter((e) => e.category === category);
    },

    exportUserValues(): Record<string, string> {
      const rows = stmtAll.all() as Array<{ key: string; value: string }>;
      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    },

    importValues(values: Record<string, string>): void {
      const tx = db.transaction(() => {
        for (const [key, value] of Object.entries(values)) {
          if (SCHEMA_MAP.has(key)) {
            this.set(key, value);
          }
        }
      });
      tx();
    },

    close(): void {
      db.close();
    },
  };
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
