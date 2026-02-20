/**
 * target-store.ts — Structured target/goal tracking store (#17, #85)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages structured acquisition and progression targets for officers,
 * ships, and crew loadouts. Complements the overlay's simple `target`
 * boolean with specific goals, progress tracking, and model-suggested targets.
 *
 * Security (#85):
 * - user_id column on every row — each user has their own targets
 * - RLS policies enforce isolation at the database level
 * - TargetStoreFactory produces user-scoped stores via forUser(userId)
 *
 * Three target types:
 * - officer: acquire or upgrade a specific officer
 * - ship: build or tier a specific ship
 * - crew: assemble a specific loadout (links to loadout_id)
 */

import { initSchema, withUserScope, withUserRead, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

export type TargetType = "officer" | "ship" | "crew";
export type TargetStatus = "active" | "achieved" | "abandoned";

export const VALID_TARGET_TYPES: TargetType[] = ["officer", "ship", "crew"];
export const VALID_TARGET_STATUSES: TargetStatus[] = ["active", "achieved", "abandoned"];

export interface Target {
  id: number;
  targetType: TargetType;
  refId: string | null;
  loadoutId: number | null;
  targetTier: number | null;
  targetRank: string | null;
  targetLevel: number | null;
  reason: string | null;
  priority: number;
  status: TargetStatus;
  autoSuggested: boolean;
  createdAt: string;
  updatedAt: string;
  achievedAt: string | null;
}

export interface CreateTargetInput {
  targetType: TargetType;
  refId?: string | null;
  loadoutId?: number | null;
  targetTier?: number | null;
  targetRank?: string | null;
  targetLevel?: number | null;
  reason?: string | null;
  priority?: number;
  autoSuggested?: boolean;
}

export interface UpdateTargetInput {
  targetTier?: number | null;
  targetRank?: string | null;
  targetLevel?: number | null;
  reason?: string | null;
  priority?: number;
  status?: TargetStatus;
}

// ─── Store Interface ────────────────────────────────────────

export interface TargetStore {
  list(filters?: {
    targetType?: TargetType;
    status?: TargetStatus;
    priority?: number;
    refId?: string;
  }): Promise<Target[]>;
  get(id: number): Promise<Target | null>;
  create(input: CreateTargetInput): Promise<Target>;
  update(id: number, fields: UpdateTargetInput): Promise<Target | null>;
  delete(id: number): Promise<boolean>;
  markAchieved(id: number): Promise<Target | null>;
  listByRef(refId: string): Promise<Target[]>;
  counts(): Promise<{
    total: number;
    active: number;
    achieved: number;
    abandoned: number;
    byType: { officer: number; ship: number; crew: number };
  }>;
  close(): void;
}

// ─── Schema (#85: user_id + RLS) ────────────────────────────

const SCHEMA_STATEMENTS = [
  // Fresh install: table with user_id
  `CREATE TABLE IF NOT EXISTS targets (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    target_type TEXT NOT NULL CHECK (target_type IN ('officer', 'ship', 'crew')),
    ref_id TEXT,
    loadout_id INTEGER,
    target_tier INTEGER,
    target_rank TEXT,
    target_level INTEGER,
    reason TEXT,
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
    auto_suggested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    achieved_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_targets_type ON targets(target_type)`,
  `CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_targets_ref_id ON targets(ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_targets_priority ON targets(priority)`,

  // Migration: add user_id to existing tables that lack it
  `DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_name = 'targets'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'targets' AND column_name = 'user_id'
    ) THEN
      ALTER TABLE targets ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    END IF;
  END $$`,

  // user_id index (must come AFTER migration adds the column)
  `CREATE INDEX IF NOT EXISTS idx_targets_user ON targets(user_id)`,

  // RLS policies
  `ALTER TABLE targets ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE targets FORCE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'targets' AND policyname = 'targets_user_isolation'
    ) THEN
      CREATE POLICY targets_user_isolation ON targets
        USING (user_id = current_setting('app.current_user_id', true))
        WITH CHECK (user_id = current_setting('app.current_user_id', true));
    END IF;
  END $$`,
];

// ─── SQL ────────────────────────────────────────────────────

const COLS = `id, target_type, ref_id, loadout_id, target_tier, target_rank, target_level,
  reason, priority, status, auto_suggested, created_at, updated_at, achieved_at`;

const SQL = {
  list: `SELECT ${COLS} FROM targets ORDER BY priority ASC, created_at DESC`,
  listByRefId: `SELECT ${COLS} FROM targets WHERE ref_id = $1 ORDER BY priority ASC, created_at DESC`,
  get: `SELECT ${COLS} FROM targets WHERE id = $1`,
  create: `INSERT INTO targets (user_id, target_type, ref_id, loadout_id, target_tier, target_rank, target_level, reason, priority, auto_suggested)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING ${COLS}`,
  delete: `DELETE FROM targets WHERE id = $1`,
  markAchieved: `UPDATE targets SET status = 'achieved', achieved_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING ${COLS}`,
  counts: `SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE status = 'active') AS active,
    COUNT(*) FILTER (WHERE status = 'achieved') AS achieved,
    COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
    COUNT(*) FILTER (WHERE target_type = 'officer') AS type_officer,
    COUNT(*) FILTER (WHERE target_type = 'ship') AS type_ship,
    COUNT(*) FILTER (WHERE target_type = 'crew') AS type_crew
    FROM targets`,
};

// ─── Row Mapper ─────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): Target {
  return {
    id: row.id as number,
    targetType: row.target_type as TargetType,
    refId: row.ref_id as string | null,
    loadoutId: row.loadout_id as number | null,
    targetTier: row.target_tier as number | null,
    targetRank: row.target_rank as string | null,
    targetLevel: row.target_level as number | null,
    reason: row.reason as string | null,
    priority: row.priority as number,
    status: row.status as TargetStatus,
    autoSuggested: row.auto_suggested as boolean,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    achievedAt: row.achieved_at ? (row.achieved_at as Date).toISOString() : null,
  };
}

