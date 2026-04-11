/**
 * behavior-store.ts — Behavioral Rules Store (ADR-014 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * PostgreSQL-backed behavioral rule storage with Bayesian confidence scoring.
 * Rules govern HOW Aria answers (tone, format, source citation habits),
 * NOT what she believes about STFC meta.
 *
 * Adapted from LexSona's behavioral memory socket pattern (API shape only,
 * no code imported). Uses a Beta-Binomial model for confidence scoring.
 *
 * See ADR-014 "Behavioral Rules" section for design rationale.
 * Migrated to PostgreSQL in ADR-018 Phase 3.
 */

import { initSchema, type Pool } from "../db.js";
import { log } from "../logger.js";
import type { TaskType } from "../services/micro-runner.js";

// ─── Types ──────────────────────────────────────────────────

export type RuleSeverity = "must" | "should" | "style";

export interface BehaviorRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable directive */
  text: string;
  /** When this rule applies (null taskType = all tasks) */
  scope: { taskType?: TaskType; userId?: string };
  /** Success count (Beta-Binomial α). Starts at 2 (skeptical prior). */
  alpha: number;
  /** Failure count (Beta-Binomial β). Starts at 5 (skeptical prior). */
  beta: number;
  /** Total reinforcement observations */
  observationCount: number;
  /** Enforcement level */
  severity: RuleSeverity;
  /**
   * Computed specificity score (higher = more targeted).
   * Present when returned from getRules(); absent on create/getRule.
   */
  specificity?: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Computed confidence = α / (α + β).
 * A rule fires when observationCount >= MIN_OBSERVATIONS AND confidence >= MIN_CONFIDENCE.
 */
export const MIN_OBSERVATIONS = 3;
export const MIN_CONFIDENCE = 0.5;

/** Skeptical prior: new rules start unconvinced */
export const PRIOR_ALPHA = 2;
export const PRIOR_BETA = 5;

/** Maximum rules per user to prevent volume-based pollution attacks */
export const MAX_RULES_PER_USER = 50;

/**
 * Specificity scoring weights for rule scope dimensions.
 * More-targeted rules rank higher than broad rules,
 * regardless of confidence. Adapted from LexSona methodology.
 */
export const SPECIFICITY_WEIGHTS = {
  /** Rule targets a specific task type (vs. null = all tasks) */
  taskType: 4,
  /** Rule targets a specific user (vs. null = global) */
  userId: 3,
} as const;

export interface BehaviorStore {
  /**
   * Retrieve active rules matching a task type, sorted by confidence descending.
   * Only returns rules that meet the activation threshold.
   * When userId is provided, returns user-scoped rules + global (null userId) fallback.
   */
  getRules(taskType: TaskType, userId?: string): Promise<BehaviorRule[]>;

  /**
   * Record feedback: the Admiral corrected Aria → adjust rule confidence.
   * polarity +1 = rule was helpful (increase α), -1 = rule was wrong (increase β).
   */
  recordCorrection(ruleId: string, polarity: 1 | -1): Promise<BehaviorRule | null>;

  /**
   * Create a new behavioral rule with the skeptical prior.
   * When userId is provided, the rule is scoped to that user.
   */
  createRule(
    id: string,
    text: string,
    severity: RuleSeverity,
    taskType?: TaskType,
    userId?: string,
  ): Promise<BehaviorRule>;

  /**
   * Get a specific rule by ID.
   */
  getRule(id: string): Promise<BehaviorRule | null>;

  /**
   * List all rules (including inactive ones below threshold).
   */
  listRules(): Promise<BehaviorRule[]>;

  /**
   * Delete a rule.
   */
  deleteRule(id: string): Promise<boolean>;

  /**
   * Compute confidence for a rule: α / (α + β).
   */
  confidence(rule: BehaviorRule): number;

  /**
   * Check if a rule meets the activation threshold.
   */
  isActive(rule: BehaviorRule): boolean;

  /** Close the database connection. */
  close(): void;

