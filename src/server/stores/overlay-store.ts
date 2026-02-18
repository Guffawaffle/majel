/**
 * overlay-store.ts — User Ownership & Target Overlay (ADR-016 D2, #85)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Thin overlay on reference catalog entries. Stores the user's personal
 * relationship to each entity: ownership state, targeting, level, rank.
 *
 * The reference data (abilities, rarity, group) lives in reference-store.ts.
 * This module stores ONLY user-specific state, keyed by (user_id, ref_id).
 *
 * Design choices (from ADR-016):
 * - ownership_state is three-state: 'unknown' | 'owned' | 'unowned'
 * - target is independent of ownership (owned + targeted is valid)
 * - Overlay rows are created on first interaction (no row = unknown/not targeted)
 * - Uses the same PostgreSQL database as reference-store.ts (shared DB, separate tables)
 *
 * Security (#85):
 * - user_id column on every row — each user has their own overlay
 * - RLS policies enforce isolation at the database level
 * - Application-level user_id included in all INSERTs (belt-and-suspenders)
 * - OverlayStoreFactory produces user-scoped stores via forUser(userId)
 *
 * Migrated from @libsql/client to PostgreSQL (pg) in ADR-018 Phase 3.
 * User isolation added in #85.
 */

import { initSchema, withUserScope, withUserRead, type Pool, type PoolClient } from "../db.js";
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

// ─── Schema (#85: user_id + RLS) ────────────────────────────

