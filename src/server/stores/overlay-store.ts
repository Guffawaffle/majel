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
 * - Uses the same PostgreSQL database as reference-store.ts (shared DB, separate tables)
 *
 * Migrated from @libsql/client to PostgreSQL (pg) in ADR-018 Phase 3.
 */

import { initSchema, withTransaction, type Pool } from "../db.js";
import { log } from "../logger.js";

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
  close(): void;
}

// ─── SQL ────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS officer_overlay (
    ref_id TEXT PRIMARY KEY,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target BOOLEAN NOT NULL DEFAULT FALSE,
    level INTEGER,
    rank TEXT,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_state ON officer_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_target ON officer_overlay(target) WHERE target = TRUE`,
  `CREATE TABLE IF NOT EXISTS ship_overlay (
    ref_id TEXT PRIMARY KEY,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target BOOLEAN NOT NULL DEFAULT FALSE,
    tier INTEGER,
    level INTEGER,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_state ON ship_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_target ON ship_overlay(target) WHERE target = TRUE`,
];

const OFFICER_SELECT = `SELECT ref_id AS "refId", ownership_state AS "ownershipState",
  target, level, rank, power, target_note AS "targetNote",
  target_priority AS "targetPriority", updated_at AS "updatedAt"
  FROM officer_overlay`;

const SHIP_SELECT = `SELECT ref_id AS "refId", ownership_state AS "ownershipState",
  target, tier, level, power, target_note AS "targetNote",
  target_priority AS "targetPriority", updated_at AS "updatedAt"
  FROM ship_overlay`;

const SQL = {
  getOfficerOverlay: `${OFFICER_SELECT} WHERE ref_id = $1`,
  upsertOfficerOverlay: `INSERT INTO officer_overlay (ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
  deleteOfficerOverlay: `DELETE FROM officer_overlay WHERE ref_id = $1`,

  getShipOverlay: `${SHIP_SELECT} WHERE ref_id = $1`,
  upsertShipOverlay: `INSERT INTO ship_overlay (ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
  deleteShipOverlay: `DELETE FROM ship_overlay WHERE ref_id = $1`,

  bulkUpsertOfficerOwnership: `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, FALSE, $3)
    ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertShipOwnership: `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, FALSE, $3)
    ON CONFLICT(ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertOfficerTarget: `INSERT INTO officer_overlay (ref_id, ownership_state, target, updated_at)
    VALUES ($1, 'unknown', $2, $3)
    ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,
  bulkUpsertShipTarget: `INSERT INTO ship_overlay (ref_id, ownership_state, target, updated_at)
    VALUES ($1, 'unknown', $2, $3)
    ON CONFLICT(ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,

  // Counts
  countOfficerOverlays: `SELECT COUNT(*) AS count FROM officer_overlay`,
  countOfficerOwned: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'owned'`,
  countOfficerUnowned: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unowned'`,
  countOfficerUnknown: `SELECT COUNT(*) AS count FROM officer_overlay WHERE ownership_state = 'unknown'`,
  countOfficerTargeted: `SELECT COUNT(*) AS count FROM officer_overlay WHERE target = TRUE`,
  countShipOverlays: `SELECT COUNT(*) AS count FROM ship_overlay`,
  countShipOwned: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'owned'`,
  countShipUnowned: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unowned'`,
  countShipUnknown: `SELECT COUNT(*) AS count FROM ship_overlay WHERE ownership_state = 'unknown'`,
  countShipTargeted: `SELECT COUNT(*) AS count FROM ship_overlay WHERE target = TRUE`,
};

// ─── Implementation ─────────────────────────────────────────

// PostgreSQL returns native booleans — normalize for safety
type RawOfficerOverlay = Omit<OfficerOverlay, "target"> & { target: number | boolean };
type RawShipOverlay = Omit<ShipOverlay, "target"> & { target: number | boolean };

function normalizeOfficerOverlay(raw: RawOfficerOverlay): OfficerOverlay {
  return { ...raw, target: Boolean(raw.target) };
}

function normalizeShipOverlay(raw: RawShipOverlay): ShipOverlay {
  return { ...raw, target: Boolean(raw.target) };
}