  /** Get rule counts by state. */
  counts(): Promise<{ total: number; active: number; inactive: number }>;
}

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS behavior_rules (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    task_type     TEXT,
    user_id       TEXT,
    alpha         DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_ALPHA},
    beta          DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_BETA},
    observation_count INTEGER NOT NULL DEFAULT 0,
    severity      TEXT NOT NULL DEFAULT 'should',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_rules_task_type
    ON behavior_rules(task_type)`,
  // Migration: add user_id column to existing tables
  `DO $$ BEGIN
    ALTER TABLE behavior_rules ADD COLUMN IF NOT EXISTS user_id TEXT;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_rules_user_id
    ON behavior_rules(user_id)`,
];

// ─── SQL Queries ────────────────────────────────────────────

const SQL = {
  insert: `
    INSERT INTO behavior_rules (id, text, task_type, user_id, alpha, beta, observation_count, severity, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `,
  getById: `SELECT * FROM behavior_rules WHERE id = $1`,
  listAll: `SELECT * FROM behavior_rules ORDER BY (alpha / (alpha + beta)) DESC`,
  getByTaskType: `
    SELECT *,
      (CASE WHEN task_type IS NOT NULL THEN ${SPECIFICITY_WEIGHTS.taskType} ELSE 0 END
       + CASE WHEN user_id IS NOT NULL THEN ${SPECIFICITY_WEIGHTS.userId} ELSE 0 END
      ) AS specificity
    FROM behavior_rules
    WHERE (task_type IS NULL OR task_type = $1)
      AND (user_id IS NULL OR user_id = $2)
      AND observation_count >= $3
      AND (alpha / (alpha + beta)) >= $4
    ORDER BY specificity DESC,
             CASE severity WHEN 'must' THEN 0 WHEN 'should' THEN 1 ELSE 2 END,
             (alpha / (alpha + beta)) DESC,
             id
  `,
  update: `
    UPDATE behavior_rules
    SET alpha = $1, beta = $2, observation_count = $3, updated_at = $4
    WHERE id = $5
  `,
  // Atomic increment — avoids read-modify-write race in recordCorrection
  atomicCorrection: `
    UPDATE behavior_rules
    SET alpha = alpha + $1, beta = beta + $2,
        observation_count = observation_count + 1,
        updated_at = $3
    WHERE id = $4
    RETURNING *
  `,
  deleteById: `DELETE FROM behavior_rules WHERE id = $1`,
  countAll: `SELECT COUNT(*) as total FROM behavior_rules`,
  countActive: `
    SELECT COUNT(*) as active FROM behavior_rules
    WHERE observation_count >= $1
      AND (alpha / (alpha + beta)) >= $2
  `,
  countByUser: `
    SELECT COUNT(*) as count FROM behavior_rules
    WHERE user_id = $1
  `,
};

// ─── Implementation ─────────────────────────────────────────

/**
 * Create a BehaviorStore backed by PostgreSQL.
 */
export async function createBehaviorStore(adminPool: Pool, runtimePool?: Pool): Promise<BehaviorStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  // ── Row Mapping ─────────────────────────────────────────

  function rowToRule(row: Record<string, unknown>): BehaviorRule {
    return {
      id: row.id as string,
      text: row.text as string,
      scope: {
        taskType: (row.task_type as TaskType) || undefined,
        userId: (row.user_id as string) || undefined,
      },
      alpha: row.alpha as number,
      beta: row.beta as number,
      observationCount: row.observation_count as number,
      severity: row.severity as RuleSeverity,
      ...(row.specificity != null ? { specificity: Number(row.specificity) } : {}),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  function computeConfidence(rule: BehaviorRule): number {
    return rule.alpha / (rule.alpha + rule.beta);
  }

  function checkActive(rule: BehaviorRule): boolean {
    return rule.observationCount >= MIN_OBSERVATIONS
      && computeConfidence(rule) >= MIN_CONFIDENCE;
  }

  // ── Store Implementation ────────────────────────────────

  return {
    async getRules(taskType: TaskType, userId?: string): Promise<BehaviorRule[]> {
      const uid = userId || null; // coerce empty string to null (global)
      const result = await pool.query(SQL.getByTaskType, [taskType, uid, MIN_OBSERVATIONS, MIN_CONFIDENCE]);
      return result.rows.map((row) => rowToRule(row as Record<string, unknown>));
    },

    async recordCorrection(ruleId: string, polarity: 1 | -1): Promise<BehaviorRule | null> {
      const now = new Date().toISOString();
      const alphaInc = polarity === 1 ? 1 : 0;
      const betaInc = polarity === 1 ? 0 : 1;

      // Atomic UPDATE ... RETURNING — no read-modify-write race
      const result = await pool.query(SQL.atomicCorrection, [alphaInc, betaInc, now, ruleId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;

      const rule = rowToRule(row);

      log.gemini.debug({
        ruleId: rule.id,
        polarity,
        alpha: rule.alpha,
        beta: rule.beta,
        confidence: computeConfidence(rule).toFixed(3),
        active: checkActive(rule),
      }, "behavior:correction");

      return rule;
    },

    async createRule(
      id: string,
      text: string,
      severity: RuleSeverity = "should",
      taskType?: TaskType,
      userId?: string,
    ): Promise<BehaviorRule> {
      const uid = userId || null; // coerce empty string to null (global)

      // Enforce per-user rule cap to prevent volume-based pollution
      if (uid) {
        const countResult = await pool.query(SQL.countByUser, [uid]);
        const count = Number((countResult.rows[0] as { count: string | number }).count);
        if (count >= MAX_RULES_PER_USER) {
          throw new Error(`User ${uid} has reached the maximum of ${MAX_RULES_PER_USER} behavioral rules`);
        }
      }

      const now = new Date().toISOString();
      const rule: BehaviorRule = {
        id,
        text,
        scope: { taskType, userId: uid || undefined },
        alpha: PRIOR_ALPHA,
        beta: PRIOR_BETA,
        observationCount: 0,
        severity,
        createdAt: now,
        updatedAt: now,
      };

      await pool.query(SQL.insert, [
          rule.id,
          rule.text,
          rule.scope.taskType ?? null,
          rule.scope.userId ?? null,
          rule.alpha,
          rule.beta,
          rule.observationCount,
          rule.severity,
          rule.createdAt,
          rule.updatedAt,
        ]);

      log.gemini.debug({
        ruleId: id,
        severity,
        taskType: taskType ?? "all",
        confidence: computeConfidence(rule).toFixed(3),
      }, "behavior:create");

      return rule;
    },

    async getRule(id: string): Promise<BehaviorRule | null> {
      const result = await pool.query(SQL.getById, [id]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? rowToRule(row) : null;
    },

    async listRules(): Promise<BehaviorRule[]> {
      const result = await pool.query(SQL.listAll);
      return result.rows.map((row) => rowToRule(row as Record<string, unknown>));
    },

    async deleteRule(id: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteById, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    confidence: computeConfidence,

    isActive: checkActive,

    close(): void {
      // Pool lifecycle managed externally
    },

    async counts(): Promise<{ total: number; active: number; inactive: number }> {
      const totalResult = await pool.query(SQL.countAll);
      const total = Number((totalResult.rows[0] as { total: string | number }).total);
      const activeResult = await pool.query(SQL.countActive, [MIN_OBSERVATIONS, MIN_CONFIDENCE]);
      const active = Number((activeResult.rows[0] as { active: string | number }).active);
      return { total, active, inactive: total - active };
    },
  };
}
