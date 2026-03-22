/**
 * token-budget-store.ts — Per-user token budget overrides + enforcement
 *
 * ADR-048 Phase B (#237): Stores per-user budget overrides and provides
 * the pre-flight budget check used by the chat engine before each LLM call.
 *
 * Resolution order: per-user override → rank default → unlimited.
 */

import { initSchema, type Pool } from "../db.js";
import type { TokenLedgerStore, DailyUsage } from "./token-ledger-store.js";
import type { SettingsStore } from "./settings.js";
import type { Role } from "./user-store.js";

// ─── Schema ─────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS token_budget_overrides (
    user_id     TEXT NOT NULL PRIMARY KEY,
    daily_limit INTEGER,
    note        TEXT,
    set_by      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// ─── Types ──────────────────────────────────────────────────────

export interface BudgetOverride {
  userId: string;
  dailyLimit: number | null;
  note: string | null;
  setBy: string | null;
  updatedAt: string;
}

export interface BudgetStatus {
  dailyLimit: number;        // -1 = unlimited
  consumed: number;
  remaining: number;         // -1 = unlimited
  resetsAt: string;          // ISO timestamp of next UTC midnight
  source: "override" | "rank" | "unlimited";
  /** True when consumed >= (dailyLimit - padding). Signals "wrapping up" to the UI/chat. */
  warning: boolean;
}

/** Thrown when a user exceeds their token budget. */
export class TokenBudgetExceededError extends Error {
  public readonly status: BudgetStatus;

  constructor(status: BudgetStatus) {
    super(`Token budget exceeded: ${status.consumed}/${status.dailyLimit} tokens used today`);
    this.name = "TokenBudgetExceededError";
    this.status = status;
  }
}

// ─── SQL ────────────────────────────────────────────────────────

const SQL = {
  getOverride: `SELECT user_id, daily_limit, note, set_by, updated_at FROM token_budget_overrides WHERE user_id = $1`,
  upsertOverride: `INSERT INTO token_budget_overrides (user_id, daily_limit, note, set_by, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id) DO UPDATE SET daily_limit = $2, note = $3, set_by = $4, updated_at = NOW()`,
  deleteOverride: `DELETE FROM token_budget_overrides WHERE user_id = $1`,
  listOverrides: `SELECT user_id, daily_limit, note, set_by, updated_at FROM token_budget_overrides ORDER BY updated_at DESC LIMIT 500`,
};

// ─── Store Interface ────────────────────────────────────────────

export interface TokenBudgetStore {
  /** Get the per-user override for a user, if any. */
  getOverride(userId: string): Promise<BudgetOverride | null>;
  /** Set or update a budget override for a user. -1 = unlimited, null = remove. */
  setOverride(userId: string, dailyLimit: number | null, note: string | null, setBy: string): Promise<void>;
  /** Remove a per-user override (reverts to rank default). */
  removeOverride(userId: string): Promise<boolean>;
  /** List all overrides (for admin panel). */
  listOverrides(): Promise<BudgetOverride[]>;
  /**
   * Pre-flight budget check. Resolves the effective limit and throws
   * TokenBudgetExceededError if the user has exceeded their daily budget.
   * Returns the BudgetStatus for transparency.
   */
  checkBudget(userId: string, role: Role): Promise<BudgetStatus>;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Compute the next UTC midnight as an ISO string. */
function nextUtcMidnight(): string {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString();
}

/** Settings key for a rank's default budget. */
function rankBudgetKey(role: Role): string {
  return `budget.${role}`;
}

// ─── Implementation ─────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): BudgetOverride {
  return {
    userId: row.user_id as string,
    dailyLimit: row.daily_limit as number | null,
    note: row.note as string | null,
    setBy: row.set_by as string | null,
    updatedAt: String(row.updated_at),
  };
}