export async function createOverlayStore(pool: Pool): Promise<OverlayStore> {
  await initSchema(pool, SCHEMA_STATEMENTS);

  log.boot.debug("overlay store initialized");

  // Dynamic filtered list helpers
  async function listOfficerOverlaysFiltered(filters: { ownershipState?: OwnershipState; target?: boolean }): Promise<OfficerOverlay[]> {
    const clauses: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIdx = 1;
    if (filters.ownershipState) { clauses.push(`ownership_state = $${paramIdx++}`); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push(`target = $${paramIdx++}`); params.push(filters.target); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `${OFFICER_SELECT} ${where} ORDER BY ref_id`,
      params,
    );
    return (result.rows as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
  }

  async function listShipOverlaysFiltered(filters: { ownershipState?: OwnershipState; target?: boolean }): Promise<ShipOverlay[]> {
    const clauses: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIdx = 1;
    if (filters.ownershipState) { clauses.push(`ownership_state = $${paramIdx++}`); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push(`target = $${paramIdx++}`); params.push(filters.target); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `${SHIP_SELECT} ${where} ORDER BY ref_id`,
      params,
    );
    return (result.rows as RawShipOverlay[]).map(normalizeShipOverlay);
  }

  const store: OverlayStore = {
    // ── Officer Overlays ──────────────────────────────────

    async getOfficerOverlay(refId) {
      const result = await pool.query(SQL.getOfficerOverlay, [refId]);
      const raw = result.rows[0] as RawOfficerOverlay | undefined;
      return raw ? normalizeOfficerOverlay(raw) : null;
    },

    async setOfficerOverlay(input) {
      return await withTransaction(pool, async (client) => {
        const now = new Date().toISOString();
        const existingRes = await client.query(SQL.getOfficerOverlay, [input.refId]);
        const existing = existingRes.rows[0] as RawOfficerOverlay | undefined;

        const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
        const target = input.target !== undefined ? input.target : (existing?.target ?? false);
        const level = input.level !== undefined ? input.level : (existing?.level ?? null);
        const rank = input.rank !== undefined ? input.rank : (existing?.rank ?? null);
        const power = input.power !== undefined ? input.power : (existing?.power ?? null);
        const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
        const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

        await client.query(SQL.upsertOfficerOverlay, [input.refId, ownershipState, target, level, rank, power, targetNote, targetPriority, now]);

        const readResult = await client.query(SQL.getOfficerOverlay, [input.refId]);

        log.fleet.debug({ refId: input.refId, ownershipState, target: Boolean(target) }, "officer overlay set");
        return normalizeOfficerOverlay(readResult.rows[0] as RawOfficerOverlay);
      });
    },

    async listOfficerOverlays(filters?) {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listOfficerOverlaysFiltered(filters);
      }
      const result = await pool.query(SQL.listOfficerOverlays);
      return (result.rows as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
    },

    async deleteOfficerOverlay(refId) {
      const result = await pool.query(SQL.deleteOfficerOverlay, [refId]);
      return (result.rowCount ?? 0) > 0;
    },

    // ── Ship Overlays ─────────────────────────────────────

    async getShipOverlay(refId) {
      const result = await pool.query(SQL.getShipOverlay, [refId]);
      const raw = result.rows[0] as RawShipOverlay | undefined;
      return raw ? normalizeShipOverlay(raw) : null;
    },

    async setShipOverlay(input) {
      return await withTransaction(pool, async (client) => {
        const now = new Date().toISOString();
        const existingRes = await client.query(SQL.getShipOverlay, [input.refId]);
        const existing = existingRes.rows[0] as RawShipOverlay | undefined;

        const ownershipState = input.ownershipState ?? existing?.ownershipState ?? "unknown";
        const target = input.target !== undefined ? input.target : (existing?.target ?? false);
        const tier = input.tier !== undefined ? input.tier : (existing?.tier ?? null);
        const level = input.level !== undefined ? input.level : (existing?.level ?? null);
        const power = input.power !== undefined ? input.power : (existing?.power ?? null);
        const targetNote = input.targetNote !== undefined ? input.targetNote : (existing?.targetNote ?? null);
        const targetPriority = input.targetPriority !== undefined ? input.targetPriority : (existing?.targetPriority ?? null);

        await client.query(SQL.upsertShipOverlay, [input.refId, ownershipState, target, tier, level, power, targetNote, targetPriority, now]);

        const readResult = await client.query(SQL.getShipOverlay, [input.refId]);

        log.fleet.debug({ refId: input.refId, ownershipState, target: Boolean(target) }, "ship overlay set");
        return normalizeShipOverlay(readResult.rows[0] as RawShipOverlay);
      });
    },

    async listShipOverlays(filters?) {
      if (filters && (filters.ownershipState || filters.target !== undefined)) {
        return listShipOverlaysFiltered(filters);
      }
      const result = await pool.query(SQL.listShipOverlays);
      return (result.rows as RawShipOverlay[]).map(normalizeShipOverlay);
    },

    async deleteShipOverlay(refId) {
      const result = await pool.query(SQL.deleteShipOverlay, [refId]);
      return (result.rowCount ?? 0) > 0;
    },

    // ── Bulk ──────────────────────────────────────────────

    async bulkSetOfficerOwnership(refIds, state) {
      const now = new Date().toISOString();
      await withTransaction(pool, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertOfficerOwnership, [refId, state, now]);
        }
      });
      log.fleet.info({ count: refIds.length, state }, "bulk set officer ownership");
      return refIds.length;
    },

    async bulkSetShipOwnership(refIds, state) {
      const now = new Date().toISOString();
      await withTransaction(pool, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertShipOwnership, [refId, state, now]);
        }
      });
      log.fleet.info({ count: refIds.length, state }, "bulk set ship ownership");
      return refIds.length;
    },

    async bulkSetOfficerTarget(refIds, target) {
      const now = new Date().toISOString();
      await withTransaction(pool, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertOfficerTarget, [refId, target, now]);
        }
      });
      log.fleet.info({ count: refIds.length, target }, "bulk set officer target");
      return refIds.length;
    },

    async bulkSetShipTarget(refIds, target) {
      const now = new Date().toISOString();
      await withTransaction(pool, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertShipTarget, [refId, target, now]);
        }
      });
      log.fleet.info({ count: refIds.length, target }, "bulk set ship target");
      return refIds.length;
    },

    // ── Diagnostics ─────────────────────────────────────────

    async counts() {
      const [oTotal, oOwned, oUnowned, oUnknown, oTargeted,
             sTotal, sOwned, sUnowned, sUnknown, sTargeted] = await Promise.all([
        pool.query(SQL.countOfficerOverlays),
        pool.query(SQL.countOfficerOwned),
        pool.query(SQL.countOfficerUnowned),
        pool.query(SQL.countOfficerUnknown),
        pool.query(SQL.countOfficerTargeted),
        pool.query(SQL.countShipOverlays),
        pool.query(SQL.countShipOwned),
        pool.query(SQL.countShipUnowned),
        pool.query(SQL.countShipUnknown),
        pool.query(SQL.countShipTargeted),
      ]);
      const c = (r: { rows: Record<string, unknown>[] }) => Number((r.rows[0] as { count: string }).count);
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

    close() {
      /* pool managed externally */
    },
  };

  return store;
}
