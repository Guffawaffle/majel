/**
 * governance/trust-gap.ts — Trust-Gap Recording & Pattern Learning
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Records trust-gap events when validation violations occur, tracks
 * per-(modelFamily, taskType) trust profiles, and auto-generates learned
 * governance rules when the same failure pattern repeats ≥3 times.
 *
 * Adapted from LexSona's trust.ts (API shape; no code imported).
 *
 * Phase R1: All data is recorded for shadow observability.
 * Phase R2: Trust profiles feed back into constraint derivation.
 */

import { initSchema, type Pool } from "../../db.js";
import { log } from "../../logger.js";
import {
  type TrustGapEvent,
  type AgentTrustProfile,
  PATTERN_LEARNING_THRESHOLD,
} from "./types.js";
import type { TaskType } from "../micro-runner.js";
import type { GovernanceRuleStore } from "./rule-store.js";

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trust_gap_events (
    id            SERIAL PRIMARY KEY,
    model_family  TEXT NOT NULL,
    task_type     TEXT NOT NULL,
    rule_category TEXT NOT NULL,
    violation     TEXT NOT NULL,
    caught_by     TEXT NOT NULL DEFAULT 'shadow',
    session_id    TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trust_gap_model_task
    ON trust_gap_events(model_family, task_type)`,
  `CREATE INDEX IF NOT EXISTS idx_trust_gap_category
    ON trust_gap_events(rule_category)`,
];

// ─── SQL ────────────────────────────────────────────────────

const SQL = {
  insertEvent: `
    INSERT INTO trust_gap_events
      (model_family, task_type, rule_category, violation, caught_by, session_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
  countByPattern: `
    SELECT COUNT(*)::int AS count
    FROM trust_gap_events
    WHERE model_family = $1
      AND task_type = $2
      AND rule_category = $3
  `,
  getTrustProfile: `
    SELECT
      model_family,
      task_type,
      COUNT(*)::int AS total_gaps,
      array_agg(DISTINCT rule_category ORDER BY rule_category) AS categories,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen
    FROM trust_gap_events
    WHERE model_family = $1 AND task_type = $2
    GROUP BY model_family, task_type
  `,
  totalRequestEstimate: `
    SELECT COUNT(DISTINCT session_id)::int AS sessions
    FROM trust_gap_events
    WHERE model_family = $1 AND task_type = $2
  `,
};

// ─── Store Interface ────────────────────────────────────────

export interface TrustGapStore {
  /** Record a trust-gap event and check for auto-learn triggers */
  recordGap(event: TrustGapEvent, ruleStore: GovernanceRuleStore): Promise<void>;
  /** Get aggregate trust profile for a (modelFamily, taskType) pair */
  getProfile(modelFamily: string, taskType: TaskType): Promise<AgentTrustProfile | null>;
  close(): void;
}

// ─── Factory ────────────────────────────────────────────────

export async function createTrustGapStore(pool: Pool): Promise<TrustGapStore> {
  await initSchema(pool, SCHEMA_STATEMENTS);

  return {
    async recordGap(event: TrustGapEvent, ruleStore: GovernanceRuleStore): Promise<void> {
      // 1. Persist the event
      await pool.query(SQL.insertEvent, [
        event.modelFamily,
        event.taskType,
        event.ruleCategory,
        event.violation,
        event.caughtBy,
        event.sessionId,
        event.timestamp,
      ]);

      log.gemini.info({
        modelFamily: event.modelFamily,
        taskType: event.taskType,
        ruleCategory: event.ruleCategory,
        violation: event.violation,
        caughtBy: event.caughtBy,
      }, "governance:trust-gap-recorded");

      // 2. Check pattern threshold for auto-rule generation
      const { rows } = await pool.query(SQL.countByPattern, [
        event.modelFamily,
        event.taskType,
        event.ruleCategory,
      ]);
      const count = (rows[0] as { count: number }).count;

      if (count >= PATTERN_LEARNING_THRESHOLD) {
        await maybeGenerateLearnedRule(event, count, ruleStore);
      }
    },

    async getProfile(modelFamily: string, taskType: TaskType): Promise<AgentTrustProfile | null> {
      const { rows } = await pool.query(SQL.getTrustProfile, [modelFamily, taskType]);
      if (rows.length === 0) return null;

      const row = rows[0] as {
        model_family: string;
        task_type: string;
        total_gaps: number;
        categories: string[];
        first_seen: Date;
        last_seen: Date;
      };

      // Estimate total requests from distinct sessions
      const { rows: sessionRows } = await pool.query(SQL.totalRequestEstimate, [modelFamily, taskType]);
      const totalSessions = (sessionRows[0] as { sessions: number }).sessions;
      // Conservative: trust-gap sessions are a subset; assume 5x total traffic
      const estimatedTotal = Math.max(totalSessions * 5, row.total_gaps);

      return {
        modelFamily: row.model_family,
        taskType: row.task_type as TaskType,
        totalRequests: estimatedTotal,
        trustGaps: row.total_gaps,
        gapRate: row.total_gaps / estimatedTotal,
        commonViolations: row.categories.slice(0, 5),
        firstSeen: row.first_seen.toISOString(),
        lastSeen: row.last_seen.toISOString(),
      };
    },

    close(): void {
      // Pool lifecycle managed externally
    },
  };
}

// ─── Auto-Rule Generation ───────────────────────────────────

/**
 * Generate a learned governance rule when a failure pattern repeats enough.
 * Idempotent: checks if a rule for this pattern already exists.
 */
async function maybeGenerateLearnedRule(
  event: TrustGapEvent,
  occurrences: number,
  ruleStore: GovernanceRuleStore,
): Promise<void> {
  const ruleId = `learned:${event.modelFamily}:${event.taskType}:${event.ruleCategory}`;

  // Check if already generated
  const existing = await ruleStore.getRule(ruleId);
  if (existing) {
    // Reinforce confidence on existing rule
    await ruleStore.recordCorrection(ruleId, -1);
    return;
  }

  // Generate the rule text based on the violation pattern
  const ruleText = generateLearnedRuleText(event);

  await ruleStore.createRule(
    ruleId,
    ruleText,
    event.ruleCategory,
    "should",
    "learned",
    {
      taskType: event.taskType,
      modelFamily: event.modelFamily,
    },
  );

  log.gemini.info({
    ruleId,
    ruleText,
    occurrences,
    modelFamily: event.modelFamily,
    taskType: event.taskType,
    ruleCategory: event.ruleCategory,
  }, "governance:learned-rule-generated");
}

/**
 * Map violation categories to actionable rule text.
 */
function generateLearnedRuleText(event: TrustGapEvent): string {
  switch (event.ruleCategory) {
    case "no fabricated system diagnostics":
      return "Require tool verification before claiming system state or diagnostics";
    case "no unqualified patch or version claims":
      return "Require uncertainty qualifier for all patch/version references";
    case "no roster or data claims for entities not in context":
      return "Require entity presence in context before citing roster data";
    case "no numeric claims unless cited from T1/T2":
      return "Require T1/T2 source attribution for all numeric game data claims";
    case "cite source tier for all factual claims":
      return "Require explicit source tier citation for factual claims";
    default:
      return `Require verification for ${event.ruleCategory} in ${event.taskType} tasks`;
  }
}
