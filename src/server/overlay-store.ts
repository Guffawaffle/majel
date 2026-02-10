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
 *
 * Migrated from better-sqlite3 to @libsql/client in ADR-018 Phase 1.
 */

import { openDatabase, initSchema, type Client } from "./db.js";
import * as path from "node:path";
import { log } from "./logger.js";

// ─── Types ──────────────────────────────────────────────────

export type OwnershipState = "unknown" | "owned" | "unowned";

export const VALID_OWNERSHIP_STATES: OwnershipState[] = ["unknown", "owned", "unowned"];

export interface OfficerOverlay {
  refId: string;
  ownershipState: OwnershipState;
  target: boolean;
  level: number | null;
  rank: string | null;
  power: number | null;
  targetNote: string | null;
  targetPriority: number | null;
  updatedAt: string;
}

export interface ShipOverlay {
  refId: string;
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
  getOfficerOverlay(refId: string): Promise<OfficerOverlay | null>;
  setOfficerOverlay(input: SetOfficerOverlayInput): Promise<OfficerOverlay>;
  listOfficerOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): Promise<OfficerOverlay[]>;
  deleteOfficerOverlay(refId: string): Promise<boolean>;

  getShipOverlay(refId: string): Promise<ShipOverlay | null>;
  setShipOverlay(input: SetShipOverlayInput): Promise<ShipOverlay>;
  listShipOverlays(filters?: { ownershipState?: OwnershipState; target?: boolean }): Promise<ShipOverlay[]>;
  deleteShipOverlay(refId: string): Promise<boolean>;

  bulkSetOfficerOwnership(refIds: string[], state: OwnershipState): Promise<number>;
  bulkSetShipOwnership(refIds: string[], state: OwnershipState): Promise<number>;
  bulkSetOfficerTarget(refIds: string[], target: boolean): Promise<number>;
  bulkSetShipTarget(refIds: string[], target: boolean): Promise<number>;

  counts(): Promise<{
    officers: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
    ships: { total: number; owned: number; unowned: number; unknown: number; targeted: number };
  }>;
  getDbPath(): string;
  close(): void;
}

// ─── Constants ──────────────────────────────────────────────

