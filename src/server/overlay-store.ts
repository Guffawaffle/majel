/**
 * overlay-store.ts — User Ownership & Target Overlay (ADR-016 D2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Thin overlay on reference catalog entries. Stores the user's personal
 * relationship to each entity: ownership state, targeting, level, rank.
 *
 * The reference data (abilities, rarity, group) lives in reference-store.ts.
 * This module stores ONLY user-specific state, keyed by ref_id.
 *
 * Design choices (from ADR-016):
 * - ownership_state is three-state: 'unknown' | 'owned' | 'unowned'
 * - target is independent of ownership (owned + targeted is valid)
 * - Overlay rows are created on first interaction (no row = unknown/not targeted)
 * - Uses the same reference.db as reference-store.ts (shared DB, separate tables)
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export type OwnershipState = "unknown" | "owned" | "unowned";

export const VALID_OWNERSHIP_STATES: OwnershipState[] = ["unknown", "owned", "unowned"];

export interface OfficerOverlay {
  refId: string;                           // FK → reference_officers.id
  ownershipState: OwnershipState;
  target: boolean;
  level: number | null;
  rank: string | null;
  power: number | null;
  targetNote: string | null;
  targetPriority: number | null;           // 1=high, 2=medium, 3=low
  updatedAt: string;
}

export interface ShipOverlay {
  refId: string;                           // FK → reference_ships.id
  ownershipState: OwnershipState;
  target: boolean;
  tier: number | null;
  level: number | null;
  power: number | null;
  targetNote: string | null;
  targetPriority: number | null;
  updatedAt: string;
}

export interface SetOfficerOverlayInput {
  refId: string;
  ownershipState?: OwnershipState;
  target?: boolean;
  level?: number | null;
  rank?: string | null;
  power?: number | null;
  targetNote?: string | null;
  targetPriority?: number | null;
}

export interface SetShipOverlayInput {
  refId: string;
  ownershipState?: OwnershipState;
  target?: boolean;
  tier?: number | null;
  level?: number | null;
  power?: number | null;
  targetNote?: string | null;
  targetPriority?: number | null;
}

// ─── Store Interface ────────────────────────────────────────

export interface OverlayStore {
  // ── Officer Overlays ──────────────────────────────────
  getOfficerOverlay(refId: string): OfficerOverlay | null;
  setOfficerOverlay(input: SetOfficerOverlayInput): OfficerOverlay;
  listOfficerOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): OfficerOverlay[];
  deleteOfficerOverlay(refId: string): boolean;

  // ── Ship Overlays ─────────────────────────────────────
  getShipOverlay(refId: string): ShipOverlay | null;
  setShipOverlay(input: SetShipOverlayInput): ShipOverlay;
  listShipOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): ShipOverlay[];
  deleteShipOverlay(refId: string): boolean;

  // ── Bulk ──────────────────────────────────────────────
  bulkSetOfficerOwnership(refIds: string[], state: OwnershipState): number;
  bulkSetShipOwnership(refIds: string[], state: OwnershipState): number;
  bulkSetOfficerTarget(refIds: string[], target: boolean): number;
  bulkSetShipTarget(refIds: string[], target: boolean): number;

  // ── Diagnostics ───────────────────────────────────────
  counts(): {
    officers: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
    ships: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
  };
  getDbPath(): string;
  close(): void;
}

// ─── Helpers ────────────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "reference.db");

// ─── Implementation ─────────────────────────────────────────

export function createOverlayStore(dbPath?: string): OverlayStore {
  const resolvedPath = dbPath ?? DB_FILE;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ── Schema ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS officer_overlay (
      ref_id TEXT PRIMARY KEY,
      ownership_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
      target INTEGER NOT NULL DEFAULT 0,
      level INTEGER,
      rank TEXT,
      target_note TEXT,
      target_priority INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_officer_overlay_state ON officer_overlay(ownership_state);
    CREATE INDEX IF NOT EXISTS idx_officer_overlay_target ON officer_overlay(target) WHERE target = 1;

    CREATE TABLE IF NOT EXISTS ship_overlay (
      ref_id TEXT PRIMARY KEY,
      ownership_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
      target INTEGER NOT NULL DEFAULT 0,
      tier INTEGER,
      level INTEGER,
      target_note TEXT,
      target_priority INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ship_overlay_state ON ship_overlay(ownership_state);
    CREATE INDEX IF NOT EXISTS idx_ship_overlay_target ON ship_overlay(target) WHERE target = 1;
  `);

  // ── Migration: add power column (ADR-017) ─────────────────
  // Safe for SQLite: ADD COLUMN IF NOT EXISTS isn't supported,
  // so we check PRAGMA table_info and add only if missing.
  const officerCols = db.prepare("PRAGMA table_info(officer_overlay)").all() as { name: string }[];
  if (!officerCols.some(c => c.name === "power")) {
    db.exec("ALTER TABLE officer_overlay ADD COLUMN power INTEGER");
    log.fleet.info("migrated officer_overlay: added power column");
  }
  const shipCols = db.prepare("PRAGMA table_info(ship_overlay)").all() as { name: string }[];
  if (!shipCols.some(c => c.name === "power")) {
    db.exec("ALTER TABLE ship_overlay ADD COLUMN power INTEGER");
    log.fleet.info("migrated ship_overlay: added power column");
  }

  // ── Prepared Statements ───────────────────────────────────

  const OFFICER_SELECT = `SELECT ref_id AS refId, ownership_state AS ownershipState,
    target, level, rank, power, target_note AS targetNote,
    target_priority AS targetPriority, updated_at AS updatedAt
    FROM officer_overlay`;

  const SHIP_SELECT = `SELECT ref_id AS refId, ownership_state AS ownershipState,
    target, tier, level, power, target_note AS targetNote,
    target_priority AS targetPriority, updated_at AS updatedAt
    FROM ship_overlay`;

  const stmts = {
    // Officer overlay
    getOfficerOverlay: db.prepare(`${OFFICER_SELECT} WHERE ref_id = ?`),
    upsertOfficerOverlay: db.prepare(
      `INSERT INTO officer_overlay (ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref_id) DO UPDATE SET
         ownership_state = excluded.ownership_state,
         target = excluded.target,
         level = excluded.level,
         rank = excluded.rank,
         power = excluded.power,
         target_note = excluded.target_note,
         target_priority = excluded.target_priority,
         updated_at = excluded.updated_at`
    ),
    listOfficerOverlays: db.prepare(`${OFFICER_SELECT} ORDER BY ref_id`),
    deleteOfficerOverlay: db.prepare(`DELETE FROM officer_overlay WHERE ref_id = ?`),

    // Ship overlay
    getShipOverlay: db.prepare(`${SHIP_SELECT} WHERE ref_id = ?`),
    upsertShipOverlay: db.prepare(
      `INSERT INTO ship_overlay (ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref_id) DO UPDATE SET
         ownership_state = excluded.ownership_state,
         target = excluded.target,
         tier = excluded.tier,
         level = excluded.level,
         power = excluded.power,
         target_note = excluded.target_note,
         target_priority = excluded.target_priority,
         updated_at = excluded.updated_at`
    ),
    listShipOverlays: db.prepare(`${SHIP_SELECT} ORDER BY ref_id`),
    deleteShipOverlay: db.prepare(`DELETE FROM ship_overlay WHERE ref_id = ?`),

    // Bulk operations
    bulkUpsertOfficerOwnership: db.prepare(
      `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`
    ),
    bulkUpsertShipOwnership: db.prepare(
      `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`
    ),
    bulkUpsertOfficerTarget: db.prepare(
      `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
       VALUES (?, 'unknown', ?, ?)
       ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`
    ),
    bulkUpsertShipTarget: db.prepare(
      `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
       VALUES (?, 'unknown', ?, ?)
       ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`
    ),

    // Counts
    countOfficerOverlays: db.prepare(`SELECT COUNT(*) AS count FROM officer_overlay`),
    countOfficerOwned: db.prepare(`SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'owned'`),
    countOfficerUnowned: db.prepare(`SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unowned'`),
    countOfficerUnknown: db.prepare(`SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unknown'`),
    countOfficerTargeted: db.prepare(`SELECT COUNT(*) AS count FROM officer_overlay WHERE target = 1`),

    countShipOverlays: db.prepare(`SELECT COUNT(*) AS count FROM ship_overlay`),
    countShipOwned: db.prepare(`SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'owned'`),
    countShipUnowned: db.prepare(`SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unowned'`),
    countShipUnknown: db.prepare(`SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unknown'`),
    countShipTargeted: db.prepare(`SELECT COUNT(*) AS count FROM ship_overlay WHERE target = 1`),
  };

  // Filtered list helpers
  const listOfficerOverlaysFiltered = (filters: { ownershipState?: OwnershipState; target?: boolean }) => {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.ownershipState) { clauses.push("ownership_state = ?"); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push("target = ?"); params.push(filters.target ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`${OFFICER_SELECT} ${where} ORDER BY ref_id`).all(...params) as RawOfficerOverlay[];
  };

  const listShipOverlaysFiltered = (filters: { ownershipState?: OwnershipState; target?: boolean }) => {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.ownershipState) { clauses.push("ownership_state = ?"); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push("target = ?"); params.push(filters.target ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.prepare(`${SHIP_SELECT} ${where} ORDER BY ref_id`).all(...params) as RawShipOverlay[];
  };

  // SQLite stores booleans as 0/1 — normalize to JS booleans
  type RawOfficerOverlay = Omit<OfficerOverlay, "target"> & { target: number };
  type RawShipOverlay = Omit<ShipOverlay, "target"> & { target: number };

  function normalizeOfficerOverlay(raw: RawOfficerOverlay): OfficerOverlay {
    return { ...raw, target: raw.target === 1 };
  }

  function normalizeShipOverlay(raw: RawShipOverlay): ShipOverlay {
    return { ...raw, target: raw.target === 1 };
  }

  const store: OverlayStore = {
    // ── Officer Overlays ──────────────────────────────────

    getOfficerOverlay(refId: string): OfficerOverlay | null {
      const raw = stmts.getOfficerOverlay.get(refId) as RawOfficerOverlay | undefined;
      return raw ? normalizeOfficerOverlay(raw) : null;
    },

    setOfficerOverlay(input: SetOfficerOverlayInput): OfficerOverlay {
      const now = new Date().toISOString();
      // Merge with existing overlay if it exists
      const existing = stmts.getOfficerOverlay.get(input.refId) as RawOfficerOverlay | undefined;
      const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
      const target = input.target !== undefined ? (input.target ? 1 : 0) : (existing?.target ?? 0);
      const level = input.level !== undefined ? input.level : (existing?.level ?? null);
      const rank = input.rank !== undefined ? input.rank : (existing?.rank ?? null);
      const power = input.power !== undefined ? input.power : (existing?.power ?? null);
      const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
      const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

      stmts.upsertOfficerOverlay.run(
        input.refId, ownershipState, target, level, rank, power, targetNote, targetPriority, now,
      );
      log.fleet.debug({ refId: input.refId, ownershipState, target: target === 1 }, "officer overlay set");
      return normalizeOfficerOverlay(stmts.getOfficerOverlay.get(input.refId) as RawOfficerOverlay);
    },

    listOfficerOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): OfficerOverlay[] {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listOfficerOverlaysFiltered(filters).map(normalizeOfficerOverlay);
      }
      return (stmts.listOfficerOverlays.all() as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
    },

    deleteOfficerOverlay(refId: string): boolean {
      return stmts.deleteOfficerOverlay.run(refId).changes > 0;
    },

    // ── Ship Overlays ─────────────────────────────────────

    getShipOverlay(refId: string): ShipOverlay | null {
      const raw = stmts.getShipOverlay.get(refId) as RawShipOverlay | undefined;
      return raw ? normalizeShipOverlay(raw) : null;
    },

    setShipOverlay(input: SetShipOverlayInput): ShipOverlay {
      const now = new Date().toISOString();
      const existing = stmts.getShipOverlay.get(input.refId) as RawShipOverlay | undefined;
      const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
      const target = input.target !== undefined ? (input.target ? 1 : 0) : (existing?.target ?? 0);
      const tier = input.tier !== undefined ? input.tier : (existing?.tier ?? null);
      const level = input.level !== undefined ? input.level : (existing?.level ?? null);
      const power = input.power !== undefined ? input.power : (existing?.power ?? null);
      const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
      const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

      stmts.upsertShipOverlay.run(
        input.refId, ownershipState, target, tier, level, power, targetNote, targetPriority, now,
      );
      log.fleet.debug({ refId: input.refId, ownershipState, target: target === 1 }, "ship overlay set");
      return normalizeShipOverlay(stmts.getShipOverlay.get(input.refId) as RawShipOverlay);
    },

    listShipOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): ShipOverlay[] {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listShipOverlaysFiltered(filters).map(normalizeShipOverlay);
      }
      return (stmts.listShipOverlays.all() as RawShipOverlay[]).map(normalizeShipOverlay);
    },

    deleteShipOverlay(refId: string): boolean {
      return stmts.deleteShipOverlay.run(refId).changes > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    bulkSetOfficerOwnership(refIds: string[], state: OwnershipState): number {
      let count = 0;
      const now = new Date().toISOString();
      const txn = db.transaction(() => {
        for (const refId of refIds) {
          stmts.bulkUpsertOfficerOwnership.run(refId, state, now);
          count++;
        }
      });
      txn();
      log.fleet.info({ count, state }, "bulk set officer ownership");
      return count;
    },

    bulkSetShipOwnership(refIds: string[], state: OwnershipState): number {
      let count = 0;
      const now = new Date().toISOString();
      const txn = db.transaction(() => {
        for (const refId of refIds) {
          stmts.bulkUpsertShipOwnership.run(refId, state, now);
          count++;
        }
      });
      txn();
      log.fleet.info({ count, state }, "bulk set ship ownership");
      return count;
    },

    bulkSetOfficerTarget(refIds: string[], target: boolean): number {
      let count = 0;
      const now = new Date().toISOString();
      const txn = db.transaction(() => {
        for (const refId of refIds) {
          stmts.bulkUpsertOfficerTarget.run(refId, target ? 1 : 0, now);
          count++;
        }
      });
      txn();
      log.fleet.info({ count, target }, "bulk set officer target");
      return count;
    },

    bulkSetShipTarget(refIds: string[], target: boolean): number {
      let count = 0;
      const now = new Date().toISOString();
      const txn = db.transaction(() => {
        for (const refId of refIds) {
          stmts.bulkUpsertShipTarget.run(refId, target ? 1 : 0, now);
          count++;
        }
      });
      txn();
      log.fleet.info({ count, target }, "bulk set ship target");
      return count;
    },

    // ── Diagnostics ─────────────────────────────────────────

    counts() {
      return {
        officers: {
          total: (stmts.countOfficerOverlays.get() as { count: number }).count,
          owned: (stmts.countOfficerOwned.get() as { count: number }).count,
          unowned: (stmts.countOfficerUnowned.get() as { count: number }).count,
          unknown: (stmts.countOfficerUnknown.get() as { count: number }).count,
          targeted: (stmts.countOfficerTargeted.get() as { count: number }).count,
        },
        ships: {
          total: (stmts.countShipOverlays.get() as { count: number }).count,
          owned: (stmts.countShipOwned.get() as { count: number }).count,
          unowned: (stmts.countShipUnowned.get() as { count: number }).count,
          unknown: (stmts.countShipUnknown.get() as { count: number }).count,
          targeted: (stmts.countShipTargeted.get() as { count: number }).count,
        },
      };
    },

    getDbPath(): string {
      return resolvedPath;
    },

    close(): void {
      db.close();
    },
  };

  return store;
}