const SCHEMA_STATEMENTS = [
  // Fresh install: tables with user_id + composite PK
  `CREATE TABLE IF NOT EXISTS officer_overlay (
    user_id TEXT NOT NULL DEFAULT 'local',
    ref_id TEXT NOT NULL,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target BOOLEAN NOT NULL DEFAULT FALSE,
    level INTEGER,
    rank TEXT,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, ref_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_state ON officer_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_target ON officer_overlay(target) WHERE target = TRUE`,

  `CREATE TABLE IF NOT EXISTS ship_overlay (
    user_id TEXT NOT NULL DEFAULT 'local',
    ref_id TEXT NOT NULL,
    ownership_state TEXT NOT NULL DEFAULT 'unknown'
      CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
    target BOOLEAN NOT NULL DEFAULT FALSE,
    tier INTEGER,
    level INTEGER,
    power INTEGER,
    target_note TEXT,
    target_priority INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, ref_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_state ON ship_overlay(ownership_state)`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_target ON ship_overlay(target) WHERE target = TRUE`,

  // Migration: add user_id to existing tables that lack it
  `DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'officer_overlay'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'officer_overlay' AND column_name = 'user_id'
    ) THEN
      ALTER TABLE officer_overlay ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE officer_overlay DROP CONSTRAINT IF EXISTS officer_overlay_pkey;
      ALTER TABLE officer_overlay ADD PRIMARY KEY (user_id, ref_id);
    END IF;
  END $$`,

  `DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'ship_overlay'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'ship_overlay' AND column_name = 'user_id'
    ) THEN
      ALTER TABLE ship_overlay ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE ship_overlay DROP CONSTRAINT IF EXISTS ship_overlay_pkey;
      ALTER TABLE ship_overlay ADD PRIMARY KEY (user_id, ref_id);
    END IF;
  END $$`,

  // user_id indexes (must come AFTER migration adds the column)
  `CREATE INDEX IF NOT EXISTS idx_officer_overlay_user ON officer_overlay(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ship_overlay_user ON ship_overlay(user_id)`,

  // RLS policies
  `ALTER TABLE officer_overlay ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE officer_overlay FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'officer_overlay' AND policyname = 'officer_overlay_user_isolation'
    ) THEN
      CREATE POLICY officer_overlay_user_isolation ON officer_overlay
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,

  `ALTER TABLE ship_overlay ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ship_overlay FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'ship_overlay' AND policyname = 'ship_overlay_user_isolation'
    ) THEN
      CREATE POLICY ship_overlay_user_isolation ON ship_overlay
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

// ─── SQL ────────────────────────────────────────────────────

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
  upsertOfficerOverlay: `INSERT INTO officer_overlay (user_id, ref_id, ownership_state, target, level, rank, power, target_note, target_priority, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET
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
  upsertShipOverlay: `INSERT INTO ship_overlay (user_id, ref_id, ownership_state, target, tier, level, power, target_note, target_priority, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET
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

  bulkUpsertOfficerOwnership: `INSERT INTO officer_overlay (user_id, ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, $3, FALSE, $4)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertShipOwnership: `INSERT INTO ship_overlay (user_id, ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, $3, FALSE, $4)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET ownership_state = excluded.ownership_state, updated_at = excluded.updated_at`,
  bulkUpsertOfficerTarget: `INSERT INTO officer_overlay (user_id, ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, 'unknown', $3, $4)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,
  bulkUpsertShipTarget: `INSERT INTO ship_overlay (user_id, ref_id, ownership_state, target, updated_at)
    VALUES ($1, $2, 'unknown', $3, $4)
    ON CONFLICT(user_id, ref_id) DO UPDATE SET target = excluded.target, updated_at = excluded.updated_at`,

  countOfficers: `SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ownership_state = 'owned') AS owned,
    COUNT(*) FILTER (WHERE ownership_state = 'unowned') AS unowned,
    COUNT(*) FILTER (WHERE ownership_state = 'unknown') AS unknown_state,
    COUNT(*) FILTER (WHERE target = TRUE) AS targeted
    FROM officer_overlay`,
  countShips: `SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE ownership_state = 'owned') AS owned,
    COUNT(*) FILTER (WHERE ownership_state = 'unowned') AS unowned,
    COUNT(*) FILTER (WHERE ownership_state = 'unknown') AS unknown_state,
    COUNT(*) FILTER (WHERE target = TRUE) AS targeted
    FROM ship_overlay`,
};

// ─── Implementation ─────────────────────────────────────────

type RawOfficerOverlay = Omit<OfficerOverlay, "target"> & { target: number | boolean };
type RawShipOverlay = Omit<ShipOverlay, "target"> & { target: number | boolean };

function normalizeOfficerOverlay(raw: RawOfficerOverlay): OfficerOverlay {
  return { ...raw, target: Boolean(raw.target) };
}

function normalizeShipOverlay(raw: RawShipOverlay): ShipOverlay {
  return { ...raw, target: Boolean(raw.target) };
}

function createScopedOverlayStore(pool: Pool, userId: string): OverlayStore {

  function buildOfficerFilterQuery(filters: { ownershipState?: OwnershipState; target?: boolean }): { sql: string; params: (string | boolean)[] } {
    const clauses: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIdx = 1;
    if (filters.ownershipState) { clauses.push(`ownership_state = $${paramIdx++}`); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push(`target = $${paramIdx++}`); params.push(filters.target); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return { sql: `${OFFICER_SELECT} ${where} ORDER BY ref_id`, params };
  }

  function buildShipFilterQuery(filters: { ownershipState?: OwnershipState; target?: boolean }): { sql: string; params: (string | boolean)[] } {
    const clauses: string[] = [];
    const params: (string | boolean)[] = [];
    let paramIdx = 1;
    if (filters.ownershipState) { clauses.push(`ownership_state = $${paramIdx++}`); params.push(filters.ownershipState); }
    if (filters.target !== undefined) { clauses.push(`target = $${paramIdx++}`); params.push(filters.target); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return { sql: `${SHIP_SELECT} ${where} ORDER BY ref_id`, params };
  }

  return {
    async getOfficerOverlay(refId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.getOfficerOverlay, [refId]);
        const raw = result.rows[0] as RawOfficerOverlay | undefined;
        return raw ? normalizeOfficerOverlay(raw) : null;
      });
    },

    async setOfficerOverlay(input) {
      return withUserScope(pool, userId, async (client) => {
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

        await client.query(SQL.upsertOfficerOverlay, [userId, input.refId, ownershipState, target, level, rank, power, targetNote, targetPriority, now]);
        const readResult = await client.query(SQL.getOfficerOverlay, [input.refId]);

        log.fleet.debug({ refId: input.refId, ownershipState, target: Boolean(target), userId }, "officer overlay set");
        return normalizeOfficerOverlay(readResult.rows[0] as RawOfficerOverlay);
      });
    },

    async listOfficerOverlays(filters?) {
      return withUserRead(pool, userId, async (client) => {
        if (filters && (filters.ownershipState || filters.target !== undefined)) {
          const { sql, params } = buildOfficerFilterQuery(filters);
          const result = await client.query(sql, params);
          return (result.rows as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
        }
        const result = await client.query(SQL.listOfficerOverlays);
        return (result.rows as RawOfficerOverlay[]).map(normalizeOfficerOverlay);
      });
    },

    async deleteOfficerOverlay(refId) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(SQL.deleteOfficerOverlay, [refId]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async getShipOverlay(refId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.getShipOverlay, [refId]);
        const raw = result.rows[0] as RawShipOverlay | undefined;
        return raw ? normalizeShipOverlay(raw) : null;
      });
    },

    async setShipOverlay(input) {
      return withUserScope(pool, userId, async (client) => {
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

        await client.query(SQL.upsertShipOverlay, [userId, input.refId, ownershipState, target, tier, level, power, targetNote, targetPriority, now]);
        const readResult = await client.query(SQL.getShipOverlay, [input.refId]);

        log.fleet.debug({ refId: input.refId, ownershipState, target: Boolean(target), userId }, "ship overlay set");
        return normalizeShipOverlay(readResult.rows[0] as RawShipOverlay);
      });
    },

    async listShipOverlays(filters?) {
      return withUserRead(pool, userId, async (client) => {
        if (filters && (filters.ownershipState || filters.target !== undefined)) {
          const { sql, params } = buildShipFilterQuery(filters);
          const result = await client.query(sql, params);
          return (result.rows as RawShipOverlay[]).map(normalizeShipOverlay);
        }
        const result = await client.query(SQL.listShipOverlays);
        return (result.rows as RawShipOverlay[]).map(normalizeShipOverlay);
      });
    },

    async deleteShipOverlay(refId) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(SQL.deleteShipOverlay, [refId]);
        return (result.rowCount ?? 0) > 0;
      });
    },

    async bulkSetOfficerOwnership(refIds, state) {
      const now = new Date().toISOString();
      return withUserScope(pool, userId, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertOfficerOwnership, [userId, refId, state, now]);
        }
        log.fleet.info({ count: refIds.length, state, userId }, "bulk set officer ownership");
        return refIds.length;
      });
    },

    async bulkSetShipOwnership(refIds, state) {
      const now = new Date().toISOString();
      return withUserScope(pool, userId, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertShipOwnership, [userId, refId, state, now]);
        }
        log.fleet.info({ count: refIds.length, state, userId }, "bulk set ship ownership");
        return refIds.length;
      });
    },

    async bulkSetOfficerTarget(refIds, target) {
      const now = new Date().toISOString();
      return withUserScope(pool, userId, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertOfficerTarget, [userId, refId, target, now]);
        }
        log.fleet.info({ count: refIds.length, target, userId }, "bulk set officer target");
        return refIds.length;
      });
    },

    async bulkSetShipTarget(refIds, target) {
      const now = new Date().toISOString();
      return withUserScope(pool, userId, async (client) => {
        for (const refId of refIds) {
          await client.query(SQL.bulkUpsertShipTarget, [userId, refId, target, now]);
        }
        log.fleet.info({ count: refIds.length, target, userId }, "bulk set ship target");
        return refIds.length;
      });
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const officerResult = await client.query(SQL.countOfficers);
        const shipResult = await client.query(SQL.countShips);
        const o = officerResult.rows[0] as Record<string, string>;
        const s = shipResult.rows[0] as Record<string, string>;
        return {
          officers: {
            total: Number(o.total), owned: Number(o.owned), unowned: Number(o.unowned),
            unknown: Number(o.unknown_state), targeted: Number(o.targeted),
          },
          ships: {
            total: Number(s.total), owned: Number(s.owned), unowned: Number(s.unowned),
            unknown: Number(s.unknown_state), targeted: Number(s.targeted),
          },
        };
      });
    },

    close() {
      /* pool managed externally */
    },
  };
}

// ─── Factory (#85) ──────────────────────────────────────────

export class OverlayStoreFactory {
  constructor(private pool: Pool) {}

  forUser(userId: string): OverlayStore {
    return createScopedOverlayStore(this.pool, userId);
  }
}

export async function createOverlayStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<OverlayStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;
  log.boot.debug("overlay store initialized (user-scoped, RLS)");
  return new OverlayStoreFactory(pool);
}

/** Backward-compatible: returns a store scoped to "local" user. */
export async function createOverlayStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<OverlayStore> {
  const factory = await createOverlayStoreFactory(adminPool, runtimePool);
  return factory.forUser("local");
}
