/**
 * dock-store.ts — Drydock Loadout Data Layer (ADR-010 Phases 1 & 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * libSQL-backed intent catalog, drydock loadout management,
 * and crew preset system. Shares reference.db with reference-store
 * and overlay-store.
 *
 * Types & seed data: dock-types.ts
 * Briefing builder:  dock-briefing.ts
 *
 * Migrated from better-sqlite3 to @libsql/client in ADR-018 Phase 1.
 */

import { openDatabase, type Client } from "./db.js";
import { buildDockBriefing } from "./dock-briefing.js";
import { log } from "./logger.js";
import * as path from "node:path";

import type {
  Intent,
  IntentCategory,
  DockLoadout,
  DockShip,
  DockWithContext,
  CrewPreset,
  CrewPresetMember,
  CrewPresetWithMembers,
  OfficerConflict,
  DockBriefing,
} from "./dock-types.js";

import { VALID_INTENT_CATEGORIES, SEED_INTENTS } from "./dock-types.js";

// Re-export public API so consumers can keep importing from dock-store
export { VALID_INTENT_CATEGORIES } from "./dock-types.js";
export type {
  Intent,
  IntentCategory,
  DockLoadout,
  DockShip,
  DockWithContext,
  CrewPreset,
  CrewPresetMember,
  CrewPresetWithMembers,
  OfficerConflict,
  DockBriefing,
  DockStore,
};

// ─── Store Interface ────────────────────────────────────────

interface DockStore {
  listIntents(filters?: { category?: string }): Promise<Intent[]>;
  getIntent(key: string): Promise<Intent | null>;
  createIntent(intent: Pick<Intent, "key" | "label" | "category" | "description" | "icon">): Promise<Intent>;
  deleteIntent(key: string): Promise<boolean>;

  listDocks(): Promise<DockWithContext[]>;
  getDock(dockNumber: number): Promise<DockWithContext | null>;
  upsertDock(dockNumber: number, fields: { label?: string; notes?: string; priority?: number }): Promise<DockLoadout>;
  deleteDock(dockNumber: number): Promise<boolean>;
  nextDockNumber(): Promise<number>;

  setDockIntents(dockNumber: number, intentKeys: string[]): Promise<void>;
  getDockIntents(dockNumber: number): Promise<Intent[]>;

  addDockShip(dockNumber: number, shipId: string, options?: { notes?: string }): Promise<DockShip>;
  removeDockShip(dockNumber: number, shipId: string): Promise<boolean>;
  updateDockShip(dockNumber: number, shipId: string, fields: { isActive?: boolean; sortOrder?: number; notes?: string }): Promise<DockShip | null>;
  getDockShips(dockNumber: number): Promise<DockShip[]>;

  createPreset(fields: { shipId: string; intentKey: string; presetName: string; isDefault?: boolean }): Promise<CrewPresetWithMembers>;
  getPreset(id: number): Promise<CrewPresetWithMembers | null>;
  listPresets(filters?: { shipId?: string; intentKey?: string; tag?: string; officerId?: string }): Promise<CrewPresetWithMembers[]>;
  updatePreset(id: number, fields: { presetName?: string; isDefault?: boolean }): Promise<CrewPresetWithMembers | null>;
  deletePreset(id: number): Promise<boolean>;
  setPresetMembers(presetId: number, members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>): Promise<CrewPresetMember[]>;
  getOfficerConflicts(): Promise<OfficerConflict[]>;

  setPresetTags(presetId: number, tags: string[]): Promise<string[]>;
  listAllTags(): Promise<string[]>;
  findPresetsForDock(dockNumber: number): Promise<CrewPresetWithMembers[]>;

  previewDeleteDock(dockNumber: number): Promise<{ ships: { shipId: string; shipName: string }[]; intents: { key: string; label: string }[]; shipCount: number; intentCount: number }>;
  previewDeleteShip(shipId: string): Promise<{ dockAssignments: { dockNumber: number; dockLabel: string }[]; presets: { id: number; presetName: string; intentLabel: string }[] }>;
  previewDeleteOfficer(officerId: string): Promise<{ presetMemberships: { presetId: number; presetName: string; shipName: string; intentLabel: string }[] }>;

  buildBriefing(): Promise<DockBriefing>;

