/**
 * governance/rule-store.ts — Governance Rule Store (PostgreSQL)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Stores governance rules with scope-based filtering and specificity scoring.
 * Rules are retrieved per-request, scored by scope match, and fed into the
 * constraint derivation engine.
 *
 * Adapted from LexSona's behavioral rules store — API shape only, no imports.
 */

import { initSchema, type Pool } from "../../db.js";
import { log } from "../../logger.js";
import type { TaskType } from "../micro-runner.js";
import type { GovernanceContext } from "../micro-runner.js";
import {
  type GovernanceRule,
  type RuleScope,
  type RuleSeverity,
  type RuleSource,
  PRIOR_ALPHA,
  PRIOR_BETA,
  SPECIFICITY_WEIGHTS,
  MIN_OBSERVATIONS,
  MIN_CONFIDENCE,
} from "./types.js";

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS governance_rules (
    id                TEXT PRIMARY KEY,
    text              TEXT NOT NULL,
    scope_task_type   TEXT,
    scope_model_family TEXT,
    scope_user_id     TEXT,
    scope_procedure   TEXT,
    category          TEXT NOT NULL,
    severity          TEXT NOT NULL DEFAULT 'should',
    source            TEXT NOT NULL DEFAULT 'manual',
    alpha             DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_ALPHA},
    beta              DOUBLE PRECISION NOT NULL DEFAULT ${PRIOR_BETA},
    observation_count INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_rules_scope
    ON governance_rules(scope_task_type, scope_model_family)`,
  `CREATE INDEX IF NOT EXISTS idx_governance_rules_category
    ON governance_rules(category)`,
];

// ─── SQL Queries ────────────────────────────────────────────

const SQL = {
  insert: `
    INSERT INTO governance_rules
      (id, text, scope_task_type, scope_model_family, scope_user_id, scope_procedure,
       category, severity, source, alpha, beta, observation_count, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `,
  getById: `SELECT * FROM governance_rules WHERE id = $1`,
  listAll: `SELECT * FROM governance_rules ORDER BY category, id`,
  getMatching: `
    SELECT *
    FROM governance_rules
    WHERE (scope_task_type IS NULL OR scope_task_type = $1)
      AND (scope_model_family IS NULL OR $2 LIKE scope_model_family || '%')
      AND (scope_user_id IS NULL OR scope_user_id = $3)
      AND (scope_procedure IS NULL OR scope_procedure = $4)
    ORDER BY id
  `,
  atomicCorrection: `
    UPDATE governance_rules
    SET alpha = alpha + $1, beta = beta + $2,
        observation_count = observation_count + 1,
        updated_at = $3
    WHERE id = $4
    RETURNING *
  `,
  deleteById: `DELETE FROM governance_rules WHERE id = $1`,
};

// ─── Store Interface ────────────────────────────────────────

export interface GovernanceRuleStore {
  /** Get rules matching a governance context, with specificity scores computed */
  getMatchingRules(ctx: GovernanceContext, taskType: TaskType): Promise<ScoredGovernanceRule[]>;
  /** Record positive or negative feedback on a rule */
  recordCorrection(ruleId: string, polarity: 1 | -1): Promise<GovernanceRule | null>;
  /** Create a rule (for seeding baselines or auto-generated learned rules) */
  createRule(
    id: string,
    text: string,
    category: string,
    severity: RuleSeverity,
    source: RuleSource,
    scope?: Partial<RuleScope>,
  ): Promise<GovernanceRule>;
  /** List all rules */
  listRules(): Promise<GovernanceRule[]>;
  /** Get a single rule by ID */
  getRule(id: string): Promise<GovernanceRule | null>;
  /** Delete a rule */
  deleteRule(id: string): Promise<boolean>;
  close(): void;
}

/** A governance rule with its computed specificity score */
export interface ScoredGovernanceRule extends GovernanceRule {
  specificity: number;
}

// ─── Row Mapping ────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): GovernanceRule {
  return {
    id: row.id as string,
    text: row.text as string,
    scope: {
      taskType: (row.scope_task_type as TaskType | null) ?? null,
      modelFamily: (row.scope_model_family as string | null) ?? null,
      userId: (row.scope_user_id as string | null) ?? null,
      procedureMode: (row.scope_procedure as RuleScope["procedureMode"]) ?? null,
    },
    category: row.category as string,
    severity: row.severity as RuleSeverity,
    source: row.source as RuleSource,
    alpha: row.alpha as number,
    beta: row.beta as number,
    observationCount: row.observation_count as number,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Compute specificity score for a rule relative to a governance context.
 * Higher = more targeted.
 */
function computeSpecificity(rule: GovernanceRule, ctx: GovernanceContext, taskType: TaskType): number {
  let score = 0;
  if (rule.scope.taskType !== null && rule.scope.taskType === taskType) {
    score += SPECIFICITY_WEIGHTS.taskType;
  }
  if (rule.scope.modelFamily !== null && ctx.modelFamily.startsWith(rule.scope.modelFamily)) {
    score += SPECIFICITY_WEIGHTS.modelFamily;
  }
  if (rule.scope.userId !== null && rule.scope.userId === ctx.userId) {
    score += SPECIFICITY_WEIGHTS.userId;
  }
  if (rule.scope.procedureMode !== null && rule.scope.procedureMode === ctx.procedureMode) {
    score += SPECIFICITY_WEIGHTS.procedureMode;
  }
  return score;
}

// ─── Factory ────────────────────────────────────────────────

export async function createGovernanceRuleStore(adminPool: Pool, runtimePool?: Pool): Promise<GovernanceRuleStore> {
  await initSchema(adminPool, SCHEMA_STATEMENTS);
  const pool = runtimePool ?? adminPool;

  return {
    async getMatchingRules(ctx: GovernanceContext, taskType: TaskType): Promise<ScoredGovernanceRule[]> {
      const { rows } = await pool.query(SQL.getMatching, [
        taskType,
        ctx.modelFamily,
        ctx.userId,
        ctx.procedureMode,
      ]);
      return (rows as Record<string, unknown>[])
        .map(mapRow)
        .map((rule) => ({
          ...rule,
          specificity: computeSpecificity(rule, ctx, taskType),
        }));
    },

    async recordCorrection(ruleId: string, polarity: 1 | -1): Promise<GovernanceRule | null> {
      const alphaInc = polarity === 1 ? 1 : 0;
      const betaInc = polarity === -1 ? 1 : 0;
      const { rows } = await pool.query(SQL.atomicCorrection, [
        alphaInc,
        betaInc,
        new Date().toISOString(),
        ruleId,
      ]);
      if (rows.length === 0) return null;
      return mapRow(rows[0] as Record<string, unknown>);
    },

    async createRule(
      id: string,
      text: string,
      category: string,
      severity: RuleSeverity,
      source: RuleSource,
      scope?: Partial<RuleScope>,
    ): Promise<GovernanceRule> {
      const now = new Date().toISOString();
      await pool.query(SQL.insert, [
        id,
        text,
        scope?.taskType ?? null,
        scope?.modelFamily ?? null,
        scope?.userId ?? null,
        scope?.procedureMode ?? null,
        category,
        severity,
        source,
        PRIOR_ALPHA,
        PRIOR_BETA,
        0,
        now,
        now,
      ]);
      return {
        id,
        text,
        scope: {
          taskType: scope?.taskType ?? null,
          modelFamily: scope?.modelFamily ?? null,
          userId: scope?.userId ?? null,
          procedureMode: scope?.procedureMode ?? null,
        },
        category,
        severity,
        source,
        alpha: PRIOR_ALPHA,
        beta: PRIOR_BETA,
        observationCount: 0,
        createdAt: now,
        updatedAt: now,
      };
    },

    async listRules(): Promise<GovernanceRule[]> {
      const { rows } = await pool.query(SQL.listAll);
      return (rows as Record<string, unknown>[]).map(mapRow);
    },

    async getRule(id: string): Promise<GovernanceRule | null> {
      const { rows } = await pool.query(SQL.getById, [id]);
      if (rows.length === 0) return null;
      return mapRow(rows[0] as Record<string, unknown>);
    },

    async deleteRule(id: string): Promise<boolean> {
      const result = await pool.query(SQL.deleteById, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    close(): void {
      // Pool lifecycle managed externally
    },
  };
}
