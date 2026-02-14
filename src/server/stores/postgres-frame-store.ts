/**
 * postgres-frame-store.ts — PostgreSQL FrameStore Implementation (ADR-021)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Implements Lex's FrameStore interface against PostgreSQL with:
 * - JSONB columns for arrays/objects (instead of JSON-in-TEXT)
 * - tsvector GENERATED column + GIN index for full-text search
 * - Row-Level Security for multi-tenant isolation
 * - Shared pg.Pool (owned by the app, not the store)
 *
 * @see docs/ADR-021-postgres-frame-store.md
 */

import {
  initSchema,
  withTransaction,
  type Pool,
  type PoolClient,
} from "../db.js";
import { log } from "../logger.js";
import type {
  FrameStore,
  FrameSearchCriteria,
  FrameListOptions,
  FrameListResult,
  SaveResult,
  StoreStats,
  TurnCostMetrics,
  Frame,
} from "@smartergpt/lex/store";

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  // Core frames table — maps 1:1 to Lex Frame type
  `CREATE TABLE IF NOT EXISTS lex_frames (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    timestamp        TIMESTAMPTZ NOT NULL,
    branch           TEXT NOT NULL DEFAULT 'majel-chat',
    jira             TEXT,
    module_scope     JSONB NOT NULL DEFAULT '[]',
    summary_caption  TEXT NOT NULL,
    reference_point  TEXT NOT NULL,
    status_snapshot  JSONB NOT NULL,
    keywords         JSONB DEFAULT '[]',
    atlas_frame_id   TEXT,
    feature_flags    JSONB,
    permissions      JSONB,
    run_id           TEXT,
    plan_hash        TEXT,
    spend            JSONB,
    superseded_by    TEXT,
    merged_from      JSONB,
    executor_role    TEXT,
    tool_calls       JSONB,
    guardrail_profile TEXT,
    turn_cost        JSONB,
    capability_tier  TEXT,
    task_complexity  JSONB,
    contradiction_resolution JSONB,
    search_vector    tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(reference_point, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary_caption, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(branch, '')), 'C')
    ) STORED
  )`,

  // Row-Level Security: fail-closed tenant isolation
  `ALTER TABLE lex_frames ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lex_frames FORCE ROW LEVEL SECURITY`,

  // Drop + recreate policy idempotently
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lex_frames' AND policyname = 'lex_frames_user_isolation') THEN
      DROP POLICY lex_frames_user_isolation ON lex_frames;
    END IF;
  END $$`,
  `CREATE POLICY lex_frames_user_isolation ON lex_frames
    USING (user_id = current_setting('app.current_user_id', true))
    WITH CHECK (user_id = current_setting('app.current_user_id', true))`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_user_ts ON lex_frames (user_id, timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_branch ON lex_frames (branch)`,
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_search ON lex_frames USING GIN (search_vector)`,
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_module ON lex_frames USING GIN (module_scope)`,
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_jira ON lex_frames (jira) WHERE jira IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_lex_frames_superseded ON lex_frames (superseded_by) WHERE superseded_by IS NOT NULL`,
];

// ─── Row ↔ Frame mapping ───────────────────────────────────────

interface FrameRow {
  id: string;
  user_id: string;
  timestamp: string;
  branch: string;
  jira: string | null;
  module_scope: string[];
  summary_caption: string;
  reference_point: string;
  status_snapshot: Record<string, unknown>;
  keywords: string[] | null;
  atlas_frame_id: string | null;
  feature_flags: string[] | null;
  permissions: string[] | null;
  run_id: string | null;
  plan_hash: string | null;
  spend: Record<string, unknown> | null;
  superseded_by: string | null;
  merged_from: string[] | null;
  executor_role: string | null;
  tool_calls: string[] | null;
  guardrail_profile: string | null;
  turn_cost: Record<string, unknown> | null;
  capability_tier: string | null;
  task_complexity: Record<string, unknown> | null;
  contradiction_resolution: Record<string, unknown> | null;
}

function rowToFrame(row: FrameRow): Frame {
  const f: Frame = {
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    branch: row.branch,
    module_scope: row.module_scope ?? [],
    summary_caption: row.summary_caption,
    reference_point: row.reference_point,
    status_snapshot: row.status_snapshot as Frame["status_snapshot"],
    keywords: row.keywords ?? [],
  };
  if (row.jira) f.jira = row.jira;
  if (row.atlas_frame_id) f.atlas_frame_id = row.atlas_frame_id;
  if (row.feature_flags?.length) f.feature_flags = row.feature_flags;
  if (row.permissions?.length) f.permissions = row.permissions;
  if (row.run_id) f.runId = row.run_id;
  if (row.plan_hash) f.planHash = row.plan_hash;
  if (row.spend) f.spend = row.spend as Frame["spend"];
  if (row.user_id) f.userId = row.user_id;
  if (row.superseded_by) f.superseded_by = row.superseded_by;
  if (row.merged_from?.length) f.merged_from = row.merged_from;
  if (row.executor_role) f.executorRole = row.executor_role;
  if (row.tool_calls?.length) f.toolCalls = row.tool_calls;
  if (row.guardrail_profile) f.guardrailProfile = row.guardrail_profile;
  if (row.turn_cost) f.turnCost = row.turn_cost as Frame["turnCost"];
  if (row.capability_tier)
    f.capabilityTier = row.capability_tier as Frame["capabilityTier"];
  if (row.task_complexity)
    f.taskComplexity = row.task_complexity as Frame["taskComplexity"];
  if (row.contradiction_resolution)
    f.contradiction_resolution =
      row.contradiction_resolution as Frame["contradiction_resolution"];
  return f;
}

// ─── Core SELECT columns (exclude search_vector) ───────────────

const SELECT_COLS = `id, user_id, timestamp, branch, jira, module_scope,
  summary_caption, reference_point, status_snapshot, keywords,
  atlas_frame_id, feature_flags, permissions, run_id, plan_hash,
  spend, superseded_by, merged_from, executor_role, tool_calls,
  guardrail_profile, turn_cost, capability_tier, task_complexity,
  contradiction_resolution`;

// ─── Cursor encoding ───────────────────────────────────────────

interface CursorPayload {
  ts: string; // ISO timestamp
  id: string; // frame ID (tiebreaker)
}

/**
 * Sanitize a term for safe embedding in tsquery syntax.
 * Strips characters that are tsquery operators or would break quoting.
 */
function sanitizeTsqueryTerm(term: string): string {
  return term.replace(/[':&|!()\\<>*]/g, "").trim();
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id })).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (typeof parsed.ts === "string" && typeof parsed.id === "string")
      return parsed;
    return null;
  } catch {
    return null;
  }
}

// ─── withUserScope — RLS session binding ────────────────────────

/**
 * Execute a callback inside a transaction with RLS user scope set.
 * Composes on db.ts withTransaction — adds only the set_config call.
 * `SET LOCAL` is transaction-scoped — automatically cleared on COMMIT/ROLLBACK.
 */
export async function withUserScope<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [
      userId,
    ]);
    return fn(client);
  });
}

/**
 * Execute a single read query with RLS scope but without transactional overhead.
 * Saves 2 round-trips (BEGIN/COMMIT) compared to withUserScope.
 * NOT safe for writes — use withUserScope for mutations.
 */
async function withUserRead<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [
      userId,
    ]);
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── PostgresFrameStore ─────────────────────────────────────────

const INSERT_SQL = `INSERT INTO lex_frames (
  id, user_id, timestamp, branch, jira, module_scope,
  summary_caption, reference_point, status_snapshot, keywords,
  atlas_frame_id, feature_flags, permissions, run_id, plan_hash,
  spend, superseded_by, merged_from, executor_role, tool_calls,
  guardrail_profile, turn_cost, capability_tier, task_complexity,
  contradiction_resolution
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
ON CONFLICT (id) DO NOTHING`;

export class PostgresFrameStore implements FrameStore {
  constructor(
    private pool: Pool,
    private userId: string,
  ) {}

  /** Run a query inside a user-scoped transaction (for writes). */
  private async scoped<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withUserScope(this.pool, this.userId, fn);
  }

  /** Run a read-only query with user scope but no transaction overhead. */
  private async scopedRead<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withUserRead(this.pool, this.userId, fn);
  }

  /** Map a Frame to the ordered parameter array for INSERT_SQL. */
  private frameToParams(frame: Frame): unknown[] {
    return [
      frame.id,
      this.userId,
      frame.timestamp,
      frame.branch,
      frame.jira ?? null,
      JSON.stringify(frame.module_scope), // always present (required field)
      frame.summary_caption,
      frame.reference_point,
      JSON.stringify(frame.status_snapshot), // always present (required field)
      frame.keywords?.length ? JSON.stringify(frame.keywords) : null,
      frame.atlas_frame_id ?? null,
      frame.feature_flags?.length ? JSON.stringify(frame.feature_flags) : null,
      frame.permissions?.length ? JSON.stringify(frame.permissions) : null,
      frame.runId ?? null,
      frame.planHash ?? null,
      frame.spend ? JSON.stringify(frame.spend) : null,
      frame.superseded_by ?? null,
      frame.merged_from?.length ? JSON.stringify(frame.merged_from) : null,
      frame.executorRole ?? null,
      frame.toolCalls?.length ? JSON.stringify(frame.toolCalls) : null,
      frame.guardrailProfile ?? null,
      frame.turnCost ? JSON.stringify(frame.turnCost) : null,
      frame.capabilityTier ?? null,
      frame.taskComplexity ? JSON.stringify(frame.taskComplexity) : null,
      frame.contradiction_resolution
        ? JSON.stringify(frame.contradiction_resolution)
        : null,
    ];
  }

  async saveFrame(frame: Frame): Promise<void> {
    await this.scoped(async (client) => {
      await client.query(INSERT_SQL, this.frameToParams(frame));
    });
  }

  async saveFrames(frames: Frame[]): Promise<SaveResult[]> {
    // All-or-nothing: single transaction, no per-frame error swallowing.
    // If any INSERT fails, PostgreSQL aborts the transaction and the
    // scoped() wrapper rolls back. The thrown error propagates to caller.
    return this.scoped(async (client) => {
      const results: SaveResult[] = [];
      for (const frame of frames) {
        await client.query(INSERT_SQL, this.frameToParams(frame));
        results.push({ id: frame.id, success: true });
      }
      return results;
    });
  }

  async getFrameById(id: string): Promise<Frame | null> {
    return this.scopedRead(async (client) => {
      const { rows } = await client.query(
        `SELECT ${SELECT_COLS} FROM lex_frames WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? rowToFrame(rows[0] as FrameRow) : null;
    });
  }

  async searchFrames(criteria: FrameSearchCriteria): Promise<Frame[]> {
    return this.scopedRead(async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      // Full-text search
      if (criteria.query) {
        const terms = criteria.query
          .split(/\s+/)
          .filter(Boolean)
          .map(sanitizeTsqueryTerm)
          .filter(Boolean);

        if (terms.length === 0) {
          // All terms were stripped — no-op search
        } else if (criteria.mode === "any") {
          // OR mode: any term can match
          const tsExpr = terms
            .map((t) => (criteria.exact ? t : `${t}:*`))
            .join(" | ");
          conditions.push(
            `search_vector @@ to_tsquery('english', $${paramIdx})`,
          );
          params.push(tsExpr);
          paramIdx++;
        } else if (criteria.exact) {
          // AND mode, exact: plainto_tsquery handles implicit AND
          conditions.push(
            `search_vector @@ plainto_tsquery('english', $${paramIdx})`,
          );
          params.push(criteria.query);
          paramIdx++;
        } else {
          // AND mode, fuzzy: prefix matching with :* suffix
          const tsExpr = terms.map((t) => `${t}:*`).join(" & ");
          conditions.push(
            `search_vector @@ to_tsquery('english', $${paramIdx})`,
          );
          params.push(tsExpr);
          paramIdx++;
        }
      }

      // Module scope filter (JSONB containment)
      if (criteria.moduleScope?.length) {
        // Match frames that contain ANY of the given module IDs
        const moduleConditions = criteria.moduleScope.map((mod) => {
          params.push(JSON.stringify([mod]));
          return `module_scope @> $${paramIdx++}::jsonb`;
        });
        conditions.push(`(${moduleConditions.join(" OR ")})`);
      }

      // Time range filters
      if (criteria.since) {
        conditions.push(`timestamp >= $${paramIdx}`);
        params.push(criteria.since.toISOString());
        paramIdx++;
      }
      if (criteria.until) {
        conditions.push(`timestamp <= $${paramIdx}`);
        params.push(criteria.until.toISOString());
        paramIdx++;
      }

      // userId filter (belt-and-suspenders — RLS already handles this)
      if (criteria.userId) {
        conditions.push(`user_id = $${paramIdx}`);
        params.push(criteria.userId);
        paramIdx++;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = criteria.limit ?? 50;

      const sql = `SELECT ${SELECT_COLS} FROM lex_frames ${where} ORDER BY timestamp DESC LIMIT $${paramIdx}`;
      params.push(limit);

      const { rows } = await client.query(sql, params);
      return rows.map((r) => rowToFrame(r as FrameRow));
    });
  }

  async listFrames(options?: FrameListOptions): Promise<FrameListResult> {
    return this.scopedRead(async (client) => {
      const limit = options?.limit ?? 20;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      // Cursor-based pagination (takes precedence over offset)
      if (options?.cursor) {
        const cursor = decodeCursor(options.cursor);
        if (cursor) {
          conditions.push(`(timestamp, id) < ($${paramIdx}, $${paramIdx + 1})`);
          params.push(cursor.ts, cursor.id);
          paramIdx += 2;
        }
      } else if (options?.offset) {
        // TODO: Offset pagination not yet implemented (cursor-based preferred).
        // Callers passing offset will silently get unfiltered results.
      }

      // userId filter (belt-and-suspenders)
      if (options?.userId) {
        conditions.push(`user_id = $${paramIdx}`);
        params.push(options.userId);
        paramIdx++;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Fetch limit + 1 to detect hasMore
      const sql = `SELECT ${SELECT_COLS} FROM lex_frames ${where} ORDER BY timestamp DESC, id DESC LIMIT $${paramIdx}`;
      params.push(limit + 1);

      const { rows } = await client.query(sql, params);
      const hasMore = rows.length > limit;
      const frameRows = hasMore ? rows.slice(0, limit) : rows;
      const frames = frameRows.map((r) => rowToFrame(r as FrameRow));

      let nextCursor: string | null = null;
      if (hasMore && frames.length > 0) {
        const last = frames[frames.length - 1];
        nextCursor = encodeCursor(last.timestamp, last.id);
      }

      return {
        frames,
        page: { limit, nextCursor, hasMore },
        order: { by: "timestamp" as const, direction: "desc" as const },
      };
    });
  }

  async deleteFrame(id: string): Promise<boolean> {
    return this.scoped(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM lex_frames WHERE id = $1`,
        [id],
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async deleteFramesBefore(date: Date): Promise<number> {
    return this.scoped(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM lex_frames WHERE timestamp < $1`,
        [date.toISOString()],
      );
      return rowCount ?? 0;
    });
  }

  async deleteFramesByBranch(branch: string): Promise<number> {
    return this.scoped(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM lex_frames WHERE branch = $1`,
        [branch],
      );
      return rowCount ?? 0;
    });
  }

  async deleteFramesByModule(moduleId: string): Promise<number> {
    return this.scoped(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM lex_frames WHERE module_scope @> $1::jsonb`,
        [JSON.stringify([moduleId])],
      );
      return rowCount ?? 0;
    });
  }

  async getFrameCount(): Promise<number> {
    return this.scopedRead(async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM lex_frames`,
      );
      return rows[0].count;
    });
  }

  async getStats(detailed?: boolean): Promise<StoreStats> {
    return this.scopedRead(async (client) => {
      const { rows } = await client.query(`
        SELECT
          COUNT(*)::int AS total_frames,
          COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '7 days')::int AS this_week,
          COUNT(*) FILTER (WHERE timestamp >= NOW() - INTERVAL '30 days')::int AS this_month,
          MIN(timestamp)::text AS oldest_date,
          MAX(timestamp)::text AS newest_date
        FROM lex_frames
      `);

      const stats: StoreStats = {
        totalFrames: rows[0].total_frames,
        thisWeek: rows[0].this_week,
        thisMonth: rows[0].this_month,
        oldestDate: rows[0].oldest_date,
        newestDate: rows[0].newest_date,
      };

      if (detailed) {
        // Top 20 modules by frame count
        const { rows: modRows } = await client.query(`
          SELECT module, COUNT(*)::int AS count
          FROM lex_frames, jsonb_array_elements_text(module_scope) AS module
          GROUP BY module
          ORDER BY count DESC
          LIMIT 20
        `);
        stats.moduleDistribution = Object.fromEntries(
          modRows.map((r: Record<string, unknown>) => [r.module, r.count]),
        );
      }

      return stats;
    });
  }

  async getTurnCostMetrics(since?: string): Promise<TurnCostMetrics> {
    return this.scopedRead(async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (since) {
        conditions.push(`timestamp >= $1`);
        params.push(since);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await client.query(
        `
        SELECT
          COUNT(*)::int AS frame_count,
          COALESCE(SUM((spend->>'tokens_estimated')::int), 0)::int AS estimated_tokens,
          COALESCE(SUM((spend->>'prompts')::int), 0)::int AS prompts
        FROM lex_frames ${where}
      `,
        params,
      );

      return {
        frameCount: rows[0].frame_count,
        estimatedTokens: rows[0].estimated_tokens,
        prompts: rows[0].prompts,
      };
    });
  }

  async updateFrame(
    id: string,
    updates: Partial<Omit<Frame, "id" | "timestamp">>,
  ): Promise<boolean> {
    return this.scoped(async (client) => {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      // Map Frame field names to DB column names + value serialisation
      const fieldMap: Record<
        string,
        { col: string; toDb: (v: unknown) => unknown }
      > = {
        branch: { col: "branch", toDb: (v) => v },
        jira: { col: "jira", toDb: (v) => v ?? null },
        module_scope: { col: "module_scope", toDb: (v) => JSON.stringify(v) },
        summary_caption: { col: "summary_caption", toDb: (v) => v },
        reference_point: { col: "reference_point", toDb: (v) => v },
        status_snapshot: {
          col: "status_snapshot",
          toDb: (v) => JSON.stringify(v),
        },
        keywords: {
          col: "keywords",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        atlas_frame_id: { col: "atlas_frame_id", toDb: (v) => v ?? null },
        feature_flags: {
          col: "feature_flags",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        permissions: {
          col: "permissions",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        runId: { col: "run_id", toDb: (v) => v ?? null },
        planHash: { col: "plan_hash", toDb: (v) => v ?? null },
        spend: { col: "spend", toDb: (v) => (v ? JSON.stringify(v) : null) },
        userId: { col: "user_id", toDb: (v) => v ?? null },
        superseded_by: { col: "superseded_by", toDb: (v) => v ?? null },
        merged_from: {
          col: "merged_from",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        executorRole: { col: "executor_role", toDb: (v) => v ?? null },
        toolCalls: {
          col: "tool_calls",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        guardrailProfile: { col: "guardrail_profile", toDb: (v) => v ?? null },
        turnCost: {
          col: "turn_cost",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        capabilityTier: { col: "capability_tier", toDb: (v) => v ?? null },
        taskComplexity: {
          col: "task_complexity",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
        contradiction_resolution: {
          col: "contradiction_resolution",
          toDb: (v) => (v ? JSON.stringify(v) : null),
        },
      };

      for (const [key, value] of Object.entries(updates)) {
        const mapping = fieldMap[key];
        if (!mapping) continue; // skip unknown fields silently
        setClauses.push(`${mapping.col} = $${paramIdx}`);
        params.push(mapping.toDb(value));
        paramIdx++;
      }

      if (setClauses.length === 0) return false;

      params.push(id);
      const sql = `UPDATE lex_frames SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`;
      const { rowCount } = await client.query(sql, params);
      return (rowCount ?? 0) > 0;
    });
  }

  async purgeSuperseded(): Promise<number> {
    return this.scoped(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM lex_frames WHERE superseded_by IS NOT NULL`,
      );
      return rowCount ?? 0;
    });
  }

  async close(): Promise<void> {
    // No-op — pool is owned by the app, not the store.
    // Lifecycle: app creates pool → passes to store → app closes pool at shutdown.
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Initialize the lex_frames schema and return a factory for creating
 * user-scoped PostgresFrameStore instances.
 */
export async function createFrameStoreFactory(
  pool: Pool,
): Promise<FrameStoreFactory> {
  await initSchema(pool, SCHEMA_STATEMENTS);
  log.boot.info("lex_frames schema initialized (Postgres + RLS)");
  return new FrameStoreFactory(pool);
}

export class FrameStoreFactory {
  constructor(private pool: Pool) {}

  /** Create a FrameStore scoped to a specific user. RLS enforces isolation. */
  forUser(userId: string): FrameStore {
    return new PostgresFrameStore(this.pool, userId);
  }
}
