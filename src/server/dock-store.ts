/**
 * dock-store.ts — Drydock Loadout Data Layer (ADR-010 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed intent catalog and drydock loadout management.
 * Docks have intents (what they do), ship rotations (what goes in),
 * and eventually crew presets (Phase 2).
 *
 * Uses the same fleet.db as fleet-store.ts — accessed via a separate
 * Database handle sharing the same WAL-mode file.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export interface Intent {
  key: string;
  label: string;
  category: string;
  description: string | null;
  icon: string | null;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: string;
}

export type IntentCategory = "mining" | "combat" | "utility" | "custom";

export const VALID_INTENT_CATEGORIES: IntentCategory[] = [
  "mining",
  "combat",
  "utility",
  "custom",
];

export interface DockLoadout {
  dockNumber: number;
  label: string | null;
  notes: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface DockIntent {
  dockNumber: number;
  intentKey: string;
}

export interface DockShip {
  id: number;
  dockNumber: number;
  shipId: string;
  isActive: boolean;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  /** Joined fields (populated in queries) */
  shipName?: string;
}

/** Full dock with resolved intents and ships */
export interface DockWithContext {
  dockNumber: number;
  label: string | null;
  notes: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  intents: Intent[];
  ships: DockShip[];
}

// ─── Store Interface ────────────────────────────────────────

export interface DockStore {
  // ── Intents ───────────────────────────────────────────
  listIntents(filters?: { category?: string }): Intent[];
  getIntent(key: string): Intent | null;
  createIntent(intent: Pick<Intent, "key" | "label" | "category" | "description" | "icon">): Intent;
  deleteIntent(key: string): boolean;

  // ── Docks ─────────────────────────────────────────────
  listDocks(): DockWithContext[];
  getDock(dockNumber: number): DockWithContext | null;
  upsertDock(dockNumber: number, fields: { label?: string; notes?: string; priority?: number }): DockLoadout;
  deleteDock(dockNumber: number): boolean;

  // ── Dock Intents ──────────────────────────────────────
  setDockIntents(dockNumber: number, intentKeys: string[]): void;
  getDockIntents(dockNumber: number): Intent[];

  // ── Dock Ships ────────────────────────────────────────
  addDockShip(dockNumber: number, shipId: string, options?: { notes?: string }): DockShip;
  removeDockShip(dockNumber: number, shipId: string): boolean;
  updateDockShip(dockNumber: number, shipId: string, fields: { isActive?: boolean; sortOrder?: number; notes?: string }): DockShip | null;
  getDockShips(dockNumber: number): DockShip[];

  // ── Diagnostics ───────────────────────────────────────
  getDbPath(): string;
  counts(): { intents: number; docks: number; dockShips: number };
  close(): void;
}

// ─── Seed Data ──────────────────────────────────────────────

