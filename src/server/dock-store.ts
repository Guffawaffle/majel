/**
 * dock-store.ts — Drydock Loadout Data Layer (ADR-010 Phases 1 & 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * SQLite-backed intent catalog, drydock loadout management,
 * and crew preset system.
 *
 * Shares reference.db with reference-store and overlay-store.
 * Ship/officer FKs point to reference_ships / reference_officers.
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

// ─── Crew Preset Types ──────────────────────────────────────

export interface CrewPreset {
  id: number;
  shipId: string;
  intentKey: string;
  presetName: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Joined fields (populated in queries) */
  shipName?: string;
  intentLabel?: string;
}

export interface CrewPresetMember {
  id: number;
  presetId: number;
  officerId: string;
  roleType: "bridge" | "below_deck";
  slot: string | null;
  /** Joined fields */
  officerName?: string;
}

export interface CrewPresetWithMembers extends CrewPreset {
  members: CrewPresetMember[];
  tags: string[];
}

export interface OfficerConflict {
  officerId: string;
  officerName: string;
  appearances: Array<{
    presetId: number;
    presetName: string;
    shipId: string;
    shipName: string;
    intentKey: string;
    intentLabel: string;
    dockNumbers: number[];
  }>;
}

/** Computed briefing for model context injection (ADR-010 §3) */
export interface DockBriefing {
  /** Tier 1: one-line per dock */
  statusLines: string[];
  /** Tier 2: active crew per dock + conflicts */
  crewLines: string[];
  conflictLines: string[];
  /** Tier 3: computed insights */
  insights: string[];
  /** Combined text for prompt injection */
  text: string;
  /** Total character count for prompt budget tracking */
  totalChars: number;
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
  nextDockNumber(): number;

  // ── Dock Intents ──────────────────────────────────────
  setDockIntents(dockNumber: number, intentKeys: string[]): void;
  getDockIntents(dockNumber: number): Intent[];

  // ── Dock Ships ────────────────────────────────────────
  addDockShip(dockNumber: number, shipId: string, options?: { notes?: string }): DockShip;
  removeDockShip(dockNumber: number, shipId: string): boolean;
  updateDockShip(dockNumber: number, shipId: string, fields: { isActive?: boolean; sortOrder?: number; notes?: string }): DockShip | null;
  getDockShips(dockNumber: number): DockShip[];

  // ── Crew Presets ──────────────────────────────────────
  createPreset(fields: { shipId: string; intentKey: string; presetName: string; isDefault?: boolean }): CrewPresetWithMembers;
  getPreset(id: number): CrewPresetWithMembers | null;
  listPresets(filters?: { shipId?: string; intentKey?: string; tag?: string; officerId?: string }): CrewPresetWithMembers[];
  updatePreset(id: number, fields: { presetName?: string; isDefault?: boolean }): CrewPresetWithMembers | null;
  deletePreset(id: number): boolean;
  setPresetMembers(presetId: number, members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>): CrewPresetMember[];
  getOfficerConflicts(): OfficerConflict[];

  // ── Tags & Discovery ──────────────────────────────────
  setPresetTags(presetId: number, tags: string[]): string[];
  listAllTags(): string[];
  findPresetsForDock(dockNumber: number): CrewPresetWithMembers[];

  // ── Cascade Previews ──────────────────────────────────
  previewDeleteDock(dockNumber: number): { ships: { shipId: string; shipName: string }[]; intents: { key: string; label: string }[]; shipCount: number; intentCount: number };
  previewDeleteShip(shipId: string): { dockAssignments: { dockNumber: number; dockLabel: string }[]; presets: { id: number; presetName: string; intentLabel: string }[] };
  previewDeleteOfficer(officerId: string): { presetMemberships: { presetId: number; presetName: string; shipName: string; intentLabel: string }[] };

  // ── Briefing ──────────────────────────────────────────
  buildBriefing(): DockBriefing;

  // ── Diagnostics ───────────────────────────────────────
  getDbPath(): string;
  counts(): { intents: number; docks: number; dockShips: number; presets: number; presetMembers: number; tags: number };
  close(): void;
}

// ─── Seed Data ──────────────────────────────────────────────