// ─── Filtered Queries ───────────────────────────────────────

function buildFilterQuery(
  filters: { targetType?: TargetType; status?: TargetStatus; priority?: number; refId?: string },
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.targetType) {
    params.push(filters.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.priority) {
    params.push(filters.priority);
    conditions.push(`priority = $${params.length}`);
  }
  if (filters.refId) {
    params.push(filters.refId);
    conditions.push(`ref_id = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { sql: `SELECT ${COLS} FROM targets ${where} ORDER BY priority ASC, created_at DESC`, params };
}

// ─── Scoped Store Implementation ────────────────────────────

function createScopedTargetStore(pool: Pool, userId: string): TargetStore {
  return {
    async list(filters?) {
      return withUserRead(pool, userId, async (client) => {
        if (filters && Object.keys(filters).length > 0) {
          const { sql, params } = buildFilterQuery(filters);
          const result = await client.query(sql, params);
          return result.rows.map(mapRow);
        }
        const result = await client.query(SQL.list);
        return result.rows.map(mapRow);
      });
    },

    async get(id) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.get, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
      });
    },

    async create(input) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(SQL.create, [
          userId,
          input.targetType,
          input.refId ?? null,
          input.loadoutId ?? null,
          input.targetTier ?? null,
          input.targetRank ?? null,
          input.targetLevel ?? null,
          input.reason ?? null,
          input.priority ?? 2,
          input.autoSuggested ?? false,
        ]);
        return mapRow(result.rows[0]);
      });
    },

    async update(id, fields) {
      return withUserScope(pool, userId, async (client) => {
        const setClauses: string[] = [];
        const params: unknown[] = [id];

        if (fields.targetTier !== undefined) {
          params.push(fields.targetTier);
          setClauses.push(`target_tier = $${params.length}`);
        }
        if (fields.targetRank !== undefined) {
          params.push(fields.targetRank);
          setClauses.push(`target_rank = $${params.length}`);
        }
        if (fields.targetLevel !== undefined) {
          params.push(fields.targetLevel);
          setClauses.push(`target_level = $${params.length}`);
        }
        if (fields.reason !== undefined) {
          params.push(fields.reason);
          setClauses.push(`reason = $${params.length}`);
        }
        if (fields.priority !== undefined) {
          params.push(fields.priority);
          setClauses.push(`priority = $${params.length}`);
        }
        if (fields.status !== undefined) {
          params.push(fields.status);
          setClauses.push(`status = $${params.length}`);
        }

        if (setClauses.length === 0) {
          const result = await client.query(SQL.get, [id]);
          return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
        }

        setClauses.push(`updated_at = NOW()`);
        const sql = `UPDATE targets SET ${setClauses.join(", ")} WHERE id = $1 RETURNING ${COLS}`;
        const result = await client.query(sql, params);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
      });
    },

    async delete(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(SQL.delete, [id]);
        return result.rowCount! > 0;
      });
    },

    async markAchieved(id) {
      return withUserScope(pool, userId, async (client) => {
        const result = await client.query(SQL.markAchieved, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
      });
    },

    async listByRef(refId) {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.listByRefId, [refId]);
        return result.rows.map(mapRow);
      });
    },

    async counts() {
      return withUserRead(pool, userId, async (client) => {
        const result = await client.query(SQL.counts);
        const row = result.rows[0];
        return {
          total: Number(row.total),
          active: Number(row.active),
          achieved: Number(row.achieved),
          abandoned: Number(row.abandoned),
          byType: {
            officer: Number(row.type_officer),
            ship: Number(row.type_ship),
            crew: Number(row.type_crew),
          },
        };
      });
    },

    close() {
      // Pool lifecycle managed by index.ts
    },
  };
}

// ─── Factory (#85) ──────────────────────────────────────────

export class TargetStoreFactory {
  constructor(private pool: Pool) {}

  forUser(userId: string): TargetStore {
    return createScopedTargetStore(this.pool, userId);
  }
}

export async function createTargetStoreFactory(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<TargetStoreFactory> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;
  log.boot.debug("target store initialized (user-scoped, RLS)");
  return new TargetStoreFactory(pool);
}

/** Backward-compatible: returns a store scoped to "local" user. */
export async function createTargetStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<TargetStore> {
  const factory = await createTargetStoreFactory(adminPool, runtimePool);
  return factory.forUser("local");
}