const DB_DIR = path.resolve(".smartergpt", "lex");
const DB_FILE = path.join(DB_DIR, "reference.db");

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS officer_overlay (
    ref_id TEXT PRIMARY KEY,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target INTEGER NOT NULL DEFAULT 0,
    level INTEGER,
    rank TEXT,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_state ON officer_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_target ON officer_overlay(target) WHERE target = 1`,
  `CREATE TABLE IF NOT EXISTS ship_overlay (
    ref_id TEXT PRIMARY KEY,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target INTEGER NOT NULL DEFAULT 0,
    tier INTEGER,
    level INTEGER,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_state ON ship_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_target ON ship_overlay(target) WHERE target = 1`,
];

const OFFICER_SELECT = `SELECT ref_id AS refId, ownership_state AS ownershipState,
  target, level, rank, power, target_note AS targetNote,
  target_priority AS targetPriority, updated_at AS updatedAt
  FROM officer_overlay`;

const SHIP_SELECT = `SELECT ref_id AS refId, ownership_state AS ownershipState,
  target, tier, level, power, target_note AS targetNote,
  target_priority AS targetPriority, updated_at AS updatedAt
  FROM ship_overlay`;

const SQL = {
  getOfficerOverlay: `${OFFICER_SELECT} WHERE ref_id = ?`,
  upsertOfficerOverlay: `INSERT INTO officer_overlay (ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ref_id) DO UPDATE SET
      ownership_state = excluded.ownership_state,
      target = excluded.target,
      level = excluded.level,
      rank = excluded.rank,
      power = excluded.power,
      target_note = excluded.target_note,
      target_priority = excluded.target_priority,
      updated_at = excluded.updated_at`,
  listOfficerOverlays: `${OFFICER_SELECT} ORDER BY ref_id`,
  deleteOfficerOverlay: `DELETE FROM officer_overlay WHERE ref_id = ?`,

  getShipOverlay: `${SHIP_SELECT} WHERE ref_id = ?`,
  upsertShipOverlay: `INSERT INTO ship_overlay (ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ref_id) DO UPDATE SET
      ownership_state = excluded.ownership_state,
      target = excluded.target,
      tier = excluded.tier,
      level = excluded.level,
      power = excluded.power,
      target_note = excluded.target_note,
      target_priority = excluded.target_priority,
      updated_at = excluded.updated_at`,
  listShipOverlays: `${SHIP_SELECT} ORDER BY ref_id`,
  deleteShipOverlay: `DELETE FROM ship_overlay WHERE ref_id = ?`,

  bulkUpsertOfficerOwnership: `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertShipOwnership: `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertOfficerTarget: `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
    VALUES (?, 'unknown', ?, ?)
    ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,
  bulkUpsertShipTarget: `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
    VALUES (?, 'unknown', ?, ?)
    ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,

  // Counts
  countOfficerOverlays: `SELECT COUNT(*) AS count FROM officer_overlay`,
  countOfficerOwned: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'owned'`,
  countOfficerUnowned: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unowned'`,
  countOfficerUnknown: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unknown'`,
  countOfficerTargeted: `SELECT COUNT(*) AS count FROM officer_overlay WHERE target = 1`,
  countShipOverlays: `SELECT COUNT(*) AS count FROM ship_overlay`,
  countShipOwned: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'owned'`,
  countShipUnowned: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unowned'`,
  countShipUnknown: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unknown'`,
  countShipTargeted: `SELECT COUNT(*) AS count FROM ship_overlay WHERE target = 1`,
};

// ─── Implementation ─────────────────────────────────────────

// libSQL stores booleans as 0/1 — normalize to JS booleans
type RawOfficerOverlay = Omit<OfficerOverlay, "target"> & { target: number };
type RawShipOverlay = Omit<ShipOverlay, "target"> & { target: number };

function normalizeOfficerOverlay(raw: RawOfficerOverlay): OfficerOverlay {
  return { ...raw, target: raw.target === 1 };
}

function normalizeShipOverlay(raw: RawShipOverlay): ShipOverlay {
  return { ...raw, target: raw.target === 1 };
}

export async function createOverlayStore(dbPath?: string): Promise<OverlayStore> {
  const resolvedPath = dbPath ?? DB_FILE;
  const client = openDatabase(resolvedPath);
  await initSchema(client, SCHEMA_STATEMENTS);

  log.boot.debug({ dbPath: resolvedPath }, "overlay store initialized");

  // Dynamic filtered list helpers
  async function listOfficerOverlaysFiltered(filters: { ownershipState?: OwnershipState; target?: boolean }): Promise<OfficerOverlay[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.ownershipState) { clauses.push("ownership_state = ?"); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push("target = ?"); params.push(filters.target ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await client.execute({
      sql: `${OFFICER_SELECT} ${where} ORDER BY ref_id`,
      args: params,
    });
    return (result.rows as unknown as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
  }

  async function listShipOverlaysFiltered(filters: { ownershipState?: OwnershipState; target?: boolean }): Promise<ShipOverlay[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filters.ownershipState) { clauses.push("ownership_state = ?"); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push("target = ?"); params.push(filters.target ? 1 : 0); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await client.execute({
      sql: `${SHIP_SELECT} ${where} ORDER BY ref_id`,
      args: params,
    });
    return (result.rows as unknown as RawShipOverlay[]).map(normalizeShipOverlay);
  }

  const store: OverlayStore = {
    // ── Officer Overlays ──────────────────────────────────

    async getOfficerOverlay(refId) {
      const result = await client.execute({ sql: SQL.getOfficerOverlay, args: [refId] });
      const raw = result.rows[0] as unknown as RawOfficerOverlay | undefined;
      return raw ? normalizeOfficerOverlay(raw) : null;
    },

    async setOfficerOverlay(input) {
      const tx = await client.transaction("write");
      try {
        const now = new Date().toISOString();
        const existingRes = await tx.execute({ sql: SQL.getOfficerOverlay, args: [input.refId] });
        const existing = existingRes.rows[0] as unknown as RawOfficerOverlay | undefined;

        const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
        const target = input.target !== undefined ? (input.target ? 1 : 0) : (existing?.target ?? 0);
        const level = input.level !== undefined ? input.level : (existing?.level ?? null);
        const rank = input.rank !== undefined ? input.rank : (existing?.rank ?? null);
        const power = input.power !== undefined ? input.power : (existing?.power ?? null);
        const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
        const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

        await tx.execute({
          sql: SQL.upsertOfficerOverlay,
          args: [input.refId, ownershipState, target, level, rank, power, targetNote, targetPriority, now],
        });

        const readResult = await tx.execute({ sql: SQL.getOfficerOverlay, args: [input.refId] });
        await tx.commit();

        log.fleet.debug({ refId: input.refId, ownershipState, target: target === 1 }, "officer overlay set");
        return normalizeOfficerOverlay(readResult.rows[0] as unknown as RawOfficerOverlay);
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    },

    async listOfficerOverlays(filters?) {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listOfficerOverlaysFiltered(filters);
      }
      const result = await client.execute(SQL.listOfficerOverlays);
      return (result.rows as unknown as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
    },

    async deleteOfficerOverlay(refId) {
      const result = await client.execute({ sql: SQL.deleteOfficerOverlay, args: [refId] });
      return result.rowsAffected > 0;
    },

    // ── Ship Overlays ─────────────────────────────────────

    async getShipOverlay(refId) {
      const result = await client.execute({ sql: SQL.getShipOverlay, args: [refId] });
      const raw = result.rows[0] as unknown as RawShipOverlay | undefined;
      return raw ? normalizeShipOverlay(raw) : null;
    },

    async setShipOverlay(input) {
      const tx = await client.transaction("write");
      try {
        const now = new Date().toISOString();
        const existingRes = await tx.execute({ sql: SQL.getShipOverlay, args: [input.refId] });
        const existing = existingRes.rows[0] as unknown as RawShipOverlay | undefined;

        const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
        const target = input.target !== undefined ? (input.target ? 1 : 0) : (existing?.target ?? 0);
        const tier = input.tier !== undefined ? input.tier : (existing?.tier ?? null);
        const level = input.level !== undefined ? input.level : (existing?.level ?? null);
        const power = input.power !== undefined ? input.power : (existing?.power ?? null);
        const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
        const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

        await tx.execute({
          sql: SQL.upsertShipOverlay,
          args: [input.refId, ownershipState, target, tier, level, power, targetNote, targetPriority, now],
        });

        const readResult = await tx.execute({ sql: SQL.getShipOverlay, args: [input.refId] });
        await tx.commit();

        log.fleet.debug({ refId: input.refId, ownershipState, target: target === 1 }, "ship overlay set");
        return normalizeShipOverlay(readResult.rows[0] as unknown as RawShipOverlay);
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    },

    async listShipOverlays(filters?) {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listShipOverlaysFiltered(filters);
      }
      const result = await client.execute(SQL.listShipOverlays);
      return (result.rows as unknown as RawShipOverlay[]).map(normalizeShipOverlay);
    },

    async deleteShipOverlay(refId) {
      const result = await client.execute({ sql: SQL.deleteShipOverlay, args: [refId] });
      return result.rowsAffected > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    async bulkSetOfficerOwnership(refIds, state) {
      const now = new Date().toISOString();
      const tx = await client.transaction("write");
      try {
        for (const refId of refIds) {
          await tx.execute({ sql: SQL.bulkUpsertOfficerOwnership, args: [refId, state, now] });
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ count: refIds.length, state }, "bulk set officer ownership");
      return refIds.length;
    },

    async bulkSetShipOwnership(refIds, state) {
      const now = new Date().toISOString();
      const tx = await client.transaction("write");
      try {
        for (const refId of refIds) {
          await tx.execute({ sql: SQL.bulkUpsertShipOwnership, args: [refId, state, now] });
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ count: refIds.length, state }, "bulk set ship ownership");
      return refIds.length;
    },

    async bulkSetOfficerTarget(refIds, target) {
      const now = new Date().toISOString();
      const tx = await client.transaction("write");
      try {
        for (const refId of refIds) {
          await tx.execute({ sql: SQL.bulkUpsertOfficerTarget, args: [refId, target ? 1 : 0, now] });
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ count: refIds.length, target }, "bulk set officer target");
      return refIds.length;
    },

    async bulkSetShipTarget(refIds, target) {
      const now = new Date().toISOString();
      const tx = await client.transaction("write");
      try {
        for (const refId of refIds) {
          await tx.execute({ sql: SQL.bulkUpsertShipTarget, args: [refId, target ? 1 : 0, now] });
        }
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
      log.fleet.info({ count: refIds.length, target }, "bulk set ship target");
      return refIds.length;
    },

    // ── Diagnostics ─────────────────────────────────────────

    async counts() {
      const [oTotal, oOwned, oUnowned, oUnknown, oTargeted,
             sTotal, sOwned, sUnowned, sUnknown, sTargeted] = await Promise.all([
        client.execute(SQL.countOfficerOverlays),
        client.execute(SQL.countOfficerOwned),
        client.execute(SQL.countOfficerUnowned),
        client.execute(SQL.countOfficerUnknown),
        client.execute(SQL.countOfficerTargeted),
        client.execute(SQL.countShipOverlays),
        client.execute(SQL.countShipOwned),
        client.execute(SQL.countShipUnowned),
        client.execute(SQL.countShipUnknown),
        client.execute(SQL.countShipTargeted),
      ]);
      const c = (r: { rows: unknown[] }) => (r.rows[0] as { count: number }).count;
      return {
        officers: {
          total: c(oTotal), owned: c(oOwned), unowned: c(oUnowned),
          unknown: c(oUnknown), targeted: c(oTargeted),
        },
        ships: {
          total: c(sTotal), owned: c(sOwned), unowned: c(sUnowned),
          unknown: c(sUnknown), targeted: c(sTargeted),
        },
      };
    },

    getDbPath() {
      return resolvedPath;
    },

    close() {
      client.close();
    },
  };

  return store;
}