const SEED_INTENTS: Array<Pick<Intent, "key" | "label" | "category" | "description" | "icon"> & { sortOrder: number }> = [
  // Mining
  { key: "mining-gas", label: "Gas Mining", category: "mining", description: "Collecting raw gas from nodes", icon: "⛽", sortOrder: 10 },
  { key: "mining-crystal", label: "Crystal Mining", category: "mining", description: "Collecting raw crystal from nodes", icon: "💎", sortOrder: 11 },
  { key: "mining-ore", label: "Ore Mining", category: "mining", description: "Collecting raw ore from nodes", icon: "⛏️", sortOrder: 12 },
  { key: "mining-tri", label: "Tritanium Mining", category: "mining", description: "Collecting tritanium from refined nodes", icon: "🔩", sortOrder: 13 },
  { key: "mining-dil", label: "Dilithium Mining", category: "mining", description: "Collecting dilithium from refined nodes", icon: "🔮", sortOrder: 14 },
  { key: "mining-para", label: "Parasteel Mining", category: "mining", description: "Collecting parasteel from refined nodes", icon: "🛡️", sortOrder: 15 },
  { key: "mining-lat", label: "Latinum Mining", category: "mining", description: "Collecting latinum from nodes", icon: "💰", sortOrder: 16 },
  { key: "mining-iso", label: "Isogen Mining", category: "mining", description: "Collecting isogen from nodes", icon: "☢️", sortOrder: 17 },
  { key: "mining-data", label: "Data Mining", category: "mining", description: "Collecting data from nodes", icon: "📊", sortOrder: 18 },
  // Combat
  { key: "grinding", label: "Hostile Grinding", category: "combat", description: "Grinding hostile NPCs for dailies and events", icon: "⚔️", sortOrder: 20 },
  { key: "grinding-swarm", label: "Swarm Grinding", category: "combat", description: "Grinding swarm hostiles specifically", icon: "🐝", sortOrder: 21 },
  { key: "grinding-eclipse", label: "Eclipse Grinding", category: "combat", description: "Grinding eclipse hostiles specifically", icon: "🌑", sortOrder: 22 },
  { key: "armada", label: "Armada", category: "combat", description: "Group armada operations", icon: "🎯", sortOrder: 23 },
  { key: "armada-solo", label: "Solo Armada", category: "combat", description: "Solo armada takedowns", icon: "🎯", sortOrder: 24 },
  { key: "pvp", label: "PvP/Raiding", category: "combat", description: "Player vs player combat and raiding", icon: "💀", sortOrder: 25 },
  { key: "base-defense", label: "Base Defense", category: "combat", description: "Defending your starbase", icon: "🏰", sortOrder: 26 },
  // Utility
  { key: "exploration", label: "Exploration", category: "utility", description: "Exploring new systems and sectors", icon: "🔭", sortOrder: 30 },
  { key: "cargo-run", label: "Cargo Run", category: "utility", description: "Transporting cargo between stations", icon: "📦", sortOrder: 31 },
  { key: "events", label: "Events", category: "utility", description: "Special timed event activities", icon: "🎪", sortOrder: 32 },
  { key: "voyages", label: "Voyages", category: "utility", description: "Long-range autonomous voyages", icon: "🚀", sortOrder: 33 },
  { key: "away-team", label: "Away Team", category: "utility", description: "Ground-based away team missions", icon: "🖖", sortOrder: 34 },
];

// ─── Implementation ─────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "fleet.db");

