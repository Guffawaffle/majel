/**
 * chat-run-store.ts — Durable queue for async chat runs (ADR-036 Day 4).
 *
 * NOTE: This table intentionally does NOT use RLS (Row Level Security).
 * Unlike operation_events/operation_streams, the chat_runs table is a
 * system-level work queue where the worker claim loop (claimNext,
 * heartbeat, finish, requeueStaleRunning) must read/write across all
 * users. User-facing access is always filtered by user_id in WHERE
 * clauses (getForUser, requestCancel). See sprint review P1.
 */

import { initSchema, withTransaction, type Pool } from "../db.js";

export type ChatRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ChatRunRecord {
  id: string;
  userId: string;
  sessionId: string;
  tabId: string;
  status: ChatRunStatus;
  requestJson: Record<string, unknown>;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnqueueChatRunInput {
  id: string;
  userId: string;
  sessionId: string;
  tabId: string;
  requestJson: Record<string, unknown>;
}

export interface ClaimChatRunResult {
  run: ChatRunRecord;
  lockToken: string;
}

export interface ChatRunStore {
  enqueue(input: EnqueueChatRunInput): Promise<ChatRunRecord>;
  claimNext(lockToken: string): Promise<ClaimChatRunResult | null>;
  get(runId: string): Promise<ChatRunRecord | null>;
  heartbeat(runId: string, lockToken: string): Promise<boolean>;
  finish(runId: string, lockToken: string, status: Exclude<ChatRunStatus, "queued" | "running">): Promise<boolean>;
  requestCancel(runId: string, userId: string): Promise<"queued" | "running" | "terminal" | "not_found">;
  getForUser(runId: string, userId: string): Promise<ChatRunRecord | null>;
  requeueStaleRunning(staleAfterMs: number): Promise<number>;
  close(): void;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS public.chat_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
    request_json JSONB NOT NULL,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    lock_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_runs_status_created ON public.chat_runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_runs_user_created ON public.chat_runs(user_id, created_at DESC)`,
];

const RUN_COLS = `id, user_id AS "userId", session_id AS "sessionId", tab_id AS "tabId",
  status, request_json AS "requestJson", cancel_requested AS "cancelRequested",
  created_at AS "createdAt", updated_at AS "updatedAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

function mapRun(row: Record<string, unknown>): ChatRunRecord {
  return {
    id: String(row.id),
    userId: String(row.userId),
    sessionId: String(row.sessionId),
    tabId: String(row.tabId),
    status: String(row.status) as ChatRunStatus,
    requestJson: (row.requestJson as Record<string, unknown>) ?? {},
    cancelRequested: Boolean(row.cancelRequested),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    updatedAt: new Date(String(row.updatedAt)).toISOString(),
    startedAt: row.startedAt == null ? null : new Date(String(row.startedAt)).toISOString(),
    finishedAt: row.finishedAt == null ? null : new Date(String(row.finishedAt)).toISOString(),
  };
}

export async function createChatRunStore(adminPool: Pool, runtimePool?: Pool): Promise<ChatRunStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  return {
    async enqueue(input) {
      const result = await pool.query(
        `INSERT INTO public.chat_runs
           (id, user_id, session_id, tab_id, status, request_json)
         VALUES ($1, $2, $3, $4, 'queued', $5)
         RETURNING ${RUN_COLS}`,
        [input.id, input.userId, input.sessionId, input.tabId, JSON.stringify(input.requestJson)],
      );
      return mapRun(result.rows[0] as Record<string, unknown>);
    },

    async claimNext(lockToken) {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `WITH next AS (
             SELECT id
             FROM public.chat_runs
             WHERE status = 'queued'
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE public.chat_runs r
           SET status = 'running',
               lock_token = $1,
               started_at = COALESCE(r.started_at, NOW()),
               updated_at = NOW()
           FROM next
           WHERE r.id = next.id
           RETURNING r.id, r.user_id AS "userId", r.session_id AS "sessionId", r.tab_id AS "tabId",
             r.status, r.request_json AS "requestJson", r.cancel_requested AS "cancelRequested",
             r.created_at AS "createdAt", r.updated_at AS "updatedAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt"`,
          [lockToken],
        );

        const row = result.rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return { run: mapRun(row), lockToken };
      });
    },

    async heartbeat(runId, lockToken) {
      const result = await pool.query(
        `UPDATE public.chat_runs
         SET updated_at = NOW()
         WHERE id = $1 AND lock_token = $2 AND status = 'running'`,
        [runId, lockToken],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async get(runId) {
      const result = await pool.query(
        `SELECT ${RUN_COLS}
         FROM public.chat_runs
         WHERE id = $1
         LIMIT 1`,
        [runId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapRun(row) : null;
    },

    async finish(runId, lockToken, status) {
      const result = await pool.query(
        `UPDATE public.chat_runs
         SET status = $1,
             lock_token = NULL,
             finished_at = NOW(),
             updated_at = NOW()
         WHERE id = $2 AND lock_token = $3 AND status = 'running'`,
        [status, runId, lockToken],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async requestCancel(runId, userId) {
      const rowResult = await pool.query(
        `SELECT status
         FROM public.chat_runs
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [runId, userId],
      );
      const status = rowResult.rows[0]?.status as ChatRunStatus | undefined;
      if (!status) return "not_found";
      if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) return "terminal";

      const update = await pool.query(
        `UPDATE public.chat_runs
         SET cancel_requested = TRUE,
             updated_at = NOW(),
             status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
             finished_at = CASE WHEN status = 'queued' THEN NOW() ELSE finished_at END
         WHERE id = $1 AND user_id = $2
         RETURNING status`,
        [runId, userId],
      );
      const nextStatus = String(update.rows[0]?.status ?? status) as ChatRunStatus;
      return nextStatus === "cancelled" ? "queued" : "running";
    },

    async getForUser(runId, userId) {
      const result = await pool.query(
        `SELECT ${RUN_COLS}
         FROM public.chat_runs
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [runId, userId],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapRun(row) : null;
    },

    async requeueStaleRunning(staleAfterMs) {
      const result = await pool.query(
        `UPDATE public.chat_runs
         SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,
             lock_token = NULL,
             finished_at = CASE WHEN cancel_requested THEN COALESCE(finished_at, NOW()) ELSE finished_at END,
             updated_at = NOW()
         WHERE status = 'running'
           AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
        [Math.max(1, staleAfterMs)],
      );
      return result.rowCount ?? 0;
    },

    close(): void {
      // Pool lifecycle managed externally
    },
  };
}
