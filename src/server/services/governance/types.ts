/**
 * governance/types.ts — Runtime Governance Type Definitions
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Types for the private runtime constraint layer adapted from LexSona
 * methodology. This module defines the core type vocabulary for:
 *   - Governance rules with scope-based specificity scoring
 *   - Derived constraint sets
 *   - Trust-gap events and agent trust profiles
 *
 * See MAJEL_PRIVATE_GOVERNANCE_FIT_2026-04-10.md for design rationale.
 */

import type { TaskType } from "../micro-runner.js";

// ─── Rule Scope & Specificity ───────────────────────────────

/** Severity levels for governance rules */
export type RuleSeverity = "must" | "should" | "style";

/** Source of a governance rule */
export type RuleSource = "baseline" | "learned" | "manual";

/**
 * Scope determines WHEN a rule fires.
 * More specific scopes score higher in derivation.
 * Null fields match everything (wildcard).
 */
export interface RuleScope {
  /** Task type (e.g. "reference_lookup"). Null = all tasks. */
  taskType: TaskType | null;
  /** Model family prefix (e.g. "gemini-2.5-flash"). Null = all models. */
  modelFamily: string | null;
  /** User/tenant ID. Null = global. */
  userId: string | null;
  /** Procedure mode. Null = all modes. */
  procedureMode: "chat" | "bulk" | "repair" | null;
}

/**
 * Specificity scoring weights for rule scope dimensions.
 * Higher total score = more targeted rule = higher priority.
 * Adapted from LexSona's calculateScopeSpecificity().
 */
export const SPECIFICITY_WEIGHTS = {
  taskType: 4,
  modelFamily: 3,
  userId: 3,
  procedureMode: 2,
} as const;

// ─── Governance Rule ────────────────────────────────────────

/**
 * A governance rule stored in the database.
 * Uses Beta-Binomial confidence model matching behavior-store.ts.
 */
export interface GovernanceRule {
  id: string;
  text: string;
  scope: RuleScope;
  category: string;
  severity: RuleSeverity;
  source: RuleSource;
  /** Beta-Binomial success count. Starts at 2 (skeptical prior). */
  alpha: number;
  /** Beta-Binomial failure count. Starts at 5 (skeptical prior). */
  beta: number;
  /** Total observations */
  observationCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Skeptical prior: new rules start unconvinced */
export const PRIOR_ALPHA = 2;
export const PRIOR_BETA = 5;

/** Minimum observations before a rule activates */
export const MIN_OBSERVATIONS = 3;

/** Minimum confidence (α / (α + β)) for a rule to activate */
export const MIN_CONFIDENCE = 0.5;

/** Compute Beta-Binomial confidence */
export function confidence(rule: GovernanceRule): number {
  return rule.alpha / (rule.alpha + rule.beta);
}

/** Check if a rule meets activation threshold */
export function isActive(rule: GovernanceRule): boolean {
  return rule.observationCount >= MIN_OBSERVATIONS && confidence(rule) >= MIN_CONFIDENCE;
}

// ─── Derived Constraint ─────────────────────────────────────

/**
 * A single derived constraint — the output of the derivation engine.
 * Computed per-request, never stored.
 */
export interface DerivedConstraint {
  ruleId: string;
  text: string;
  severity: RuleSeverity;
  /** Effective confidence after scope scoring and trust calibration */
  effectiveConfidence: number;
  category: string;
  source: RuleSource;
  /** Specificity score from scope matching */
  specificity: number;
}

/**
 * The full derived constraint set for a single request.
 * Deterministic: same inputs → same outputs.
 */
export interface DerivedConstraintSet {
  /** Deterministic hash of the derivation inputs */
  inputHash: string;
  /** Active constraints sorted by specificity → severity → confidence */
  constraints: DerivedConstraint[];
  metadata: {
    rulesConsidered: number;
    rulesFiltered: number;
    confidenceThreshold: number;
    trustAdjustment: number;
  };
}

// ─── Trust Gap ──────────────────────────────────────────────

/**
 * A trust-gap event emitted when a validation violation occurs.
 * Recorded for pattern learning — after ≥3 identical failures,
 * a learned rule is auto-generated.
 */
export interface TrustGapEvent {
  /** Model family that produced the violation */
  modelFamily: string;
  /** Task type during which the violation occurred */
  taskType: TaskType;
  /** Invariant or rule category that was violated */
  ruleCategory: string;
  /** Specific violation text */
  violation: string;
  /** Whether the runtime caught it (enforce) or shadow mode logged it */
  caughtBy: "runtime" | "shadow" | "regression";
  /** Session ID for correlation */
  sessionId: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Aggregated trust profile for a (modelFamily, taskType) pair.
 * Used to calibrate confidence on rules for known-weak combos.
 */
export interface AgentTrustProfile {
  modelFamily: string;
  taskType: TaskType;
  totalRequests: number;
  trustGaps: number;
  gapRate: number;
  commonViolations: string[];
  firstSeen: string;
  lastSeen: string;
}

/** Gap rate threshold before confidence reduction kicks in */
export const GAP_RATE_THRESHOLD = 0.2;

/** Maximum confidence reduction factor (30%) */
export const MAX_CONFIDENCE_REDUCTION = 0.3;

/** Minimum trust-gap events before auto-rule generation */
export const PATTERN_LEARNING_THRESHOLD = 3;
