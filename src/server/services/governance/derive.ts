/**
 * governance/derive.ts — Specificity-Scored Constraint Derivation
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Pure function: derives a constraint set from governance rules + context.
 * No side effects, no network requests, deterministic.
 *
 * Adapted from LexSona's derive.ts scoring pipeline:
 *   1. Filter by scope match
 *   2. Filter by activation threshold
 *   3. Score by specificity (exact > prefix > wildcard)
 *   4. Sort by specificity → severity → confidence → id
 *   5. Apply trust calibration
 *   6. Hash inputs for deterministic replay
 *
 * This replaces the hardcoded switch in compileTask() for rule selection.
 */

import { createHash } from "node:crypto";
import type { GovernanceContext } from "../micro-runner.js";
import type { TaskType } from "../micro-runner.js";
import type { ScoredGovernanceRule } from "./rule-store.js";
import {
  type DerivedConstraint,
  type DerivedConstraintSet,
  type AgentTrustProfile,
  MIN_OBSERVATIONS,
  MIN_CONFIDENCE,
  GAP_RATE_THRESHOLD,
  MAX_CONFIDENCE_REDUCTION,
  confidence,
} from "./types.js";

/** Floating-point tolerance for confidence comparison */
const CONFIDENCE_EPSILON = 0.0001;

/** Maximum constraints returned per derivation */
const MAX_CONSTRAINTS = 50;

/** Severity sort order: must first, style last */
const SEVERITY_ORDER: Record<string, number> = { must: 0, should: 1, style: 2 };

/**
 * Derive a constraint set from scored governance rules.
 *
 * PURE FUNCTION — same inputs produce identical outputs.
 * No database calls, no side effects.
 */
export function deriveConstraints(
  rules: ScoredGovernanceRule[],
  governance: GovernanceContext,
  taskType: TaskType,
  trustProfile?: AgentTrustProfile,
): DerivedConstraintSet {
  const rulesConsidered = rules.length;

  // Step 1: Filter by activation threshold
  const activeRules = rules.filter(
    (r) => r.observationCount >= MIN_OBSERVATIONS && confidence(r) >= MIN_CONFIDENCE,
  );

  const rulesFiltered = rulesConsidered - activeRules.length;

  // Step 2: Compute trust adjustment
  let trustAdjustment = 1.0;
  if (trustProfile && trustProfile.gapRate > GAP_RATE_THRESHOLD) {
    trustAdjustment = 1.0 - Math.min(MAX_CONFIDENCE_REDUCTION, trustProfile.gapRate);
  }

  // Step 3: Score and sort
  const sorted = activeRules.sort((a, b) => {
    // Specificity (higher first)
    const specDiff = b.specificity - a.specificity;
    if (specDiff !== 0) return specDiff;

    // Severity (must > should > style)
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2);
    if (sevDiff !== 0) return sevDiff;

    // Confidence (higher first)
    const confA = confidence(a) * trustAdjustment;
    const confB = confidence(b) * trustAdjustment;
    const confDiff = confB - confA;
    if (Math.abs(confDiff) > CONFIDENCE_EPSILON) return confDiff;

    // Deterministic tiebreak: id
    return a.id.localeCompare(b.id);
  });

  // Step 4: Limit and convert to constraints
  const limited = sorted.slice(0, MAX_CONSTRAINTS);
  const constraints: DerivedConstraint[] = limited.map((rule) => ({
    ruleId: rule.id,
    text: rule.text,
    severity: rule.severity,
    effectiveConfidence: confidence(rule) * trustAdjustment,
    category: rule.category,
    source: rule.source,
    specificity: rule.specificity,
  }));

  // Step 5: Compute input hash for deterministic replay
  const inputHash = computeInputHash(rules, governance, taskType, trustProfile);

  return {
    inputHash,
    constraints,
    metadata: {
      rulesConsidered,
      rulesFiltered,
      confidenceThreshold: MIN_CONFIDENCE,
      trustAdjustment,
    },
  };
}

/**
 * Compute a stable SHA-256 hash of derivation inputs.
 * Enables exact replay and diffing of constraint sets across runs.
 */
function computeInputHash(
  rules: ScoredGovernanceRule[],
  governance: GovernanceContext,
  taskType: TaskType,
  trustProfile?: AgentTrustProfile,
): string {
  const ruleIds = rules.map((r) => r.id).sort();
  const input = {
    ruleIds,
    governance: {
      userId: governance.userId,
      modelFamily: governance.modelFamily,
      procedureMode: governance.procedureMode,
      role: governance.role,
    },
    taskType,
    trustGapRate: trustProfile?.gapRate ?? 0,
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}