  getDbPath(): string;
  counts(): Promise<{ intents: number; docks: number; dockShips: number; presets: number; presetMembers: number; tags: number }>;
  close(): void;
}

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS intent_catalog (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    is_builtin INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS drydock_loadouts (
    dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
    label TEXT,
    notes TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dock_intents (
    dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
    intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
    PRIMARY KEY (dock_number, intent_key)
  )`,
  `CREATE TABLE IF NOT EXISTS dock_ships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    is_active INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(dock_number, ship_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dock_intents_key ON dock_intents(intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_dock_ships_ship ON dock_ships(ship_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dock_ships_dock ON dock_ships(dock_number)`,
  `CREATE TABLE IF NOT EXISTS crew_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
    preset_name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(ship_id, intent_key, preset_name)
  )`,
  `CREATE TABLE IF NOT EXISTS crew_preset_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id INTEGER NOT NULL REFERENCES crew_presets(id) ON DELETE CASCADE,
    officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
    role_type TEXT NOT NULL CHECK (role_type IN ('bridge', 'below_deck')),
    slot TEXT,
    UNIQUE(preset_id, officer_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crew_presets_ship ON crew_presets(ship_id)`,
  `CREATE INDEX IF NOT EXISTS idx_crew_presets_intent ON crew_presets(intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_crew_preset_members_officer ON crew_preset_members(officer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_crew_preset_members_preset ON crew_preset_members(preset_id)`,
  `CREATE TABLE IF NOT EXISTS preset_tags (
    preset_id INTEGER NOT NULL REFERENCES crew_presets(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (preset_id, tag)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_preset_tags_tag ON preset_tags(tag)`,
];

const INTENT_COLS = `key, label, category, description, icon, is_builtin AS isBuiltin, sort_order AS sortOrder, created_at AS createdAt`;
const DOCK_COLS = `dock_number AS dockNumber, label, notes, priority, created_at AS createdAt, updated_at AS updatedAt`;
const DOCK_SHIP_COLS = `ds.id, ds.dock_number AS dockNumber, ds.ship_id AS shipId, ds.is_active AS isActive, ds.sort_order AS sortOrder, ds.notes, ds.created_at AS createdAt, s.name AS shipName`;
const PRESET_COLS = `cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey, cp.preset_name AS presetName, cp.is_default AS isDefault, cp.created_at AS createdAt, cp.updated_at AS updatedAt, s.name AS shipName, ic.label AS intentLabel`;
const MEMBER_COLS = `cpm.id, cpm.preset_id AS presetId, cpm.officer_id AS officerId, cpm.role_type AS roleType, cpm.slot, o.name AS officerName`;

const SQL = {
  // Intents
  listIntents: `SELECT ${INTENT_COLS} FROM intent_catalog ORDER BY sort_order ASC, label ASC`,
  listIntentsByCategory: `SELECT ${INTENT_COLS} FROM intent_catalog WHERE category = ? ORDER BY sort_order ASC, label ASC`,
  getIntent: `SELECT ${INTENT_COLS} FROM intent_catalog WHERE key = ?`,
  insertIntent: `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
  deleteIntent: `DELETE FROM intent_catalog WHERE key = ? AND is_builtin = 0`,
  maxSortOrder: `SELECT MAX(sort_order) AS m FROM intent_catalog`,
  seedIntent: `INSERT OR IGNORE INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,

  // Docks
  listDocks: `SELECT ${DOCK_COLS} FROM drydock_loadouts ORDER BY dock_number ASC`,
  getDock: `SELECT ${DOCK_COLS} FROM drydock_loadouts WHERE dock_number = ?`,
  upsertDock: `INSERT INTO drydock_loadouts (dock_number, label, notes, priority, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(dock_number) DO UPDATE SET label = COALESCE(excluded.label, drydock_loadouts.label), notes = COALESCE(excluded.notes, drydock_loadouts.notes), priority = COALESCE(excluded.priority, drydock_loadouts.priority), updated_at = datetime('now')`,
  deleteDock: `DELETE FROM drydock_loadouts WHERE dock_number = ?`,
  nextDockNumber: `SELECT COALESCE(MAX(dock_number), 0) + 1 AS next FROM drydock_loadouts`,

  // Dock Intents
  clearDockIntents: `DELETE FROM dock_intents WHERE dock_number = ?`,
  insertDockIntent: `INSERT INTO dock_intents (dock_number, intent_key) VALUES (?, ?)`,
  getDockIntents: `SELECT ${INTENT_COLS} FROM dock_intents di JOIN intent_catalog ic ON di.intent_key = ic.key WHERE di.dock_number = ? ORDER BY ic.sort_order ASC`,

  // Dock Ships
  insertDockShip: `INSERT INTO dock_ships (dock_number, ship_id, is_active, sort_order, notes, created_at) VALUES (?, ?, 0, ?, ?, datetime('now'))`,
  deleteDockShip: `DELETE FROM dock_ships WHERE dock_number = ? AND ship_id = ?`,
  getDockShips: `SELECT ${DOCK_SHIP_COLS} FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = ? ORDER BY ds.sort_order ASC, s.name ASC`,
  getDockShip: `SELECT ${DOCK_SHIP_COLS} FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = ? AND ds.ship_id = ?`,
  maxDockShipSort: `SELECT MAX(sort_order) AS m FROM dock_ships WHERE dock_number = ?`,
  updateDockShipActive: `UPDATE dock_ships SET is_active = ? WHERE dock_number = ? AND ship_id = ?`,
  updateDockShipSort: `UPDATE dock_ships SET sort_order = ? WHERE dock_number = ? AND ship_id = ?`,
  updateDockShipNotes: `UPDATE dock_ships SET notes = ? WHERE dock_number = ? AND ship_id = ?`,
  clearDockShipActive: `UPDATE dock_ships SET is_active = 0 WHERE dock_number = ?`,

  // Crew Presets
  insertPreset: `INSERT INTO crew_presets (ship_id, intent_key, preset_name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  getPreset: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.id = ?`,
  listPresets: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  listPresetsByShip: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = ? ORDER BY ic.label ASC, cp.preset_name ASC`,
  listPresetsByIntent: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.intent_key = ? ORDER BY s.name ASC, cp.preset_name ASC`,
  listPresetsByShipAndIntent: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = ? AND cp.intent_key = ? ORDER BY cp.preset_name ASC`,
  listPresetsByTag: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key JOIN preset_tags pt ON cp.id = pt.preset_id WHERE pt.tag = ? ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  listPresetsByOfficer: `SELECT DISTINCT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key JOIN crew_preset_members cpm ON cp.id = cpm.preset_id WHERE cpm.officer_id = ? ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  updatePresetName: `UPDATE crew_presets SET preset_name = ?, updated_at = datetime('now') WHERE id = ?`,
  updatePresetDefault: `UPDATE crew_presets SET is_default = ?, updated_at = datetime('now') WHERE id = ?`,
  clearPresetDefaults: `UPDATE crew_presets SET is_default = 0, updated_at = datetime('now') WHERE ship_id = ? AND intent_key = ? AND id != ?`,
  deletePreset: `DELETE FROM crew_presets WHERE id = ?`,

  // Crew Preset Members
  clearPresetMembers: `DELETE FROM crew_preset_members WHERE preset_id = ?`,
  insertPresetMember: `INSERT INTO crew_preset_members (preset_id, officer_id, role_type, slot) VALUES (?, ?, ?, ?)`,
  getPresetMembers: `SELECT ${MEMBER_COLS} FROM crew_preset_members cpm JOIN reference_officers o ON cpm.officer_id = o.id WHERE cpm.preset_id = ? ORDER BY cpm.role_type ASC, cpm.slot ASC`,

  // Officer Conflicts
  officerConflicts: `SELECT cpm.officer_id AS officerId, o.name AS officerName, cp.id AS presetId, cp.preset_name AS presetName, cp.ship_id AS shipId, s.name AS shipName, cp.intent_key AS intentKey, ic.label AS intentLabel
    FROM crew_preset_members cpm JOIN reference_officers o ON cpm.officer_id = o.id JOIN crew_presets cp ON cpm.preset_id = cp.id JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key
    WHERE cpm.officer_id IN (SELECT officer_id FROM crew_preset_members GROUP BY officer_id HAVING COUNT(DISTINCT preset_id) > 1)
    ORDER BY o.name ASC, s.name ASC`,
  shipDockNumbers: `SELECT dock_number FROM dock_ships WHERE ship_id = ?`,

  // Tags
  getPresetTags: `SELECT tag FROM preset_tags WHERE preset_id = ? ORDER BY tag ASC`,
  clearPresetTags: `DELETE FROM preset_tags WHERE preset_id = ?`,
  insertPresetTag: `INSERT OR IGNORE INTO preset_tags (preset_id, tag) VALUES (?, ?)`,
  listAllTags: `SELECT DISTINCT tag FROM preset_tags ORDER BY tag ASC`,

  // Discovery
  findPresetsForDock: `SELECT DISTINCT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key
    WHERE cp.ship_id IN (SELECT ship_id FROM dock_ships WHERE dock_number = ?)
    AND cp.intent_key IN (SELECT intent_key FROM dock_intents WHERE dock_number = ?)
    ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,

  // Cascade Previews
  previewDeleteDock: `SELECT (SELECT COUNT(*) FROM dock_ships WHERE dock_number = ?) AS shipCount, (SELECT COUNT(*) FROM dock_intents WHERE dock_number = ?) AS intentCount`,
  previewDeleteDockShips: `SELECT ds.ship_id AS shipId, s.name AS shipName FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = ? ORDER BY s.name ASC`,
  previewDeleteDockIntents: `SELECT di.intent_key AS key, ic.label FROM dock_intents di JOIN intent_catalog ic ON di.intent_key = ic.key WHERE di.dock_number = ? ORDER BY ic.label ASC`,
  previewDeleteShipFromDocks: `SELECT ds.dock_number AS dockNumber, dl.label AS dockLabel FROM dock_ships ds JOIN drydock_loadouts dl ON ds.dock_number = dl.dock_number WHERE ds.ship_id = ? ORDER BY ds.dock_number ASC`,
  previewDeleteShipPresets: `SELECT cp.id, cp.preset_name AS presetName, ic.label AS intentLabel FROM crew_presets cp JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = ? ORDER BY cp.preset_name ASC`,
  previewDeleteOfficerFromPresets: `SELECT cp.id AS presetId, cp.preset_name AS presetName, s.name AS shipName, ic.label AS intentLabel
    FROM crew_preset_members cpm JOIN crew_presets cp ON cpm.preset_id = cp.id JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cpm.officer_id = ? ORDER BY cp.preset_name ASC`,

  // FK validation
  shipExists: `SELECT id FROM reference_ships WHERE id = ?`,
  officerExists: `SELECT id FROM reference_officers WHERE id = ?`,
  lastInsertRowid: `SELECT last_insert_rowid() AS id`,

  // Counts
  countIntents: `SELECT COUNT(*) AS count FROM intent_catalog`,
  countDocks: `SELECT COUNT(*) AS count FROM drydock_loadouts`,
  countDockShips: `SELECT COUNT(*) AS count FROM dock_ships`,
  countPresets: `SELECT COUNT(*) AS count FROM crew_presets`,
  countPresetMembers: `SELECT COUNT(*) AS count FROM crew_preset_members`,
  countTags: `SELECT COUNT(*) AS count FROM preset_tags`,
};

// ─── Helpers ────────────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "reference.db");

function fixBool<T extends Record<string, unknown>>(row: T, ...keys: string[]): T {
  const out = { ...row };
  for (const k of keys) {
    if (k in out) (out as Record<string, unknown>)[k] = Boolean(out[k]);
  }
  return out;
}

type Row = Record<string, unknown>;

// ─── Implementation ─────────────────────────────────────────

export async function createDockStore(dbPath?: string): Promise<DockStore> {
  const resolvedPath = dbPath || DB_FILE;
  const client = openDatabase(resolvedPath);

  // WAL + busy_timeout must run outside any transaction
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");

  // Schema init
  await client.batch(
    [
      { sql: "PRAGMA foreign_keys = ON", args: [] },
      ...SCHEMA_STATEMENTS.map((s) => ({ sql: s, args: [] as never[] })),
    ],
    "write",
  );

  // Seed builtin intents
  const seedBatch = SEED_INTENTS.map((i) => ({
    sql: SQL.seedIntent,
    args: [i.key, i.label, i.category, i.description, i.icon, i.sortOrder] as unknown[],
  }));
  await client.batch(seedBatch, "write");

  log.fleet.debug({ dbPath: resolvedPath }, "dock store initialized");

  // ── Preset Resolution Helper ──────────────────────────

  async function resolvePreset(row: Row | undefined): Promise<CrewPresetWithMembers | null> {
    if (!row) return null;
    const preset = fixBool(row as unknown as CrewPreset, "isDefault");
    const membersRes = await client.execute({ sql: SQL.getPresetMembers, args: [preset.id] });
    const members = membersRes.rows as unknown as CrewPresetMember[];
    const tagsRes = await client.execute({ sql: SQL.getPresetTags, args: [preset.id] });
    const tags = (tagsRes.rows as unknown as { tag: string }[]).map((r) => r.tag);
    return { ...preset, members, tags };
  }

  // ── Dock Context Helper ───────────────────────────────

  async function resolveDockContext(dock: DockLoadout): Promise<DockWithContext> {
    const intentsRes = await client.execute({ sql: SQL.getDockIntents, args: [dock.dockNumber] });
    const intents = (intentsRes.rows as unknown as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    const shipsRes = await client.execute({ sql: SQL.getDockShips, args: [dock.dockNumber] });
    const ships = (shipsRes.rows as unknown as DockShip[]).map((r) => fixBool(r, "isActive"));
    return { ...dock, intents, ships };
  }

  // ── Auto-create dock helper ───────────────────────────

  async function ensureDock(dockNumber: number, conn?: { execute: typeof client.execute }): Promise<void> {
    const db = conn ?? client;
    const res = await db.execute({ sql: SQL.getDock, args: [dockNumber] });
    if (res.rows.length === 0) {
      await db.execute({ sql: SQL.upsertDock, args: [dockNumber, null, null, 0] });
    }
  }

  const store: DockStore = {
    // ── Intents ─────────────────────────────────────────

    async listIntents(filters?) {
      const res = filters?.category
        ? await client.execute({ sql: SQL.listIntentsByCategory, args: [filters.category] })
        : await client.execute(SQL.listIntents);
      return (res.rows as unknown as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    },

    async getIntent(key) {
      const res = await client.execute({ sql: SQL.getIntent, args: [key] });
      const row = res.rows[0] as unknown as Intent | undefined;
      return row ? fixBool(row, "isBuiltin") : null;
    },

    async createIntent(intent) {
      if (!intent.key || !intent.label || !intent.category) throw new Error("Intent requires key, label, and category");
      if (!VALID_INTENT_CATEGORIES.includes(intent.category as IntentCategory)) {
        throw new Error(`Invalid category: ${intent.category}. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}`);
      }
      const maxRes = await client.execute(SQL.maxSortOrder);
      const maxSort = (maxRes.rows[0] as unknown as { m: number | null }).m || 0;
      await client.execute({
        sql: SQL.insertIntent,
        args: [intent.key, intent.label, intent.category, intent.description ?? null, intent.icon ?? null, Math.max(maxSort + 1, 100)],
      });
      return (await store.getIntent(intent.key))!;
    },

    async deleteIntent(key) {
      const res = await client.execute({ sql: SQL.deleteIntent, args: [key] });
      return res.rowsAffected > 0;
    },

    // ── Docks ───────────────────────────────────────────

    async listDocks() {
      const res = await client.execute(SQL.listDocks);
      const docks = res.rows as unknown as DockLoadout[];
      return Promise.all(docks.map(resolveDockContext));
    },

    async getDock(dockNumber) {
      const res = await client.execute({ sql: SQL.getDock, args: [dockNumber] });
      const dock = res.rows[0] as unknown as DockLoadout | undefined;
      return dock ? resolveDockContext(dock) : null;
    },

    async upsertDock(dockNumber, fields) {
      if (dockNumber < 1) throw new Error("Dock number must be a positive integer");
      await client.execute({ sql: SQL.upsertDock, args: [dockNumber, fields.label ?? null, fields.notes ?? null, fields.priority ?? 0] });
      const res = await client.execute({ sql: SQL.getDock, args: [dockNumber] });
      return res.rows[0] as unknown as DockLoadout;
    },

    async deleteDock(dockNumber) {
      const res = await client.execute({ sql: SQL.deleteDock, args: [dockNumber] });
      return res.rowsAffected > 0;
    },

    async nextDockNumber() {
      const res = await client.execute(SQL.nextDockNumber);
      return (res.rows[0] as unknown as { next: number }).next;
    },

    // ── Dock Intents ────────────────────────────────────

    async setDockIntents(dockNumber, intentKeys) {
      const tx = await client.transaction("write");
      try {
        await ensureDock(dockNumber, tx);
        for (const key of intentKeys) {
          const check = await tx.execute({ sql: SQL.getIntent, args: [key] });
          if (check.rows.length === 0) throw new Error(`Unknown intent key: ${key}`);
        }
        await tx.execute({ sql: SQL.clearDockIntents, args: [dockNumber] });
        for (const key of intentKeys) {
          await tx.execute({ sql: SQL.insertDockIntent, args: [dockNumber, key] });
        }
        await tx.commit();
      } catch (e) { await tx.rollback(); throw e; }
    },

    async getDockIntents(dockNumber) {
      const res = await client.execute({ sql: SQL.getDockIntents, args: [dockNumber] });
      return (res.rows as unknown as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    },

    // ── Dock Ships ──────────────────────────────────────

    async addDockShip(dockNumber, shipId, options?) {
      await ensureDock(dockNumber);
      const sortRes = await client.execute({ sql: SQL.maxDockShipSort, args: [dockNumber] });
      const maxSort = (sortRes.rows[0] as unknown as { m: number | null }).m ?? -1;
      try {
        await client.execute({ sql: SQL.insertDockShip, args: [dockNumber, shipId, maxSort + 1, options?.notes ?? null] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) throw new Error(`Ship ${shipId} is already assigned to dock ${dockNumber}`);
        if (msg.includes("FOREIGN KEY")) throw new Error(`Ship ${shipId} not found in reference catalog`);
        throw err;
      }
      const res = await client.execute({ sql: SQL.getDockShip, args: [dockNumber, shipId] });
      return fixBool(res.rows[0] as unknown as DockShip, "isActive");
    },

    async removeDockShip(dockNumber, shipId) {
      const res = await client.execute({ sql: SQL.deleteDockShip, args: [dockNumber, shipId] });
      return res.rowsAffected > 0;
    },

    async updateDockShip(dockNumber, shipId, fields) {
      const tx = await client.transaction("write");
      try {
        const existRes = await tx.execute({ sql: SQL.getDockShip, args: [dockNumber, shipId] });
        if (existRes.rows.length === 0) { await tx.commit(); return null; }

        if (fields.isActive !== undefined) {
          if (fields.isActive) await tx.execute({ sql: SQL.clearDockShipActive, args: [dockNumber] });
          await tx.execute({ sql: SQL.updateDockShipActive, args: [fields.isActive ? 1 : 0, dockNumber, shipId] });
        }
        if (fields.sortOrder !== undefined) {
          await tx.execute({ sql: SQL.updateDockShipSort, args: [fields.sortOrder, dockNumber, shipId] });
        }
        if (fields.notes !== undefined) {
          await tx.execute({ sql: SQL.updateDockShipNotes, args: [fields.notes, dockNumber, shipId] });
        }
        const finalRes = await tx.execute({ sql: SQL.getDockShip, args: [dockNumber, shipId] });
        await tx.commit();
        return fixBool(finalRes.rows[0] as unknown as DockShip, "isActive");
      } catch (e) { await tx.rollback(); throw e; }
    },

    async getDockShips(dockNumber) {
      const res = await client.execute({ sql: SQL.getDockShips, args: [dockNumber] });
      return (res.rows as unknown as DockShip[]).map((r) => fixBool(r, "isActive"));
    },

    // ── Crew Presets ────────────────────────────────────

    async createPreset(fields) {
      if (!fields.shipId || !fields.intentKey || !fields.presetName) throw new Error("Preset requires shipId, intentKey, and presetName");
      const shipCheck = await client.execute({ sql: SQL.shipExists, args: [fields.shipId] });
      if (shipCheck.rows.length === 0) throw new Error(`Ship ${fields.shipId} not found in reference catalog`);
      const intentCheck = await client.execute({ sql: SQL.getIntent, args: [fields.intentKey] });
      if (intentCheck.rows.length === 0) throw new Error(`Intent ${fields.intentKey} not found in catalog`);

      const isDefault = fields.isDefault ? 1 : 0;
      try {
        await client.execute({ sql: SQL.insertPreset, args: [fields.shipId, fields.intentKey, fields.presetName, isDefault] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) throw new Error(`Preset "${fields.presetName}" already exists for ${fields.shipId} + ${fields.intentKey}`);
        throw err;
      }
      const idRes = await client.execute(SQL.lastInsertRowid);
      const id = Number((idRes.rows[0] as unknown as { id: number | bigint }).id);

      if (isDefault) {
        await client.execute({ sql: SQL.clearPresetDefaults, args: [fields.shipId, fields.intentKey, id] });
      }

      const presetRes = await client.execute({ sql: SQL.getPreset, args: [id] });
      return (await resolvePreset(presetRes.rows[0] as unknown as Row))!;
    },

    async getPreset(id) {
      const res = await client.execute({ sql: SQL.getPreset, args: [id] });
      return resolvePreset(res.rows[0] as unknown as Row | undefined);
    },

    async listPresets(filters?) {
      let res;
      if (filters?.tag) {
        res = await client.execute({ sql: SQL.listPresetsByTag, args: [filters.tag] });
      } else if (filters?.officerId) {
        res = await client.execute({ sql: SQL.listPresetsByOfficer, args: [filters.officerId] });
      } else if (filters?.shipId && filters?.intentKey) {
        res = await client.execute({ sql: SQL.listPresetsByShipAndIntent, args: [filters.shipId, filters.intentKey] });
      } else if (filters?.shipId) {
        res = await client.execute({ sql: SQL.listPresetsByShip, args: [filters.shipId] });
      } else if (filters?.intentKey) {
        res = await client.execute({ sql: SQL.listPresetsByIntent, args: [filters.intentKey] });
      } else {
        res = await client.execute(SQL.listPresets);
      }
      const presets = await Promise.all(
        (res.rows as unknown as Row[]).map((r) => resolvePreset(r)),
      );
      return presets.filter(Boolean) as CrewPresetWithMembers[];
    },

    async updatePreset(id, fields) {
      const existRes = await client.execute({ sql: SQL.getPreset, args: [id] });
      const existing = existRes.rows[0] as unknown as CrewPreset | undefined;
      if (!existing) return null;

      if (fields.presetName !== undefined) {
        await client.execute({ sql: SQL.updatePresetName, args: [fields.presetName, id] });
      }
      if (fields.isDefault !== undefined) {
        await client.execute({ sql: SQL.updatePresetDefault, args: [fields.isDefault ? 1 : 0, id] });
        if (fields.isDefault) {
          await client.execute({ sql: SQL.clearPresetDefaults, args: [existing.shipId, existing.intentKey, id] });
        }
      }
      const presetRes = await client.execute({ sql: SQL.getPreset, args: [id] });
      return resolvePreset(presetRes.rows[0] as unknown as Row);
    },

    async deletePreset(id) {
      const res = await client.execute({ sql: SQL.deletePreset, args: [id] });
      return res.rowsAffected > 0;
    },

    async setPresetMembers(presetId, members) {
      const tx = await client.transaction("write");
      try {
        const presetCheck = await tx.execute({ sql: SQL.getPreset, args: [presetId] });
        if (presetCheck.rows.length === 0) throw new Error(`Preset ${presetId} not found`);

        for (const m of members) {
          const offCheck = await tx.execute({ sql: SQL.officerExists, args: [m.officerId] });
          if (offCheck.rows.length === 0) throw new Error(`Officer ${m.officerId} not found in reference catalog`);
          if (m.roleType !== "bridge" && m.roleType !== "below_deck") throw new Error(`Invalid roleType: ${m.roleType}`);
        }

        await tx.execute({ sql: SQL.clearPresetMembers, args: [presetId] });
        for (const m of members) {
          await tx.execute({ sql: SQL.insertPresetMember, args: [presetId, m.officerId, m.roleType, m.slot ?? null] });
        }
        await tx.commit();
      } catch (e) { await tx.rollback(); throw e; }

      const res = await client.execute({ sql: SQL.getPresetMembers, args: [presetId] });
      return res.rows as unknown as CrewPresetMember[];
    },

    // ── Officer Conflicts ───────────────────────────────

    async getOfficerConflicts() {
      const res = await client.execute(SQL.officerConflicts);
      const rows = res.rows as unknown as Array<{
        officerId: string; officerName: string; presetId: number; presetName: string;
        shipId: string; shipName: string; intentKey: string; intentLabel: string;
      }>;

      const byOfficer = new Map<string, OfficerConflict>();
      for (const row of rows) {
        let conflict = byOfficer.get(row.officerId);
        if (!conflict) {
          conflict = { officerId: row.officerId, officerName: row.officerName, appearances: [] };
          byOfficer.set(row.officerId, conflict);
        }
        const dockRes = await client.execute({ sql: SQL.shipDockNumbers, args: [row.shipId] });
        const dockNumbers = (dockRes.rows as unknown as { dock_number: number }[]).map((d) => d.dock_number);
        conflict.appearances.push({
          presetId: row.presetId, presetName: row.presetName,
          shipId: row.shipId, shipName: row.shipName,
          intentKey: row.intentKey, intentLabel: row.intentLabel,
          dockNumbers,
        });
      }
      return Array.from(byOfficer.values());
    },

    // ── Tags & Discovery ────────────────────────────────

    async setPresetTags(presetId, tags) {
      const tx = await client.transaction("write");
      try {
        const check = await tx.execute({ sql: SQL.getPreset, args: [presetId] });
        if (check.rows.length === 0) throw new Error(`Preset ${presetId} not found`);
        await tx.execute({ sql: SQL.clearPresetTags, args: [presetId] });
        for (const tag of tags) {
          const normalized = tag.trim().toLowerCase();
          if (normalized) await tx.execute({ sql: SQL.insertPresetTag, args: [presetId, normalized] });
        }
        await tx.commit();
      } catch (e) { await tx.rollback(); throw e; }

      const res = await client.execute({ sql: SQL.getPresetTags, args: [presetId] });
      return (res.rows as unknown as { tag: string }[]).map((r) => r.tag);
    },

    async listAllTags() {
      const res = await client.execute(SQL.listAllTags);
      return (res.rows as unknown as { tag: string }[]).map((r) => r.tag);
    },

    async findPresetsForDock(dockNumber) {
      const res = await client.execute({ sql: SQL.findPresetsForDock, args: [dockNumber, dockNumber] });
      const presets = await Promise.all(
        (res.rows as unknown as Row[]).map((r) => resolvePreset(r)),
      );
      return presets.filter(Boolean) as CrewPresetWithMembers[];
    },

    // ── Cascade Previews ────────────────────────────────

    async previewDeleteDock(dockNumber) {
      const countsRes = await client.execute({ sql: SQL.previewDeleteDock, args: [dockNumber, dockNumber] });
      const counts = countsRes.rows[0] as unknown as { shipCount: number; intentCount: number };
      const shipsRes = await client.execute({ sql: SQL.previewDeleteDockShips, args: [dockNumber] });
      const intentsRes = await client.execute({ sql: SQL.previewDeleteDockIntents, args: [dockNumber] });
      return {
        ships: shipsRes.rows as unknown as { shipId: string; shipName: string }[],
        intents: intentsRes.rows as unknown as { key: string; label: string }[],
        shipCount: counts.shipCount,
        intentCount: counts.intentCount,
      };
    },

    async previewDeleteShip(shipId) {
      const dockRes = await client.execute({ sql: SQL.previewDeleteShipFromDocks, args: [shipId] });
      const presetRes = await client.execute({ sql: SQL.previewDeleteShipPresets, args: [shipId] });
      return {
        dockAssignments: dockRes.rows as unknown as { dockNumber: number; dockLabel: string }[],
        presets: presetRes.rows as unknown as { id: number; presetName: string; intentLabel: string }[],
      };
    },

    async previewDeleteOfficer(officerId) {
      const res = await client.execute({ sql: SQL.previewDeleteOfficerFromPresets, args: [officerId] });
      return {
        presetMemberships: res.rows as unknown as { presetId: number; presetName: string; shipName: string; intentLabel: string }[],
      };
    },

    // ── Briefing ────────────────────────────────────────

    async buildBriefing() {
      const docks = await store.listDocks();
      const conflicts = await store.getOfficerConflicts();
      // Sync wrapper around the async listPresets (briefing builder expects sync for now)
      // For the briefing we pre-fetch all presets and filter locally
      const allPresetsRes = await client.execute(SQL.listPresets);
      const allPresetRows = allPresetsRes.rows as unknown as Row[];
      const allPresets: CrewPresetWithMembers[] = [];
      for (const row of allPresetRows) {
        const p = await resolvePreset(row);
        if (p) allPresets.push(p);
      }

      return buildDockBriefing(docks, conflicts, (filters) => {
        return allPresets.filter((p) => p.shipId === filters.shipId);
      });
    },

    // ── Diagnostics ─────────────────────────────────────

    getDbPath: () => resolvedPath,

    async counts() {
      const [i, d, ds, p, pm, t] = await Promise.all([
        client.execute(SQL.countIntents),
        client.execute(SQL.countDocks),
        client.execute(SQL.countDockShips),
        client.execute(SQL.countPresets),
        client.execute(SQL.countPresetMembers),
        client.execute(SQL.countTags),
      ]);
      const c = (r: { rows: unknown[] }) => (r.rows[0] as { count: number }).count;
      return { intents: c(i), docks: c(d), dockShips: c(ds), presets: c(p), presetMembers: c(pm), tags: c(t) };
    },

    close: () => client.close(),
  };

  return store;
}
