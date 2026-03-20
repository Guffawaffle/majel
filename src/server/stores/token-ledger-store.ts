/**
 * token-ledger-store.ts — Token usage ledger for LLM cost tracking.
 *
 * ADR-048 Phase A (#236): Records every LLM call with user, model,
 * operation type, and token counts. Used by Phase B for budget enforcement.
 *
 * Not user-scoped (no RLS) — this is server-side telemetry written
 * after each Gemini API call, not a user-facing CRUD resource.
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_ledger (
    id            BIGSERIAL PRIMARY KEY,
    user_id       TEXT NOT NULL,
    model_id      TEXT NOT NULL,
    operation     TEXT NOT NULL CHECK (operation IN ('chat','tool_call','repair','fallback','summarize')),
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_token_ledger_user_period ON token_ledger (user_id, created_at)`,
  // Migration: remove dead 'scan' operation from CHECK constraint (#248)
  `DO $$ BEGIN
    ALTER TABLE token_ledger DROP CONSTRAINT IF EXISTS token_ledger_operation_check;
    ALTER TABLE token_ledger ADD CONSTRAINT token_ledger_operation_check
      CHECK (operation IN ('chat','tool_call','repair','fallback','summarize'));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
];

// ─── Types ──────────────────────────────────────────────────────

export type TokenOperation = "chat" | "tool_call" | "repair" | "fallback" | "summarize";

export interface TokenRecord {
  userId: string;
  modelId: string;
  operation: TokenOperation;
  inputTokens: number;
  outputTokens: number;
}

export interface DailyUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

// ─── Store ──────────────────────────────────────────────────────

export interface TokenLedgerStore {
  /** Append a token usage record. */
  record(entry: TokenRecord): Promise<void>;
  /** Get aggregated daily usage for a user (defaults to today). */
  dailyUsage(userId: string, date?: Date): Promise<DailyUsage>;
  /** Purge records older than the given interval (e.g., '90 days'). */
  purgeOlderThan(interval: string): Promise<number>;
}

export async function createTokenLedgerStore(adminPool: Pool, runtimePool?: Pool): Promise<TokenLedgerStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;
  log.boot.info("token ledger store online (ADR-048 Phase A)");

  return {
    async record(entry: TokenRecord): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO token_ledger (user_id, model_id, operation, input_tokens, output_tokens)
           VALUES ($1, $2, $3, $4, $5)`,
          [entry.userId, entry.modelId, entry.operation, entry.inputTokens, entry.outputTokens],
        );
      } catch (err) {
        // Best-effort — never block chat for a telemetry write failure
        log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "token_ledger:record:error");
      }
    },

    async dailyUsage(userId: string, date?: Date): Promise<DailyUsage> {
      const targetDate = date ?? new Date();
      const result = await pool.query(
        `SELECT
           COALESCE(SUM(input_tokens), 0)::int AS "inputTokens",
           COALESCE(SUM(output_tokens), 0)::int AS "outputTokens",
           COALESCE(SUM(input_tokens + output_tokens), 0)::int AS "totalTokens",
           COUNT(*)::int AS "callCount"
         FROM token_ledger
         WHERE user_id = $1
           AND created_at >= $2::date
           AND created_at < ($2::date + INTERVAL '1 day')`,
        [userId, targetDate.toISOString().slice(0, 10)],
      );
      return result.rows[0] as DailyUsage;
    },

    async purgeOlderThan(interval: string): Promise<number> {
      const result = await pool.query(
        `DELETE FROM token_ledger WHERE created_at < NOW() - $1::interval`,
        [interval],
      );
      return result.rowCount ?? 0;
    },
  };
}
