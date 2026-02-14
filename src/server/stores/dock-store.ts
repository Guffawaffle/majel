/**
 * dock-store.ts — Drydock Loadout Data Layer (ADR-010 Phases 1 & 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * PostgreSQL-backed intent catalog, drydock loadout management,
 * and crew preset system. Shares the PostgreSQL database with
 * reference-store and overlay-store.
 *
 * Types & seed data: dock-types.ts
 * Briefing builder:  dock-briefing.ts
 *
 * Migrated from @libsql/client to pg (PostgreSQL) in ADR-018 Phase 3.
 */

import { initSchema, withTransaction, type Pool, type PoolClient } from "../db.js";
import { buildDockBriefing } from "../services/dock-briefing.js";
import { log } from "../logger.js";

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
} from "../types/dock-types.js";

import { VALID_INTENT_CATEGORIES, SEED_INTENTS } from "../types/dock-types.js";

// Re-export public API so consumers can keep importing from dock-store
export { VALID_INTENT_CATEGORIES } from "../types/dock-types.js";
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
    is_builtin BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS drydock_loadouts (
    dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
    label TEXT,
    notes TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dock_intents (
    dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
    intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
    PRIMARY KEY (dock_number, intent_key)
  )`,
  `CREATE TABLE IF NOT EXISTS dock_ships (
    id SERIAL PRIMARY KEY,
    dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(dock_number, ship_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dock_intents_key ON dock_intents(intent_key)`,
  `CREATE INDEX IF NOT EXISTS idx_dock_ships_ship ON dock_ships(ship_id)`,
  `CREATE INDEX IF NOT EXISTS idx_dock_ships_dock ON dock_ships(dock_number)`,
  `CREATE TABLE IF NOT EXISTS crew_presets (
    id SERIAL PRIMARY KEY,
    ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
    intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
    preset_name TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(ship_id, intent_key, preset_name)
  )`,
  `CREATE TABLE IF NOT EXISTS crew_preset_members (
    id SERIAL PRIMARY KEY,
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

const INTENT_COLS = `key, label, category, description, icon, is_builtin AS "isBuiltin", sort_order AS "sortOrder", created_at AS "createdAt"`;
const DOCK_COLS = `dock_number AS "dockNumber", label, notes, priority, created_at AS "createdAt", updated_at AS "updatedAt"`;
const DOCK_SHIP_COLS = `ds.id, ds.dock_number AS "dockNumber", ds.ship_id AS "shipId", ds.is_active AS "isActive", ds.sort_order AS "sortOrder", ds.notes, ds.created_at AS "createdAt", s.name AS "shipName"`;
const PRESET_COLS = `cp.id, cp.ship_id AS "shipId", cp.intent_key AS "intentKey", cp.preset_name AS "presetName", cp.is_default AS "isDefault", cp.created_at AS "createdAt", cp.updated_at AS "updatedAt", s.name AS "shipName", ic.label AS "intentLabel"`;
const MEMBER_COLS = `cpm.id, cpm.preset_id AS "presetId", cpm.officer_id AS "officerId", cpm.role_type AS "roleType", cpm.slot, o.name AS "officerName"`;

const SQL = {
  // Intents
  listIntents: `SELECT ${INTENT_COLS} FROM intent_catalog ORDER BY sort_order ASC, label ASC`,
  listIntentsByCategory: `SELECT ${INTENT_COLS} FROM intent_catalog WHERE category = $1 ORDER BY sort_order ASC, label ASC`,
  getIntent: `SELECT ${INTENT_COLS} FROM intent_catalog WHERE key = $1`,
  insertIntent: `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, FALSE, $6, NOW())`,
  deleteIntent: `DELETE FROM intent_catalog WHERE key = $1 AND is_builtin = FALSE`,
  maxSortOrder: `SELECT MAX(sort_order) AS m FROM intent_catalog`,
  seedIntent: `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW()) ON CONFLICT DO NOTHING`,

  // Docks
  listDocks: `SELECT ${DOCK_COLS} FROM drydock_loadouts ORDER BY dock_number ASC`,
  getDock: `SELECT ${DOCK_COLS} FROM drydock_loadouts WHERE dock_number = $1`,
  upsertDock: `INSERT INTO drydock_loadouts (dock_number, label, notes, priority, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT(dock_number) DO UPDATE SET label = COALESCE(excluded.label, drydock_loadouts.label), notes = COALESCE(excluded.notes, drydock_loadouts.notes), priority = COALESCE(excluded.priority, drydock_loadouts.priority), updated_at = NOW()`,
  deleteDock: `DELETE FROM drydock_loadouts WHERE dock_number = $1`,
  nextDockNumber: `SELECT COALESCE(MAX(dock_number), 0) + 1 AS next FROM drydock_loadouts`,

  // Dock Intents
  clearDockIntents: `DELETE FROM dock_intents WHERE dock_number = $1`,
  insertDockIntent: `INSERT INTO dock_intents (dock_number, intent_key) VALUES ($1, $2)`,
  getDockIntents: `SELECT ${INTENT_COLS} FROM dock_intents di JOIN intent_catalog ic ON di.intent_key = ic.key WHERE di.dock_number = $1 ORDER BY ic.sort_order ASC`,

  // Dock Ships
  insertDockShip: `INSERT INTO dock_ships (dock_number, ship_id, is_active, sort_order, notes, created_at) VALUES ($1, $2, FALSE, $3, $4, NOW())`,
  deleteDockShip: `DELETE FROM dock_ships WHERE dock_number = $1 AND ship_id = $2`,
  getDockShips: `SELECT ${DOCK_SHIP_COLS} FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = $1 ORDER BY ds.sort_order ASC, s.name ASC`,
  getDockShip: `SELECT ${DOCK_SHIP_COLS} FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = $1 AND ds.ship_id = $2`,
  maxDockShipSort: `SELECT MAX(sort_order) AS m FROM dock_ships WHERE dock_number = $1`,
  updateDockShipActive: `UPDATE dock_ships SET is_active = $1 WHERE dock_number = $2 AND ship_id = $3`,
  updateDockShipSort: `UPDATE dock_ships SET sort_order = $1 WHERE dock_number = $2 AND ship_id = $3`,
  updateDockShipNotes: `UPDATE dock_ships SET notes = $1 WHERE dock_number = $2 AND ship_id = $3`,
  clearDockShipActive: `UPDATE dock_ships SET is_active = FALSE WHERE dock_number = $1`,

  // Crew Presets
  insertPreset: `INSERT INTO crew_presets (ship_id, intent_key, preset_name, is_default, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
  getPreset: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.id = $1`,
  listPresets: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  listPresetsByShip: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = $1 ORDER BY ic.label ASC, cp.preset_name ASC`,
  listPresetsByIntent: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.intent_key = $1 ORDER BY s.name ASC, cp.preset_name ASC`,
  listPresetsByShipAndIntent: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = $1 AND cp.intent_key = $2 ORDER BY cp.preset_name ASC`,
  listPresetsByTag: `SELECT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key JOIN preset_tags pt ON cp.id = pt.preset_id WHERE pt.tag = $1 ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  listPresetsByOfficer: `SELECT DISTINCT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key JOIN crew_preset_members cpm ON cp.id = cpm.preset_id WHERE cpm.officer_id = $1 ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
  updatePresetName: `UPDATE crew_presets SET preset_name = $1, updated_at = NOW() WHERE id = $2`,
  updatePresetDefault: `UPDATE crew_presets SET is_default = $1, updated_at = NOW() WHERE id = $2`,
  clearPresetDefaults: `UPDATE crew_presets SET is_default = FALSE, updated_at = NOW() WHERE ship_id = $1 AND intent_key = $2 AND id != $3`,
  deletePreset: `DELETE FROM crew_presets WHERE id = $1`,

  // Crew Preset Members
  clearPresetMembers: `DELETE FROM crew_preset_members WHERE preset_id = $1`,
  insertPresetMember: `INSERT INTO crew_preset_members (preset_id, officer_id, role_type, slot) VALUES ($1, $2, $3, $4)`,
  getPresetMembers: `SELECT ${MEMBER_COLS} FROM crew_preset_members cpm JOIN reference_officers o ON cpm.officer_id = o.id WHERE cpm.preset_id = $1 ORDER BY cpm.role_type ASC, cpm.slot ASC`,

  // Officer Conflicts
  officerConflicts: `SELECT cpm.officer_id AS "officerId", o.name AS "officerName", cp.id AS "presetId", cp.preset_name AS "presetName", cp.ship_id AS "shipId", s.name AS "shipName", cp.intent_key AS "intentKey", ic.label AS "intentLabel"
    FROM crew_preset_members cpm JOIN reference_officers o ON cpm.officer_id = o.id JOIN crew_presets cp ON cpm.preset_id = cp.id JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key
    WHERE cpm.officer_id IN (SELECT officer_id FROM crew_preset_members GROUP BY officer_id HAVING COUNT(DISTINCT preset_id) > 1)
    ORDER BY o.name ASC, s.name ASC`,
  shipDockNumbers: `SELECT dock_number FROM dock_ships WHERE ship_id = $1`,

  // Tags
  getPresetTags: `SELECT tag FROM preset_tags WHERE preset_id = $1 ORDER BY tag ASC`,
  clearPresetTags: `DELETE FROM preset_tags WHERE preset_id = $1`,
  insertPresetTag: `INSERT INTO preset_tags (preset_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  listAllTags: `SELECT DISTINCT tag FROM preset_tags ORDER BY tag ASC`,

  // Discovery
  findPresetsForDock: `SELECT DISTINCT ${PRESET_COLS} FROM crew_presets cp JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key
    WHERE cp.ship_id IN (SELECT ship_id FROM dock_ships WHERE dock_number = $1)
    AND cp.intent_key IN (SELECT intent_key FROM dock_intents WHERE dock_number = $1)
    ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,

  // Cascade Previews
  previewDeleteDock: `SELECT (SELECT COUNT(*) FROM dock_ships WHERE dock_number = $1) AS "shipCount", (SELECT COUNT(*) FROM dock_intents WHERE dock_number = $1) AS "intentCount"`,
  previewDeleteDockShips: `SELECT ds.ship_id AS "shipId", s.name AS "shipName" FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id WHERE ds.dock_number = $1 ORDER BY s.name ASC`,
  previewDeleteDockIntents: `SELECT di.intent_key AS key, ic.label FROM dock_intents di JOIN intent_catalog ic ON di.intent_key = ic.key WHERE di.dock_number = $1 ORDER BY ic.label ASC`,
  previewDeleteShipFromDocks: `SELECT ds.dock_number AS "dockNumber", dl.label AS "dockLabel" FROM dock_ships ds JOIN drydock_loadouts dl ON ds.dock_number = dl.dock_number WHERE ds.ship_id = $1 ORDER BY ds.dock_number ASC`,
  previewDeleteShipPresets: `SELECT cp.id, cp.preset_name AS "presetName", ic.label AS "intentLabel" FROM crew_presets cp JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cp.ship_id = $1 ORDER BY cp.preset_name ASC`,
  previewDeleteOfficerFromPresets: `SELECT cp.id AS "presetId", cp.preset_name AS "presetName", s.name AS "shipName", ic.label AS "intentLabel"
    FROM crew_preset_members cpm JOIN crew_presets cp ON cpm.preset_id = cp.id JOIN reference_ships s ON cp.ship_id = s.id JOIN intent_catalog ic ON cp.intent_key = ic.key WHERE cpm.officer_id = $1 ORDER BY cp.preset_name ASC`,

  // FK validation
  shipExists: `SELECT id FROM reference_ships WHERE id = $1`,
  officerExists: `SELECT id FROM reference_officers WHERE id = $1`,

  // Counts
  countIntents: `SELECT COUNT(*) AS count FROM intent_catalog`,
  countDocks: `SELECT COUNT(*) AS count FROM drydock_loadouts`,
  countDockShips: `SELECT COUNT(*) AS count FROM dock_ships`,
  countPresets: `SELECT COUNT(*) AS count FROM crew_presets`,
  countPresetMembers: `SELECT COUNT(*) AS count FROM crew_preset_members`,
  countTags: `SELECT COUNT(*) AS count FROM preset_tags`,
};

// ─── Helpers ────────────────────────────────────────────────

function fixBool<T extends object>(row: T, ...keys: string[]): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of keys) {
    if (k in out) out[k] = Boolean(out[k]);
  }
  return out as unknown as T;
}

// pg rows are untyped at runtime; Record<string, any> allows safe casts to interfaces
type Row = Record<string, any>;

// ─── Implementation ─────────────────────────────────────────

export async function createDockStore(pool: Pool): Promise<DockStore> {
  // Schema init
  await initSchema(pool, SCHEMA_STATEMENTS);

  // Seed builtin intents
  await withTransaction(pool, async (client) => {
    for (const i of SEED_INTENTS) {
      await client.query(SQL.seedIntent, [i.key, i.label, i.category, i.description, i.icon, i.sortOrder]);
    }
  });

  log.fleet.debug("dock store initialized");

  // ── Preset Resolution Helper ──────────────────────────

  async function resolvePreset(row: Row | undefined): Promise<CrewPresetWithMembers | null> {
    if (!row) return null;
    const preset = fixBool(row as CrewPreset, "isDefault");
    const membersRes = await pool.query(SQL.getPresetMembers, [preset.id]);
    const members = membersRes.rows as CrewPresetMember[];
    const tagsRes = await pool.query(SQL.getPresetTags, [preset.id]);
    const tags = (tagsRes.rows as { tag: string }[]).map((r) => r.tag);
    return { ...preset, members, tags };
  }

  // ── Dock Context Helper ───────────────────────────────

  async function resolveDockContext(dock: DockLoadout): Promise<DockWithContext> {
    const intentsRes = await pool.query(SQL.getDockIntents, [dock.dockNumber]);
    const intents = (intentsRes.rows as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    const shipsRes = await pool.query(SQL.getDockShips, [dock.dockNumber]);
    const ships = (shipsRes.rows as DockShip[]).map((r) => fixBool(r, "isActive"));
    return { ...dock, intents, ships };
  }

  // ── Auto-create dock helper ───────────────────────────

  async function ensureDock(dockNumber: number, conn?: { query: typeof pool.query }): Promise<void> {
    const db = conn ?? pool;
    const res = await db.query(SQL.getDock, [dockNumber]);
    if (res.rows.length === 0) {
      await db.query(SQL.upsertDock, [dockNumber, null, null, 0]);
    }
  }

  const store: DockStore = {
    // ── Intents ─────────────────────────────────────────

    async listIntents(filters?) {
      const res = filters?.category
        ? await pool.query(SQL.listIntentsByCategory, [filters.category])
        : await pool.query(SQL.listIntents);
      return (res.rows as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    },

    async getIntent(key) {
      const res = await pool.query(SQL.getIntent, [key]);
      const row = res.rows[0] as Intent | undefined;
      return row ? fixBool(row, "isBuiltin") : null;
    },

    async createIntent(intent) {
      if (!intent.key || !intent.label || !intent.category) throw new Error("Intent requires key, label, and category");
      if (!VALID_INTENT_CATEGORIES.includes(intent.category as IntentCategory)) {
        throw new Error(`Invalid category: ${intent.category}. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}`);
      }
      const maxRes = await pool.query(SQL.maxSortOrder);
      const maxSort = (maxRes.rows[0] as { m: number | null }).m || 0;
      await pool.query(SQL.insertIntent, [intent.key, intent.label, intent.category, intent.description ?? null, intent.icon ?? null, Math.max(maxSort + 1, 100)]);
      return (await store.getIntent(intent.key))!;
    },

    async deleteIntent(key) {
      const res = await pool.query(SQL.deleteIntent, [key]);
      return (res.rowCount ?? 0) > 0;
    },

    // ── Docks ───────────────────────────────────────────

    async listDocks() {
      const res = await pool.query(SQL.listDocks);
      const docks = res.rows as DockLoadout[];
      return Promise.all(docks.map(resolveDockContext));
    },

    async getDock(dockNumber) {
      const res = await pool.query(SQL.getDock, [dockNumber]);
      const dock = res.rows[0] as DockLoadout | undefined;
      return dock ? resolveDockContext(dock) : null;
    },

    async upsertDock(dockNumber, fields) {
      if (dockNumber < 1) throw new Error("Dock number must be a positive integer");
      await pool.query(SQL.upsertDock, [dockNumber, fields.label ?? null, fields.notes ?? null, fields.priority ?? 0]);
      const res = await pool.query(SQL.getDock, [dockNumber]);
      return res.rows[0] as DockLoadout;
    },

    async deleteDock(dockNumber) {
      const res = await pool.query(SQL.deleteDock, [dockNumber]);
      return (res.rowCount ?? 0) > 0;
    },

    async nextDockNumber() {
      const res = await pool.query(SQL.nextDockNumber);
      return (res.rows[0] as { next: number }).next;
    },

    // ── Dock Intents ────────────────────────────────────

    async setDockIntents(dockNumber, intentKeys) {
      await withTransaction(pool, async (client) => {
        await ensureDock(dockNumber, client);
        for (const key of intentKeys) {
          const check = await client.query(SQL.getIntent, [key]);
          if (check.rows.length === 0) throw new Error(`Unknown intent key: ${key}`);
        }
        await client.query(SQL.clearDockIntents, [dockNumber]);
        for (const key of intentKeys) {
          await client.query(SQL.insertDockIntent, [dockNumber, key]);
        }
      });
    },

    async getDockIntents(dockNumber) {
      const res = await pool.query(SQL.getDockIntents, [dockNumber]);
      return (res.rows as Intent[]).map((r) => fixBool(r, "isBuiltin"));
    },

    // ── Dock Ships ──────────────────────────────────────

    async addDockShip(dockNumber, shipId, options?) {
      await ensureDock(dockNumber);
      const sortRes = await pool.query(SQL.maxDockShipSort, [dockNumber]);
      const maxSort = (sortRes.rows[0] as { m: number | null }).m ?? -1;
      try {
        await pool.query(SQL.insertDockShip, [dockNumber, shipId, maxSort + 1, options?.notes ?? null]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("duplicate key")) throw new Error(`Ship ${shipId} is already assigned to dock ${dockNumber}`);
        if (msg.includes("FOREIGN KEY") || msg.includes("foreign key") || msg.includes("violates foreign key")) throw new Error(`Ship ${shipId} not found in reference catalog`);
        throw err;
      }
      const res = await pool.query(SQL.getDockShip, [dockNumber, shipId]);
      return fixBool(res.rows[0] as DockShip, "isActive");
    },

    async removeDockShip(dockNumber, shipId) {
      const res = await pool.query(SQL.deleteDockShip, [dockNumber, shipId]);
      return (res.rowCount ?? 0) > 0;
    },

    async updateDockShip(dockNumber, shipId, fields) {
      return await withTransaction(pool, async (client) => {
        const existRes = await client.query(SQL.getDockShip, [dockNumber, shipId]);
        if (existRes.rows.length === 0) return null;

        if (fields.isActive !== undefined) {
          if (fields.isActive) await client.query(SQL.clearDockShipActive, [dockNumber]);
          await client.query(SQL.updateDockShipActive, [fields.isActive, dockNumber, shipId]);
        }
        if (fields.sortOrder !== undefined) {
          await client.query(SQL.updateDockShipSort, [fields.sortOrder, dockNumber, shipId]);
        }
        if (fields.notes !== undefined) {
          await client.query(SQL.updateDockShipNotes, [fields.notes, dockNumber, shipId]);
        }
        const finalRes = await client.query(SQL.getDockShip, [dockNumber, shipId]);
        return fixBool(finalRes.rows[0] as DockShip, "isActive");
      });
    },

    async getDockShips(dockNumber) {
      const res = await pool.query(SQL.getDockShips, [dockNumber]);
      return (res.rows as DockShip[]).map((r) => fixBool(r, "isActive"));
    },

    // ── Crew Presets ────────────────────────────────────

    async createPreset(fields) {
      if (!fields.shipId || !fields.intentKey || !fields.presetName) throw new Error("Preset requires shipId, intentKey, and presetName");
      const shipCheck = await pool.query(SQL.shipExists, [fields.shipId]);
      if (shipCheck.rows.length === 0) throw new Error(`Ship ${fields.shipId} not found in reference catalog`);
      const intentCheck = await pool.query(SQL.getIntent, [fields.intentKey]);
      if (intentCheck.rows.length === 0) throw new Error(`Intent ${fields.intentKey} not found in catalog`);

      const isDefault = fields.isDefault ?? false;
      let insertRes;
      try {
        insertRes = await pool.query(SQL.insertPreset, [fields.shipId, fields.intentKey, fields.presetName, isDefault]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("duplicate key")) throw new Error(`Preset "${fields.presetName}" already exists for ${fields.shipId} + ${fields.intentKey}`);
        throw err;
      }
      const id = Number(insertRes.rows[0].id);

      if (isDefault) {
        await pool.query(SQL.clearPresetDefaults, [fields.shipId, fields.intentKey, id]);
      }

      const presetRes = await pool.query(SQL.getPreset, [id]);
      return (await resolvePreset(presetRes.rows[0] as Row))!;
    },

    async getPreset(id) {
      const res = await pool.query(SQL.getPreset, [id]);
      return resolvePreset(res.rows[0] as Row | undefined);
    },

    async listPresets(filters?) {
      let res;
      if (filters?.tag) {
        res = await pool.query(SQL.listPresetsByTag, [filters.tag]);
      } else if (filters?.officerId) {
        res = await pool.query(SQL.listPresetsByOfficer, [filters.officerId]);
      } else if (filters?.shipId && filters?.intentKey) {
        res = await pool.query(SQL.listPresetsByShipAndIntent, [filters.shipId, filters.intentKey]);
      } else if (filters?.shipId) {
        res = await pool.query(SQL.listPresetsByShip, [filters.shipId]);
      } else if (filters?.intentKey) {
        res = await pool.query(SQL.listPresetsByIntent, [filters.intentKey]);
      } else {
        res = await pool.query(SQL.listPresets);
      }
      const presets = await Promise.all(
        (res.rows as Row[]).map((r) => resolvePreset(r)),
      );
      return presets.filter(Boolean) as CrewPresetWithMembers[];
    },

    async updatePreset(id, fields) {
      const existRes = await pool.query(SQL.getPreset, [id]);
      const existing = existRes.rows[0] as CrewPreset | undefined;
      if (!existing) return null;

      if (fields.presetName !== undefined) {
        await pool.query(SQL.updatePresetName, [fields.presetName, id]);
      }
      if (fields.isDefault !== undefined) {
        await pool.query(SQL.updatePresetDefault, [fields.isDefault, id]);
        if (fields.isDefault) {
          await pool.query(SQL.clearPresetDefaults, [existing.shipId, existing.intentKey, id]);
        }
      }
      const presetRes = await pool.query(SQL.getPreset, [id]);
      return resolvePreset(presetRes.rows[0] as Row);
    },

    async deletePreset(id) {
      const res = await pool.query(SQL.deletePreset, [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async setPresetMembers(presetId, members) {
      await withTransaction(pool, async (client) => {
        const presetCheck = await client.query(SQL.getPreset, [presetId]);
        if (presetCheck.rows.length === 0) throw new Error(`Preset ${presetId} not found`);

        for (const m of members) {
          const offCheck = await client.query(SQL.officerExists, [m.officerId]);
          if (offCheck.rows.length === 0) throw new Error(`Officer ${m.officerId} not found in reference catalog`);
          if (m.roleType !== "bridge" && m.roleType !== "below_deck") throw new Error(`Invalid roleType: ${m.roleType}`);
        }

        await client.query(SQL.clearPresetMembers, [presetId]);
        for (const m of members) {
          await client.query(SQL.insertPresetMember, [presetId, m.officerId, m.roleType, m.slot ?? null]);
        }
      });

      const res = await pool.query(SQL.getPresetMembers, [presetId]);
      return res.rows as CrewPresetMember[];
    },

    // ── Officer Conflicts ───────────────────────────────

    async getOfficerConflicts() {
      const res = await pool.query(SQL.officerConflicts);
      const rows = res.rows as Array<{
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
        const dockRes = await pool.query(SQL.shipDockNumbers, [row.shipId]);
        const dockNumbers = (dockRes.rows as { dock_number: number }[]).map((d) => d.dock_number);
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
      await withTransaction(pool, async (client) => {
        const check = await client.query(SQL.getPreset, [presetId]);
        if (check.rows.length === 0) throw new Error(`Preset ${presetId} not found`);
        await client.query(SQL.clearPresetTags, [presetId]);
        for (const tag of tags) {
          const normalized = tag.trim().toLowerCase();
          if (normalized) await client.query(SQL.insertPresetTag, [presetId, normalized]);
        }
      });

      const res = await pool.query(SQL.getPresetTags, [presetId]);
      return (res.rows as { tag: string }[]).map((r) => r.tag);
    },

    async listAllTags() {
      const res = await pool.query(SQL.listAllTags);
      return (res.rows as { tag: string }[]).map((r) => r.tag);
    },

    async findPresetsForDock(dockNumber) {
      const res = await pool.query(SQL.findPresetsForDock, [dockNumber]);
      const presets = await Promise.all(
        (res.rows as Row[]).map((r) => resolvePreset(r)),
      );
      return presets.filter(Boolean) as CrewPresetWithMembers[];
    },

    // ── Cascade Previews ────────────────────────────────

    async previewDeleteDock(dockNumber) {
      const countsRes = await pool.query(SQL.previewDeleteDock, [dockNumber]);
      const counts = countsRes.rows[0] as { shipCount: string; intentCount: string };
      const shipsRes = await pool.query(SQL.previewDeleteDockShips, [dockNumber]);
      const intentsRes = await pool.query(SQL.previewDeleteDockIntents, [dockNumber]);
      return {
        ships: shipsRes.rows as { shipId: string; shipName: string }[],
        intents: intentsRes.rows as { key: string; label: string }[],
        shipCount: Number(counts.shipCount),
        intentCount: Number(counts.intentCount),
      };
    },

    async previewDeleteShip(shipId) {
      const dockRes = await pool.query(SQL.previewDeleteShipFromDocks, [shipId]);
      const presetRes = await pool.query(SQL.previewDeleteShipPresets, [shipId]);
      return {
        dockAssignments: dockRes.rows as { dockNumber: number; dockLabel: string }[],
        presets: presetRes.rows as { id: number; presetName: string; intentLabel: string }[],
      };
    },

    async previewDeleteOfficer(officerId) {
      const res = await pool.query(SQL.previewDeleteOfficerFromPresets, [officerId]);
      return {
        presetMemberships: res.rows as { presetId: number; presetName: string; shipName: string; intentLabel: string }[],
      };
    },

    // ── Briefing ────────────────────────────────────────

    async buildBriefing() {
      const docks = await store.listDocks();
      const conflicts = await store.getOfficerConflicts();
      const allPresetsRes = await pool.query(SQL.listPresets);
      const allPresetRows = allPresetsRes.rows as Row[];
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

    async counts() {
      const [i, d, ds, p, pm, t] = await Promise.all([
        pool.query(SQL.countIntents),
        pool.query(SQL.countDocks),
        pool.query(SQL.countDockShips),
        pool.query(SQL.countPresets),
        pool.query(SQL.countPresetMembers),
        pool.query(SQL.countTags),
      ]);
      const c = (r: { rows: unknown[] }) => Number((r.rows[0] as { count: number }).count);
      return { intents: c(i), docks: c(d), dockShips: c(ds), presets: c(p), presetMembers: c(pm), tags: c(t) };
    },

    close: () => { /* pool managed externally */ },
  };

  return store;
}