const SEED_INTENTS: Array<Pick<Intent, "key" | "label" | "category" | "description" | "icon"> & { sortOrder: number }> = [
  // General (default — always available, even without dock intents selected)
  { key: "general", label: "General", category: "utility", description: "General-purpose crew configuration", icon: "⚙️", sortOrder: 0 },
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
const DB_FILE = path.join(DB_DIR, "reference.db");

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
      dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
      label TEXT,
      notes TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Multi-select: which intents are assigned to which dock
    CREATE TABLE IF NOT EXISTS dock_intents (
      dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
      intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
      PRIMARY KEY (dock_number, intent_key)
    );

    -- Ships assigned to a dock rotation (multiple per dock, one active)
    CREATE TABLE IF NOT EXISTS dock_ships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
      ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(dock_number, ship_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dock_intents_key ON dock_intents(intent_key);
    CREATE INDEX IF NOT EXISTS idx_dock_ships_ship ON dock_ships(ship_id);
    CREATE INDEX IF NOT EXISTS idx_dock_ships_dock ON dock_ships(dock_number);

    -- Saved crew configuration for a ship + intent combo (ADR-010 Phase 2)
    CREATE TABLE IF NOT EXISTS crew_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
      intent_key TEXT NOT NULL REFERENCES intent_catalog(key) ON DELETE CASCADE,
      preset_name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(ship_id, intent_key, preset_name)
    );

    -- Officers in a crew preset
    CREATE TABLE IF NOT EXISTS crew_preset_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preset_id INTEGER NOT NULL REFERENCES crew_presets(id) ON DELETE CASCADE,
      officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
      role_type TEXT NOT NULL CHECK (role_type IN ('bridge', 'below_deck')),
      slot TEXT,
      UNIQUE(preset_id, officer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_crew_presets_ship ON crew_presets(ship_id);
    CREATE INDEX IF NOT EXISTS idx_crew_presets_intent ON crew_presets(intent_key);
    CREATE INDEX IF NOT EXISTS idx_crew_preset_members_officer ON crew_preset_members(officer_id);
    CREATE INDEX IF NOT EXISTS idx_crew_preset_members_preset ON crew_preset_members(preset_id);

    -- Freeform tags for preset discoverability (ADR-010 Phase 2b)
    CREATE TABLE IF NOT EXISTS preset_tags (
      preset_id INTEGER NOT NULL REFERENCES crew_presets(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (preset_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_preset_tags_tag ON preset_tags(tag);

    -- Dock-store schema version tracking
    CREATE TABLE IF NOT EXISTS dock_schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO dock_schema_version (version, applied_at) VALUES (2, datetime('now'));
    INSERT OR IGNORE INTO dock_schema_version (version, applied_at) VALUES (3, datetime('now'));
    INSERT OR IGNORE INTO dock_schema_version (version, applied_at) VALUES (4, datetime('now'));
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
       JOIN reference_ships s ON ds.ship_id = s.id
       WHERE ds.dock_number = ?
       ORDER BY ds.sort_order ASC, s.name ASC`,
    ),
    getDockShip: db.prepare(
      `SELECT ds.id, ds.dock_number AS dockNumber, ds.ship_id AS shipId,
              ds.is_active AS isActive, ds.sort_order AS sortOrder,
              ds.notes, ds.created_at AS createdAt,
              s.name AS shipName
       FROM dock_ships ds
       JOIN reference_ships s ON ds.ship_id = s.id
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

    // Crew Presets
    insertPreset: db.prepare(
      `INSERT INTO crew_presets (ship_id, intent_key, preset_name, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ),
    getPreset: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.id = ?`,
    ),
    listPresets: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
    ),
    listPresetsByShip: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.ship_id = ?
       ORDER BY ic.label ASC, cp.preset_name ASC`,
    ),
    listPresetsByIntent: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.intent_key = ?
       ORDER BY s.name ASC, cp.preset_name ASC`,
    ),
    listPresetsByShipAndIntent: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.ship_id = ? AND cp.intent_key = ?
       ORDER BY cp.preset_name ASC`,
    ),
    updatePresetName: db.prepare(
      `UPDATE crew_presets SET preset_name = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    updatePresetDefault: db.prepare(
      `UPDATE crew_presets SET is_default = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    clearPresetDefaults: db.prepare(
      `UPDATE crew_presets SET is_default = 0, updated_at = datetime('now') WHERE ship_id = ? AND intent_key = ? AND id != ?`,
    ),
    deletePreset: db.prepare(
      `DELETE FROM crew_presets WHERE id = ?`,
    ),

    // Crew Preset Members
    clearPresetMembers: db.prepare(
      `DELETE FROM crew_preset_members WHERE preset_id = ?`,
    ),
    insertPresetMember: db.prepare(
      `INSERT INTO crew_preset_members (preset_id, officer_id, role_type, slot)
       VALUES (?, ?, ?, ?)`,
    ),
    getPresetMembers: db.prepare(
      `SELECT cpm.id, cpm.preset_id AS presetId, cpm.officer_id AS officerId,
              cpm.role_type AS roleType, cpm.slot,
              o.name AS officerName
       FROM crew_preset_members cpm
       JOIN reference_officers o ON cpm.officer_id = o.id
       WHERE cpm.preset_id = ?
       ORDER BY cpm.role_type ASC, cpm.slot ASC`,
    ),

    // Officer Conflicts — officers appearing in multiple presets across different docks
    officerConflicts: db.prepare(
      `SELECT cpm.officer_id AS officerId, o.name AS officerName,
              cp.id AS presetId, cp.preset_name AS presetName,
              cp.ship_id AS shipId, s.name AS shipName,
              cp.intent_key AS intentKey, ic.label AS intentLabel
       FROM crew_preset_members cpm
       JOIN reference_officers o ON cpm.officer_id = o.id
       JOIN crew_presets cp ON cpm.preset_id = cp.id
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cpm.officer_id IN (
         SELECT officer_id FROM crew_preset_members GROUP BY officer_id HAVING COUNT(DISTINCT preset_id) > 1
       )
       ORDER BY o.name ASC, s.name ASC`,
    ),

    // Tags
    getPresetTags: db.prepare(
      `SELECT tag FROM preset_tags WHERE preset_id = ? ORDER BY tag ASC`,
    ),
    clearPresetTags: db.prepare(
      `DELETE FROM preset_tags WHERE preset_id = ?`,
    ),
    insertPresetTag: db.prepare(
      `INSERT OR IGNORE INTO preset_tags (preset_id, tag) VALUES (?, ?)`,
    ),
    listAllTags: db.prepare(
      `SELECT DISTINCT tag FROM preset_tags ORDER BY tag ASC`,
    ),
    listPresetsByTag: db.prepare(
      `SELECT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       JOIN preset_tags pt ON cp.id = pt.preset_id
       WHERE pt.tag = ?
       ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
    ),
    listPresetsByOfficer: db.prepare(
      `SELECT DISTINCT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       JOIN crew_preset_members cpm ON cp.id = cpm.preset_id
       WHERE cpm.officer_id = ?
       ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
    ),
    findPresetsForDock: db.prepare(
      `SELECT DISTINCT cp.id, cp.ship_id AS shipId, cp.intent_key AS intentKey,
              cp.preset_name AS presetName, cp.is_default AS isDefault,
              cp.created_at AS createdAt, cp.updated_at AS updatedAt,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.ship_id IN (SELECT ship_id FROM dock_ships WHERE dock_number = ?)
         AND cp.intent_key IN (SELECT intent_key FROM dock_intents WHERE dock_number = ?)
       ORDER BY s.name ASC, ic.label ASC, cp.preset_name ASC`,
    ),

    // Cascade previews
    previewDeleteDock: db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM dock_ships WHERE dock_number = ?) AS shipCount,
         (SELECT COUNT(*) FROM dock_intents WHERE dock_number = ?) AS intentCount`,
    ),
    previewDeleteDockShips: db.prepare(
      `SELECT ds.ship_id AS shipId, s.name AS shipName
       FROM dock_ships ds JOIN reference_ships s ON ds.ship_id = s.id
       WHERE ds.dock_number = ? ORDER BY s.name ASC`,
    ),
    previewDeleteDockIntents: db.prepare(
      `SELECT di.intent_key AS key, ic.label
       FROM dock_intents di JOIN intent_catalog ic ON di.intent_key = ic.key
       WHERE di.dock_number = ? ORDER BY ic.label ASC`,
    ),
    previewDeleteShipFromDocks: db.prepare(
      `SELECT ds.dock_number AS dockNumber, dl.label AS dockLabel
       FROM dock_ships ds
       JOIN drydock_loadouts dl ON ds.dock_number = dl.dock_number
       WHERE ds.ship_id = ?
       ORDER BY ds.dock_number ASC`,
    ),
    previewDeleteShipPresets: db.prepare(
      `SELECT cp.id, cp.preset_name AS presetName, ic.label AS intentLabel
       FROM crew_presets cp
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cp.ship_id = ?
       ORDER BY cp.preset_name ASC`,
    ),
    previewDeleteOfficerFromPresets: db.prepare(
      `SELECT cp.id AS presetId, cp.preset_name AS presetName,
              s.name AS shipName, ic.label AS intentLabel
       FROM crew_preset_members cpm
       JOIN crew_presets cp ON cpm.preset_id = cp.id
       JOIN reference_ships s ON cp.ship_id = s.id
       JOIN intent_catalog ic ON cp.intent_key = ic.key
       WHERE cpm.officer_id = ?
       ORDER BY cp.preset_name ASC`,
    ),

    // Counts
    countIntents: db.prepare(`SELECT COUNT(*) AS count FROM intent_catalog`),
    countDocks: db.prepare(`SELECT COUNT(*) AS count FROM drydock_loadouts`),
    countDockShips: db.prepare(`SELECT COUNT(*) AS count FROM dock_ships`),
    countPresets: db.prepare(`SELECT COUNT(*) AS count FROM crew_presets`),
    countPresetMembers: db.prepare(`SELECT COUNT(*) AS count FROM crew_preset_members`),
    countTags: db.prepare(`SELECT COUNT(*) AS count FROM preset_tags`),
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
    if (dockNumber < 1) {
      throw new Error("Dock number must be a positive integer");
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

  function nextDockNumber(): number {
    const row = db.prepare(`SELECT COALESCE(MAX(dock_number), 0) + 1 AS next FROM drydock_loadouts`).get() as { next: number };
    return row.next;
  }

  // ── Cascade Preview Methods ─────────────────────────────

  function previewDeleteDock(dockNumber: number) {
    const counts = stmts.previewDeleteDock.get(dockNumber, dockNumber) as { shipCount: number; intentCount: number };
    const ships = stmts.previewDeleteDockShips.all(dockNumber) as { shipId: string; shipName: string }[];
    const intents = stmts.previewDeleteDockIntents.all(dockNumber) as { key: string; label: string }[];
    return { ships, intents, shipCount: counts.shipCount, intentCount: counts.intentCount };
  }

  function previewDeleteShip(shipId: string) {
    const dockAssignments = stmts.previewDeleteShipFromDocks.all(shipId) as { dockNumber: number; dockLabel: string }[];
    const presets = stmts.previewDeleteShipPresets.all(shipId) as { id: number; presetName: string; intentLabel: string }[];
    return { dockAssignments, presets };
  }

  function previewDeleteOfficer(officerId: string) {
    const presetMemberships = stmts.previewDeleteOfficerFromPresets.all(officerId) as { presetId: number; presetName: string; shipName: string; intentLabel: string }[];
    return { presetMemberships };
  }

  // ── Dock Intent Methods ─────────────────────────────────

  const setDockIntentsTx = db.transaction((dockNumber: number, intentKeys: string[]) => {
    // Auto-create dock if it doesn't exist yet
    const dock = stmts.getDock.get(dockNumber);
    if (!dock) {
      stmts.upsertDock.run(dockNumber, null, null, 0);
    }

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
    // Auto-create dock if it doesn't exist yet
    const dock = stmts.getDock.get(dockNumber);
    if (!dock) {
      stmts.upsertDock.run(dockNumber, null, null, 0);
    }

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
        throw new Error(`Ship ${shipId} not found in reference catalog`);
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

  // ── Crew Preset Methods ─────────────────────────────────

  function resolvePreset(row: CrewPreset | undefined): CrewPresetWithMembers | null {
    if (!row) return null;
    const preset = { ...row, isDefault: Boolean(row.isDefault) };
    const members = stmts.getPresetMembers.all(preset.id) as CrewPresetMember[];
    const tags = (stmts.getPresetTags.all(preset.id) as Array<{ tag: string }>).map((r) => r.tag);
    return { ...preset, members, tags };
  }

  function createPreset(fields: { shipId: string; intentKey: string; presetName: string; isDefault?: boolean }): CrewPresetWithMembers {
    if (!fields.shipId || !fields.intentKey || !fields.presetName) {
      throw new Error("Preset requires shipId, intentKey, and presetName");
    }
    // Validate FKs exist
    const ship = db.prepare(`SELECT id FROM reference_ships WHERE id = ?`).get(fields.shipId);
    if (!ship) throw new Error(`Ship ${fields.shipId} not found in reference catalog`);
    const intent = stmts.getIntent.get(fields.intentKey);
    if (!intent) throw new Error(`Intent ${fields.intentKey} not found in catalog`);

    const isDefault = fields.isDefault ? 1 : 0;
    try {
      stmts.insertPreset.run(fields.shipId, fields.intentKey, fields.presetName, isDefault);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        throw new Error(`Preset "${fields.presetName}" already exists for ${fields.shipId} + ${fields.intentKey}`);
      }
      throw err;
    }
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;

    // If this is default, clear other defaults for same ship+intent
    if (isDefault) {
      stmts.clearPresetDefaults.run(fields.shipId, fields.intentKey, id);
    }

    return resolvePreset(stmts.getPreset.get(id) as CrewPreset)!;
  }

  function getPreset(id: number): CrewPresetWithMembers | null {
    return resolvePreset(stmts.getPreset.get(id) as CrewPreset | undefined);
  }

  function listPresets(filters?: { shipId?: string; intentKey?: string; tag?: string; officerId?: string }): CrewPresetWithMembers[] {
    let rows: CrewPreset[];
    // Tag and officer filters use dedicated queries (can't combine with ship/intent in one prepared stmt)
    if (filters?.tag) {
      rows = stmts.listPresetsByTag.all(filters.tag) as CrewPreset[];
    } else if (filters?.officerId) {
      rows = stmts.listPresetsByOfficer.all(filters.officerId) as CrewPreset[];
    } else if (filters?.shipId && filters?.intentKey) {
      rows = stmts.listPresetsByShipAndIntent.all(filters.shipId, filters.intentKey) as CrewPreset[];
    } else if (filters?.shipId) {
      rows = stmts.listPresetsByShip.all(filters.shipId) as CrewPreset[];
    } else if (filters?.intentKey) {
      rows = stmts.listPresetsByIntent.all(filters.intentKey) as CrewPreset[];
    } else {
      rows = stmts.listPresets.all() as CrewPreset[];
    }
    return rows.map((r) => resolvePreset(r)!);
  }

  function updatePreset(id: number, fields: { presetName?: string; isDefault?: boolean }): CrewPresetWithMembers | null {
    const existing = stmts.getPreset.get(id) as CrewPreset | undefined;
    if (!existing) return null;

    if (fields.presetName !== undefined) {
      stmts.updatePresetName.run(fields.presetName, id);
    }
    if (fields.isDefault !== undefined) {
      stmts.updatePresetDefault.run(fields.isDefault ? 1 : 0, id);
      if (fields.isDefault) {
        stmts.clearPresetDefaults.run(existing.shipId, existing.intentKey, id);
      }
    }
    return resolvePreset(stmts.getPreset.get(id) as CrewPreset);
  }

  function deletePreset(id: number): boolean {
    const result = stmts.deletePreset.run(id);
    return result.changes > 0;
  }

  const setPresetMembersTx = db.transaction((
    presetId: number,
    members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>,
  ) => {
    const preset = stmts.getPreset.get(presetId) as CrewPreset | undefined;
    if (!preset) throw new Error(`Preset ${presetId} not found`);

    // Validate all officers exist
    for (const m of members) {
      const officer = db.prepare(`SELECT id FROM reference_officers WHERE id = ?`).get(m.officerId);
      if (!officer) throw new Error(`Officer ${m.officerId} not found in reference catalog`);
      if (m.roleType !== "bridge" && m.roleType !== "below_deck") {
        throw new Error(`Invalid roleType: ${m.roleType}. Must be 'bridge' or 'below_deck'`);
      }
    }

    stmts.clearPresetMembers.run(presetId);
    for (const m of members) {
      stmts.insertPresetMember.run(presetId, m.officerId, m.roleType, m.slot ?? null);
    }
  });

  function setPresetMembers(
    presetId: number,
    members: Array<{ officerId: string; roleType: "bridge" | "below_deck"; slot?: string }>,
  ): CrewPresetMember[] {
    setPresetMembersTx(presetId, members);
    return stmts.getPresetMembers.all(presetId) as CrewPresetMember[];
  }

  // ── Officer Conflict Detection ──────────────────────────

  function getOfficerConflicts(): OfficerConflict[] {
    const rows = stmts.officerConflicts.all() as Array<{
      officerId: string;
      officerName: string;
      presetId: number;
      presetName: string;
      shipId: string;
      shipName: string;
      intentKey: string;
      intentLabel: string;
    }>;

    // Group by officer, then by preset — and resolve which docks each ship appears in
    const byOfficer = new Map<string, OfficerConflict>();
    for (const row of rows) {
      let conflict = byOfficer.get(row.officerId);
      if (!conflict) {
        conflict = { officerId: row.officerId, officerName: row.officerName, appearances: [] };
        byOfficer.set(row.officerId, conflict);
      }

      // Find which docks this ship is assigned to
      const dockRows = db.prepare(
        `SELECT dock_number FROM dock_ships WHERE ship_id = ?`,
      ).all(row.shipId) as Array<{ dock_number: number }>;
      const dockNumbers = dockRows.map((d) => d.dock_number);

      conflict.appearances.push({
        presetId: row.presetId,
        presetName: row.presetName,
        shipId: row.shipId,
        shipName: row.shipName,
        intentKey: row.intentKey,
        intentLabel: row.intentLabel,
        dockNumbers,
      });
    }

    return Array.from(byOfficer.values());
  }

  // ── Tags & Discovery ────────────────────────────────────

  const setPresetTagsTx = db.transaction((presetId: number, tags: string[]) => {
    const preset = stmts.getPreset.get(presetId) as CrewPreset | undefined;
    if (!preset) throw new Error(`Preset ${presetId} not found`);

    stmts.clearPresetTags.run(presetId);
    for (const tag of tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized) {
        stmts.insertPresetTag.run(presetId, normalized);
      }
    }
  });

  function setPresetTags(presetId: number, tags: string[]): string[] {
    setPresetTagsTx(presetId, tags);
    return (stmts.getPresetTags.all(presetId) as Array<{ tag: string }>).map((r) => r.tag);
  }

  function listAllTags(): string[] {
    return (stmts.listAllTags.all() as Array<{ tag: string }>).map((r) => r.tag);
  }

  function findPresetsForDock(dockNumber: number): CrewPresetWithMembers[] {
    const rows = stmts.findPresetsForDock.all(dockNumber, dockNumber) as CrewPreset[];
    return rows.map((r) => resolvePreset(r)!);
  }

  // ── Dock Briefing Builder (ADR-010 §3) ──────────────────

  function buildBriefing(): DockBriefing {
    const docks = listDocks();
    const conflicts = getOfficerConflicts();

    if (docks.length === 0) {
      return { statusLines: [], crewLines: [], conflictLines: [], insights: [], text: "", totalChars: 0 };
    }

    // Tier 1: Dock Status Summary
    const statusLines: string[] = [];
    for (const dock of docks) {
      const label = dock.label ? `"${dock.label}"` : "(unlabeled)";
      const intentTags = dock.intents.length > 0
        ? `[${dock.intents.map((i) => i.key).join(", ")}]`
        : "[no intents]";
      const activeShip = dock.ships.find((s) => s.isActive);
      const shipInfo = activeShip
        ? `${activeShip.shipName} (active)`
        : dock.ships.length > 0
          ? `${dock.ships[0].shipName} (none active)`
          : "empty";
      const rotationCount = dock.ships.length;
      statusLines.push(
        `  D${dock.dockNumber} ${label} ${intentTags} → ${shipInfo} | ${rotationCount} ship${rotationCount !== 1 ? "s" : ""} in rotation`,
      );
    }

    // Tier 2: Crew Summary + Conflicts
    const crewLines: string[] = [];
    for (const dock of docks) {
      const activeShip = dock.ships.find((s) => s.isActive);
      if (!activeShip) continue;

      // Find default presets for this ship + dock's intents
      const presets = listPresets({ shipId: activeShip.shipId });
      const relevantPresets = presets.filter((p) =>
        dock.intents.some((i) => i.key === p.intentKey) && p.members.length > 0,
      );

      if (relevantPresets.length > 0) {
        // Use the first matching preset with members for display
        const best = relevantPresets.find((p) => p.isDefault) || relevantPresets[0];
        const crewStr = best.members
          .filter((m) => m.roleType === "bridge")
          .map((m, i) => i === 0 ? `${m.officerName}(cpt)` : m.officerName)
          .join(" · ");
        const presetCount = relevantPresets.length;
        const suffix = presetCount > 1 ? ` — ${presetCount} presets` : "";
        const tagStr = best.tags.length > 0 ? ` [${best.tags.join(", ")}]` : "";
        crewLines.push(`  D${dock.dockNumber} ${activeShip.shipName}: ${crewStr || "(no bridge crew)"}${suffix}${tagStr}`);
      } else {
        crewLines.push(`  D${dock.dockNumber} ${activeShip.shipName}: (no crew preset — model will suggest)`);
      }
    }

    const conflictLines: string[] = [];
    for (const c of conflicts) {
      const locations = c.appearances
        .map((a) => {
          const dockStr = a.dockNumbers.length > 0
            ? `D${a.dockNumbers.join(",D")} `
            : "";
          return `${dockStr}${a.intentLabel}`;
        })
        .join(", ");
      conflictLines.push(`  ${c.officerName}: [${locations}]`);
    }

    // Tier 3: Computed Insights
    const insights: string[] = [];

    // Identify intent concentration
    const intentCounts = new Map<string, number>();
    for (const dock of docks) {
      for (const intent of dock.intents) {
        intentCounts.set(intent.category, (intentCounts.get(intent.category) || 0) + 1);
      }
    }
    for (const [category, count] of intentCounts) {
      if (count > docks.length / 2) {
        insights.push(`- ${count} of ${docks.length} docks assigned to ${category} — consider diversifying if other activities are falling behind`);
      }
    }

    // Identify docks with no rotation (single point of failure)
    for (const dock of docks) {
      if (dock.ships.length === 1) {
        const label = dock.label || `Dock ${dock.dockNumber}`;
        insights.push(`- ${label} (D${dock.dockNumber}) has no rotation — single point of failure`);
      }
    }

    // Identify docks with no active ship
    for (const dock of docks) {
      if (dock.ships.length > 0 && !dock.ships.some((s) => s.isActive)) {
        const label = dock.label || `Dock ${dock.dockNumber}`;
        insights.push(`- ${label} (D${dock.dockNumber}) has ships but none marked active`);
      }
    }

    // Officer conflict count
    if (conflicts.length > 0) {
      insights.push(`- ${conflicts.length} officer${conflicts.length !== 1 ? "s" : ""} appear in presets for multiple ships/docks (see conflicts above)`);
    }

    // Assemble text
    const sections: string[] = [];

    sections.push(`DRYDOCK STATUS (${docks.length} active dock${docks.length !== 1 ? "s" : ""}):`);
    sections.push(statusLines.join("\n"));

    if (crewLines.length > 0) {
      sections.push(`\nACTIVE CREW:`);
      sections.push(crewLines.join("\n"));
    }

    if (conflictLines.length > 0) {
      sections.push(`\nOFFICER CONFLICTS:`);
      sections.push(conflictLines.join("\n"));
    }

    if (insights.length > 0) {
      sections.push(`\nFLEET NOTES:`);
      sections.push(insights.join("\n"));
    }

    const text = sections.join("\n");

    return {
      statusLines,
      crewLines,
      conflictLines,
      insights,
      text,
      totalChars: text.length,
    };
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
    nextDockNumber,
    setDockIntents,
    getDockIntents,
    addDockShip,
    removeDockShip,
    updateDockShip,
    getDockShips,
    createPreset,
    getPreset,
    listPresets,
    updatePreset,
    deletePreset,
    setPresetMembers,
    getOfficerConflicts,
    setPresetTags,
    listAllTags,
    findPresetsForDock,
    buildBriefing,
    previewDeleteDock,
    previewDeleteShip,
    previewDeleteOfficer,
    getDbPath: () => resolvedPath,
    counts: () => ({
      intents: (stmts.countIntents.get() as { count: number }).count,
      docks: (stmts.countDocks.get() as { count: number }).count,
      dockShips: (stmts.countDockShips.get() as { count: number }).count,
      presets: (stmts.countPresets.get() as { count: number }).count,
      presetMembers: (stmts.countPresetMembers.get() as { count: number }).count,
      tags: (stmts.countTags.get() as { count: number }).count,
    }),
    close: () => db.close(),
  };
}