export function createDockStore(dbPath?: string): DockStore {
  const resolvedPath = dbPath || DB_FILE;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    -- Ensure ships table exists (created by fleet-store, but we need FK refs)
    CREATE TABLE IF NOT EXISTS ships (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier INTEGER,
      ship_class TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      role TEXT,
      role_detail TEXT,
      notes TEXT,
      imported_from TEXT,
      status_changed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Reference catalog of available intents (seeded + user-extensible)
    CREATE TABLE IF NOT EXISTS intent_catalog (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- What each drydock is configured to do
    CREATE TABLE IF NOT EXISTS drydock_loadouts (
      dock_number INTEGER PRIMARY KEY CHECK (dock_number BETWEEN 1 AND 8),
      label TEXT,
      notes TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Multi-select: which intents are assigned to which dock
    CREATE TABLE IF NOT EXISTS dock_intents (
      dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
      intent_key TEXT NOT NULL REFERENCES intent_catalog(key),
      PRIMARY KEY (dock_number, intent_key)
    );

    -- Ships assigned to a dock rotation (multiple per dock, one active)
    CREATE TABLE IF NOT EXISTS dock_ships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
      ship_id TEXT NOT NULL REFERENCES ships(id),
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(dock_number, ship_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dock_intents_key ON dock_intents(intent_key);
    CREATE INDEX IF NOT EXISTS idx_dock_ships_ship ON dock_ships(ship_id);
    CREATE INDEX IF NOT EXISTS idx_dock_ships_dock ON dock_ships(dock_number);

    -- Ensure schema_version table exists (may already be created by fleet-store)
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    -- Update schema_version for dock-store tables
    INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (2, datetime('now'));
  `);

  // ── Seed intents ────────────────────────────────────────
  const insertSeedIntent = db.prepare(
    `INSERT OR IGNORE INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))`,
  );

  const seedIntents = db.transaction(() => {
    for (const intent of SEED_INTENTS) {
      insertSeedIntent.run(
        intent.key,
        intent.label,
        intent.category,
        intent.description,
        intent.icon,
        intent.sortOrder,
      );
    }
  });
  seedIntents();

  log.fleet.debug({ dbPath: resolvedPath }, "dock store initialized");

  // ── Prepared Statements ─────────────────────────────────

  const stmts = {
    // Intents
    listIntents: db.prepare(
      `SELECT key, label, category, description, icon,
              is_builtin AS isBuiltin, sort_order AS sortOrder,
              created_at AS createdAt
       FROM intent_catalog ORDER BY sort_order ASC, label ASC`,
    ),
    listIntentsByCategory: db.prepare(
      `SELECT key, label, category, description, icon,
              is_builtin AS isBuiltin, sort_order AS sortOrder,
              created_at AS createdAt
       FROM intent_catalog WHERE category = ? ORDER BY sort_order ASC, label ASC`,
    ),
    getIntent: db.prepare(
      `SELECT key, label, category, description, icon,
              is_builtin AS isBuiltin, sort_order AS sortOrder,
              created_at AS createdAt
       FROM intent_catalog WHERE key = ?`,
    ),
    insertIntent: db.prepare(
      `INSERT INTO intent_catalog (key, label, category, description, icon, is_builtin, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))`,
    ),
    deleteIntent: db.prepare(
      `DELETE FROM intent_catalog WHERE key = ? AND is_builtin = 0`,
    ),

    // Docks
    listDocks: db.prepare(
      `SELECT dock_number AS dockNumber, label, notes, priority,
              created_at AS createdAt, updated_at AS updatedAt
       FROM drydock_loadouts ORDER BY dock_number ASC`,
    ),
    getDock: db.prepare(
      `SELECT dock_number AS dockNumber, label, notes, priority,
              created_at AS createdAt, updated_at AS updatedAt
       FROM drydock_loadouts WHERE dock_number = ?`,
    ),
    upsertDock: db.prepare(
      `INSERT INTO drydock_loadouts (dock_number, label, notes, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(dock_number) DO UPDATE SET
         label = COALESCE(excluded.label, drydock_loadouts.label),
         notes = COALESCE(excluded.notes, drydock_loadouts.notes),
         priority = COALESCE(excluded.priority, drydock_loadouts.priority),
         updated_at = datetime('now')`,
    ),
    deleteDock: db.prepare(
      `DELETE FROM drydock_loadouts WHERE dock_number = ?`,
    ),

    // Dock Intents
    clearDockIntents: db.prepare(
      `DELETE FROM dock_intents WHERE dock_number = ?`,
    ),
    insertDockIntent: db.prepare(
      `INSERT INTO dock_intents (dock_number, intent_key) VALUES (?, ?)`,
    ),
    getDockIntents: db.prepare(
      `SELECT ic.key, ic.label, ic.category, ic.description, ic.icon,
              ic.is_builtin AS isBuiltin, ic.sort_order AS sortOrder,
              ic.created_at AS createdAt
       FROM dock_intents di
       JOIN intent_catalog ic ON di.intent_key = ic.key
       WHERE di.dock_number = ?
       ORDER BY ic.sort_order ASC`,
    ),

    // Dock Ships
    insertDockShip: db.prepare(
      `INSERT INTO dock_ships (dock_number, ship_id, is_active, sort_order, notes, created_at)
       VALUES (?, ?, 0, ?, ?, datetime('now'))`,
    ),
    deleteDockShip: db.prepare(
      `DELETE FROM dock_ships WHERE dock_number = ? AND ship_id = ?`,
    ),
    getDockShips: db.prepare(
      `SELECT ds.id, ds.dock_number AS dockNumber, ds.ship_id AS shipId,
              ds.is_active AS isActive, ds.sort_order AS sortOrder,
              ds.notes, ds.created_at AS createdAt,
              s.name AS shipName
       FROM dock_ships ds
       JOIN ships s ON ds.ship_id = s.id
       WHERE ds.dock_number = ?
       ORDER BY ds.sort_order ASC, s.name ASC`,
    ),
    getDockShip: db.prepare(
      `SELECT ds.id, ds.dock_number AS dockNumber, ds.ship_id AS shipId,
              ds.is_active AS isActive, ds.sort_order AS sortOrder,
              ds.notes, ds.created_at AS createdAt,
              s.name AS shipName
       FROM dock_ships ds
       JOIN ships s ON ds.ship_id = s.id
       WHERE ds.dock_number = ? AND ds.ship_id = ?`,
    ),
    updateDockShipActive: db.prepare(
      `UPDATE dock_ships SET is_active = ? WHERE dock_number = ? AND ship_id = ?`,
    ),
    updateDockShipSort: db.prepare(
      `UPDATE dock_ships SET sort_order = ? WHERE dock_number = ? AND ship_id = ?`,
    ),
    updateDockShipNotes: db.prepare(
      `UPDATE dock_ships SET notes = ? WHERE dock_number = ? AND ship_id = ?`,
    ),
    clearDockShipActive: db.prepare(
      `UPDATE dock_ships SET is_active = 0 WHERE dock_number = ?`,
    ),

    // Counts
    countIntents: db.prepare(`SELECT COUNT(*) AS count FROM intent_catalog`),
    countDocks: db.prepare(`SELECT COUNT(*) AS count FROM drydock_loadouts`),
    countDockShips: db.prepare(`SELECT COUNT(*) AS count FROM dock_ships`),
  };

  // ── Intent Methods ──────────────────────────────────────

  function listIntents(filters?: { category?: string }): Intent[] {
    const rows = filters?.category
      ? stmts.listIntentsByCategory.all(filters.category) as Intent[]
      : stmts.listIntents.all() as Intent[];
    return rows.map((r) => ({ ...r, isBuiltin: Boolean(r.isBuiltin) }));
  }

  function getIntent(key: string): Intent | null {
    const row = stmts.getIntent.get(key) as Intent | undefined;
    if (!row) return null;
    return { ...row, isBuiltin: Boolean(row.isBuiltin) };
  }

  function createIntent(intent: Pick<Intent, "key" | "label" | "category" | "description" | "icon">): Intent {
    if (!intent.key || !intent.label || !intent.category) {
      throw new Error("Intent requires key, label, and category");
    }
    if (!VALID_INTENT_CATEGORIES.includes(intent.category as IntentCategory)) {
      throw new Error(`Invalid category: ${intent.category}. Valid: ${VALID_INTENT_CATEGORIES.join(", ")}`);
    }
    // Custom intents get sort_order 100+ to appear after builtins
    const maxSort = (db.prepare(`SELECT MAX(sort_order) AS m FROM intent_catalog`).get() as { m: number | null }).m || 0;
    stmts.insertIntent.run(
      intent.key,
      intent.label,
      intent.category,
      intent.description ?? null,
      intent.icon ?? null,
      Math.max(maxSort + 1, 100),
    );
    return getIntent(intent.key)!;
  }

  function deleteIntent(key: string): boolean {
    const result = stmts.deleteIntent.run(key);
    return result.changes > 0;
  }

  // ── Dock Methods ────────────────────────────────────────

  function listDocks(): DockWithContext[] {
    const docks = stmts.listDocks.all() as DockLoadout[];
    return docks.map((dock) => ({
      ...dock,
      intents: (stmts.getDockIntents.all(dock.dockNumber) as Intent[]).map((r) => ({ ...r, isBuiltin: Boolean(r.isBuiltin) })),
      ships: (stmts.getDockShips.all(dock.dockNumber) as DockShip[]).map((r) => ({ ...r, isActive: Boolean(r.isActive) })),
    }));
  }

  function getDock(dockNumber: number): DockWithContext | null {
    const dock = stmts.getDock.get(dockNumber) as DockLoadout | undefined;
    if (!dock) return null;
    return {
      ...dock,
      intents: (stmts.getDockIntents.all(dockNumber) as Intent[]).map((r) => ({ ...r, isBuiltin: Boolean(r.isBuiltin) })),
      ships: (stmts.getDockShips.all(dockNumber) as DockShip[]).map((r) => ({ ...r, isActive: Boolean(r.isActive) })),
    };
  }

  function upsertDock(dockNumber: number, fields: { label?: string; notes?: string; priority?: number }): DockLoadout {
    if (dockNumber < 1 || dockNumber > 8) {
      throw new Error("Dock number must be between 1 and 8");
    }
    stmts.upsertDock.run(
      dockNumber,
      fields.label ?? null,
      fields.notes ?? null,
      fields.priority ?? 0,
    );
    return stmts.getDock.get(dockNumber) as DockLoadout;
  }

  function deleteDock(dockNumber: number): boolean {
    const result = stmts.deleteDock.run(dockNumber);
    return result.changes > 0;
  }

  // ── Dock Intent Methods ─────────────────────────────────

  const setDockIntentsTx = db.transaction((dockNumber: number, intentKeys: string[]) => {
    // Validate dock exists
    const dock = stmts.getDock.get(dockNumber);
    if (!dock) throw new Error(`Dock ${dockNumber} not found. Create it first with PUT /api/fleet/docks/${dockNumber}`);

    // Validate all intent keys exist
    for (const key of intentKeys) {
      const intent = stmts.getIntent.get(key);
      if (!intent) throw new Error(`Unknown intent key: ${key}`);
    }

    stmts.clearDockIntents.run(dockNumber);
    for (const key of intentKeys) {
      stmts.insertDockIntent.run(dockNumber, key);
    }
  });

  function setDockIntents(dockNumber: number, intentKeys: string[]): void {
    setDockIntentsTx(dockNumber, intentKeys);
  }

  function getDockIntents(dockNumber: number): Intent[] {
    return (stmts.getDockIntents.all(dockNumber) as Intent[]).map((r) => ({ ...r, isBuiltin: Boolean(r.isBuiltin) }));
  }

  // ── Dock Ship Methods ───────────────────────────────────

  function addDockShip(dockNumber: number, shipId: string, options?: { notes?: string }): DockShip {
    // Validate dock exists
    const dock = stmts.getDock.get(dockNumber);
    if (!dock) throw new Error(`Dock ${dockNumber} not found. Create it first.`);

    // Get max sort order for this dock
    const maxSort = (db.prepare(
      `SELECT MAX(sort_order) AS m FROM dock_ships WHERE dock_number = ?`,
    ).get(dockNumber) as { m: number | null }).m ?? -1;

    try {
      stmts.insertDockShip.run(dockNumber, shipId, maxSort + 1, options?.notes ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        throw new Error(`Ship ${shipId} is already assigned to dock ${dockNumber}`);
      }
      if (msg.includes("FOREIGN KEY constraint")) {
        throw new Error(`Ship ${shipId} not found in fleet roster`);
      }
      throw err;
    }

    const result = stmts.getDockShip.get(dockNumber, shipId) as DockShip;
    return { ...result, isActive: Boolean(result.isActive) };
  }

  function removeDockShip(dockNumber: number, shipId: string): boolean {
    const result = stmts.deleteDockShip.run(dockNumber, shipId);
    return result.changes > 0;
  }

  const updateDockShipTx = db.transaction((
    dockNumber: number,
    shipId: string,
    fields: { isActive?: boolean; sortOrder?: number; notes?: string },
  ) => {
    const existing = stmts.getDockShip.get(dockNumber, shipId) as DockShip | undefined;
    if (!existing) return null;

    if (fields.isActive !== undefined) {
      // If setting active, clear all others first (one active per dock)
      if (fields.isActive) {
        stmts.clearDockShipActive.run(dockNumber);
      }
      stmts.updateDockShipActive.run(fields.isActive ? 1 : 0, dockNumber, shipId);
    }

    if (fields.sortOrder !== undefined) {
      stmts.updateDockShipSort.run(fields.sortOrder, dockNumber, shipId);
    }

    if (fields.notes !== undefined) {
      stmts.updateDockShipNotes.run(fields.notes, dockNumber, shipId);
    }

    return stmts.getDockShip.get(dockNumber, shipId) as DockShip;
  });

  function updateDockShip(
    dockNumber: number,
    shipId: string,
    fields: { isActive?: boolean; sortOrder?: number; notes?: string },
  ): DockShip | null {
    const result = updateDockShipTx(dockNumber, shipId, fields);
    if (!result) return null;
    return { ...result, isActive: Boolean(result.isActive) };
  }

  function getDockShips(dockNumber: number): DockShip[] {
    return (stmts.getDockShips.all(dockNumber) as DockShip[]).map((r) => ({ ...r, isActive: Boolean(r.isActive) }));
  }

  // ── Diagnostics ─────────────────────────────────────────

  return {
    listIntents,
    getIntent,
    createIntent,
    deleteIntent,
    listDocks,
    getDock,
    upsertDock,
    deleteDock,
    setDockIntents,
    getDockIntents,
    addDockShip,
    removeDockShip,
    updateDockShip,
    getDockShips,
    getDbPath: () => resolvedPath,
    counts: () => ({
      intents: (stmts.countIntents.get() as { count: number }).count,
      docks: (stmts.countDocks.get() as { count: number }).count,
      dockShips: (stmts.countDockShips.get() as { count: number }).count,
    }),
    close: () => db.close(),
  };
}
