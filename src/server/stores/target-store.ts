/**
 * target-store.ts — Structured target/goal tracking store (#17)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages structured acquisition and progression targets for officers,
 * ships, and crew loadouts. Complements the overlay's simple `target`
 * boolean with specific goals, progress tracking, and model-suggested targets.
 *
 * Three target types:
 * - officer: acquire or upgrade a specific officer
 * - ship: build or tier a specific ship
 * - crew: assemble a specific loadout (links to loadout_id)
 */

import { initSchema, type Pool } from "../db.js";
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

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS targets (
    id SERIAL PRIMARY KEY,
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
];

// ─── SQL ────────────────────────────────────────────────────

const COLS = `id, target_type, ref_id, loadout_id, target_tier, target_rank, target_level,
  reason, priority, status, auto_suggested, created_at, updated_at, achieved_at`;

const SQL = {
  list: `SELECT ${COLS} FROM targets ORDER BY priority ASC, created_at DESC`,
  listByRefId: `SELECT ${COLS} FROM targets WHERE ref_id = $1 ORDER BY priority ASC, created_at DESC`,
  get: `SELECT ${COLS} FROM targets WHERE id = $1`,
  create: `INSERT INTO targets (target_type, ref_id, loadout_id, target_tier, target_rank, target_level, reason, priority, auto_suggested)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

async function listFiltered(
  pool: Pool,
  filters: { targetType?: TargetType; status?: TargetStatus; priority?: number; refId?: string },
): Promise<Target[]> {
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
  const sql = `SELECT ${COLS} FROM targets ${where} ORDER BY priority ASC, created_at DESC`;
  const result = await pool.query(sql, params);
  return result.rows.map(mapRow);
}

// ─── Factory ────────────────────────────────────────────────

export async function createTargetStore(
  adminPool: Pool,
  runtimePool?: Pool,
): Promise<TargetStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  log.boot.debug("target store schema initialized");

  return {
    async list(filters?) {
      if (filters && Object.keys(filters).length > 0) {
        return listFiltered(pool, filters);
      }
      const result = await pool.query(SQL.list);
      return result.rows.map(mapRow);
    },

    async get(id) {
      const result = await pool.query(SQL.get, [id]);
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    },

    async create(input) {
      const result = await pool.query(SQL.create, [
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
    },

    async update(id, fields) {
      // Build dynamic SET clause — only update provided fields
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
        // Nothing to update — return current state
        const result = await pool.query(SQL.get, [id]);
        return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
      }

      setClauses.push(`updated_at = NOW()`);
      const sql = `UPDATE targets SET ${setClauses.join(", ")} WHERE id = $1 RETURNING ${COLS}`;
      const result = await pool.query(sql, params);
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    },

    async delete(id) {
      const result = await pool.query(SQL.delete, [id]);
      return result.rowCount! > 0;
    },

    async markAchieved(id) {
      const result = await pool.query(SQL.markAchieved, [id]);
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    },

    async listByRef(refId) {
      const result = await pool.query(SQL.listByRefId, [refId]);
      return result.rows.map(mapRow);
    },

    async counts() {
      const result = await pool.query(SQL.counts);
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
    },

    close() {
      // Pool lifecycle managed by index.ts
    },
  };
}