export async function createTokenBudgetStore(
  adminPool: Pool,
  pool: Pool,
  settingsStore: SettingsStore,
  tokenLedgerStore: TokenLedgerStore,
): Promise<TokenBudgetStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);

  /** Resolve the rank default daily limit from settings. */
  async function getRankDefault(role: Role): Promise<number> {
    const value = await settingsStore.getTyped(rankBudgetKey(role));
    return typeof value === "number" ? value : -1;
  }

  /** Resolve the padding percentage (0–50) from settings. */
  async function getPaddingPct(): Promise<number> {
    const value = await settingsStore.getTyped("budget.padding_pct");
    return typeof value === "number" ? Math.max(0, Math.min(50, value)) : 10;
  }

  return {
    async getOverride(userId: string): Promise<BudgetOverride | null> {
      const result = await pool.query(SQL.getOverride, [userId]);
      return result.rows.length > 0 ? mapRow(result.rows[0] as Record<string, unknown>) : null;
    },

    async setOverride(userId: string, dailyLimit: number | null, note: string | null, setBy: string): Promise<void> {
      if (dailyLimit === null) {
        await pool.query(SQL.deleteOverride, [userId]);
      } else {
        await pool.query(SQL.upsertOverride, [userId, dailyLimit, note, setBy]);
      }
    },

    async removeOverride(userId: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteOverride, [userId]);
      return (result.rowCount ?? 0) > 0;
    },

    async listOverrides(): Promise<BudgetOverride[]> {
      const result = await pool.query(SQL.listOverrides);
      return result.rows.map((r) => mapRow(r as Record<string, unknown>));
    },

    async checkBudget(userId: string, role: Role): Promise<BudgetStatus> {
      // 1. Check per-user override
      const overrideResult = await pool.query(SQL.getOverride, [userId]);
      const override = overrideResult.rows.length > 0 ? mapRow(overrideResult.rows[0] as Record<string, unknown>) : null;
      let dailyLimit: number;
      let source: BudgetStatus["source"];

      if (override && override.dailyLimit !== null) {
        dailyLimit = override.dailyLimit;
        source = override.dailyLimit === -1 ? "unlimited" : "override";
      } else {
        dailyLimit = await getRankDefault(role);
        source = dailyLimit === -1 ? "unlimited" : "rank";
      }

      // 2. Unlimited — still query usage for informational display
      if (dailyLimit === -1) {
        const usage: DailyUsage = await tokenLedgerStore.dailyUsage(userId);
        return { dailyLimit: -1, consumed: usage.totalTokens, remaining: -1, resetsAt: nextUtcMidnight(), source: "unlimited", warning: false };
      }

      // 3. Zero budget — reject without querying
      if (dailyLimit === 0) {
        const status: BudgetStatus = { dailyLimit: 0, consumed: 0, remaining: 0, resetsAt: nextUtcMidnight(), source, warning: false };
        throw new TokenBudgetExceededError(status);
      }

      // 4. Query today's usage
      const usage: DailyUsage = await tokenLedgerStore.dailyUsage(userId);
      const consumed = usage.totalTokens;
      const remaining = Math.max(0, dailyLimit - consumed);

      // 5. Resolve padding for grace-zone warning
      const paddingPct = await getPaddingPct();
      const warningThreshold = dailyLimit - Math.floor(dailyLimit * paddingPct / 100);
      const warning = paddingPct > 0 && consumed >= warningThreshold && consumed < dailyLimit;

      // 6. Budget gate — block NEW messages when consumed >= dailyLimit.
      //    Once a message passes this gate, it always completes regardless of
      //    how many tokens it uses. We never kill an in-flight chat. (#250)
      if (consumed >= dailyLimit) {
        const status: BudgetStatus = { dailyLimit, consumed, remaining: 0, resetsAt: nextUtcMidnight(), source, warning: false };
        throw new TokenBudgetExceededError(status);
      }

      return { dailyLimit, consumed, remaining, resetsAt: nextUtcMidnight(), source, warning };
    },
  };
}
