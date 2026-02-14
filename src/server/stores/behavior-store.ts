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
  scope: { taskType?: TaskType };
  /** Success count (Beta-Binomial α). Starts at 2 (skeptical prior). */
  alpha: number;
  /** Failure count (Beta-Binomial β). Starts at 5 (skeptical prior). */
  beta: number;
  /** Total reinforcement observations */
  observationCount: number;
  /** Enforcement level */
  severity: RuleSeverity;
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

export interface BehaviorStore {
  /**
   * Retrieve active rules matching a task type, sorted by confidence descending.
   * Only returns rules that meet the activation threshold.
   */
  getRules(taskType: TaskType): Promise<BehaviorRule[]>;

  /**
   * Record feedback: the Admiral corrected Aria → adjust rule confidence.
   * polarity +1 = rule was helpful (increase α), -1 = rule was wrong (increase β).
   */
  recordCorrection(ruleId: string, polarity: 1 | -1): Promise<BehaviorRule | null>;

  /**
   * Create a new behavioral rule with the skeptical prior.
   */
  createRule(
    id: string,
    text: string,
    severity: RuleSeverity,
    taskType?: TaskType,
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
    alpha         DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_ALPHA},
    beta          DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_BETA},
    observation_count INTEGER NOT NULL DEFAULT 0,
    severity      TEXT NOT NULL DEFAULT 'should',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_rules_task_type
    ON behavior_rules(task_type)`,
];

// ─── SQL Queries ────────────────────────────────────────────

const SQL = {
  insert: `
    INSERT INTO behavior_rules (id, text, task_type, alpha, beta, observation_count, severity, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `,
  getById: `SELECT * FROM behavior_rules WHERE id = $1`,
  listAll: `SELECT * FROM behavior_rules ORDER BY (alpha / (alpha + beta)) DESC`,
  getByTaskType: `
    SELECT * FROM behavior_rules
    WHERE (task_type IS NULL OR task_type = $1)
      AND observation_count >= $2
      AND (alpha / (alpha + beta)) >= $3
    ORDER BY (alpha / (alpha + beta)) DESC
  `,
  update: `
    UPDATE behavior_rules
    SET alpha = $1, beta = $2, observation_count = $3, updated_at = $4
    WHERE id = $5
  `,
  deleteById: `DELETE FROM behavior_rules WHERE id = $1`,
  countAll: `SELECT COUNT(*) as total FROM behavior_rules`,
  countActive: `
    SELECT COUNT(*) as active FROM behavior_rules
    WHERE observation_count >= $1
      AND (alpha / (alpha + beta)) >= $2
  `,
};

// ─── Implementation ─────────────────────────────────────────

/**
 * Create a BehaviorStore backed by PostgreSQL.
 */
export async function createBehaviorStore(pool: Pool): Promise<BehaviorStore> {
  await initSchema(pool, SCHEMA_STATEMENTS);

  // ── Row Mapping ─────────────────────────────────────────

  function rowToRule(row: Record<string, unknown>): BehaviorRule {
    return {
      id: row.id as string,
      text: row.text as string,
      scope: { taskType: (row.task_type as TaskType) || undefined },
      alpha: row.alpha as number,
      beta: row.beta as number,
      observationCount: row.observation_count as number,
      severity: row.severity as RuleSeverity,
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
    async getRules(taskType: TaskType): Promise<BehaviorRule[]> {
      const result = await pool.query(SQL.getByTaskType, [taskType, MIN_OBSERVATIONS, MIN_CONFIDENCE]);
      return result.rows.map((row) => rowToRule(row as Record<string, unknown>));
    },

    async recordCorrection(ruleId: string, polarity: 1 | -1): Promise<BehaviorRule | null> {
      const result = await pool.query(SQL.getById, [ruleId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;

      const rule = rowToRule(row);
      const now = new Date().toISOString();

      if (polarity === 1) {
        rule.alpha += 1;
      } else {
        rule.beta += 1;
      }
      rule.observationCount += 1;
      rule.updatedAt = now;

      await pool.query(SQL.update, [rule.alpha, rule.beta, rule.observationCount, now, rule.id]);

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
    ): Promise<BehaviorRule> {
      const now = new Date().toISOString();
      const rule: BehaviorRule = {
        id,
        text,
        scope: { taskType },
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
