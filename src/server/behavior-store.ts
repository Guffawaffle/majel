/**
 * behavior-store.ts — Behavioral Rules Store (ADR-014 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * SQLite-backed behavioral rule storage with Bayesian confidence scoring.
 * Rules govern HOW Aria answers (tone, format, source citation habits),
 * NOT what she believes about STFC meta.
 *
 * Adapted from LexSona's behavioral memory socket pattern (API shape only,
 * no code imported). Uses a Beta-Binomial model for confidence scoring.
 *
 * See ADR-014 "Behavioral Rules" section for design rationale.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger.js";
import type { TaskType } from "./micro-runner.js";

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
  getRules(taskType: TaskType): BehaviorRule[];

  /**
   * Record feedback: the Admiral corrected Aria → adjust rule confidence.
   * polarity +1 = rule was helpful (increase α), -1 = rule was wrong (increase β).
   */
  recordCorrection(ruleId: string, polarity: 1 | -1): BehaviorRule | null;

  /**
   * Create a new behavioral rule with the skeptical prior.
   */
  createRule(
    id: string,
    text: string,
    severity: RuleSeverity,
    taskType?: TaskType,
  ): BehaviorRule;

  /**
   * Get a specific rule by ID.
   */
  getRule(id: string): BehaviorRule | null;

  /**
   * List all rules (including inactive ones below threshold).
   */
  listRules(): BehaviorRule[];

  /**
   * Delete a rule.
   */
  deleteRule(id: string): boolean;

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
  counts(): { total: number; active: number; inactive: number };
}

// ─── Schema ─────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS behavior_rules (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    task_type     TEXT,
    alpha         REAL NOT NULL DEFAULT ${PRIOR_ALPHA},
    beta          REAL NOT NULL DEFAULT ${PRIOR_BETA},
    observation_count INTEGER NOT NULL DEFAULT 0,
    severity      TEXT NOT NULL DEFAULT 'should',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_behavior_rules_task_type
    ON behavior_rules(task_type);
`;

// ─── Implementation ─────────────────────────────────────────

/**
 * Create a BehaviorStore backed by SQLite.
 *
 * @param dbPath — Path to the SQLite database file. Defaults to data/behavior.db.
 */
export function createBehaviorStore(dbPath?: string): BehaviorStore {
  const resolvedPath = dbPath ?? path.resolve("data", "behavior.db");

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  // ── Prepared Statements ─────────────────────────────────

  const stmts = {
    insert: db.prepare(`
      INSERT INTO behavior_rules (id, text, task_type, alpha, beta, observation_count, severity, created_at, updated_at)
      VALUES (@id, @text, @taskType, @alpha, @beta, @observationCount, @severity, @createdAt, @updatedAt)
    `),

    getById: db.prepare(`
      SELECT * FROM behavior_rules WHERE id = ?
    `),

    listAll: db.prepare(`
      SELECT * FROM behavior_rules ORDER BY (alpha * 1.0 / (alpha + beta)) DESC
    `),

    getByTaskType: db.prepare(`
      SELECT * FROM behavior_rules
      WHERE (task_type IS NULL OR task_type = ?)
        AND observation_count >= ?
        AND (alpha * 1.0 / (alpha + beta)) >= ?
      ORDER BY (alpha * 1.0 / (alpha + beta)) DESC
    `),

    update: db.prepare(`
      UPDATE behavior_rules
      SET alpha = @alpha,
          beta = @beta,
          observation_count = @observationCount,
          updated_at = @updatedAt
      WHERE id = @id
    `),

    deleteById: db.prepare(`
      DELETE FROM behavior_rules WHERE id = ?
    `),

    countAll: db.prepare(`
      SELECT COUNT(*) as total FROM behavior_rules
    `),

    countActive: db.prepare(`
      SELECT COUNT(*) as active FROM behavior_rules
      WHERE observation_count >= ?
        AND (alpha * 1.0 / (alpha + beta)) >= ?
    `),
  };

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
    getRules(taskType: TaskType): BehaviorRule[] {
      const rows = stmts.getByTaskType.all(
        taskType,
        MIN_OBSERVATIONS,
        MIN_CONFIDENCE,
      ) as Record<string, unknown>[];
      return rows.map(rowToRule);
    },

    recordCorrection(ruleId: string, polarity: 1 | -1): BehaviorRule | null {
      const row = stmts.getById.get(ruleId) as Record<string, unknown> | undefined;
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

      stmts.update.run({
        id: rule.id,
        alpha: rule.alpha,
        beta: rule.beta,
        observationCount: rule.observationCount,
        updatedAt: now,
      });

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

    createRule(
      id: string,
      text: string,
      severity: RuleSeverity = "should",
      taskType?: TaskType,
    ): BehaviorRule {
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

      stmts.insert.run({
        id: rule.id,
        text: rule.text,
        taskType: rule.scope.taskType ?? null,
        alpha: rule.alpha,
        beta: rule.beta,
        observationCount: rule.observationCount,
        severity: rule.severity,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      });

      log.gemini.debug({
        ruleId: id,
        severity,
        taskType: taskType ?? "all",
        confidence: computeConfidence(rule).toFixed(3),
      }, "behavior:create");

      return rule;
    },

    getRule(id: string): BehaviorRule | null {
      const row = stmts.getById.get(id) as Record<string, unknown> | undefined;
      return row ? rowToRule(row) : null;
    },

    listRules(): BehaviorRule[] {
      const rows = stmts.listAll.all() as Record<string, unknown>[];
      return rows.map(rowToRule);
    },

    deleteRule(id: string): boolean {
      const result = stmts.deleteById.run(id);
      return result.changes > 0;
    },

    confidence: computeConfidence,

    isActive: checkActive,

    close(): void {
      db.close();
    },

    counts(): { total: number; active: number; inactive: number } {
      const total = (stmts.countAll.get() as { total: number }).total;
      const active = (stmts.countActive.get(MIN_OBSERVATIONS, MIN_CONFIDENCE) as { active: number }).active;
      return { total, active, inactive: total - active };
    },
  };
}
