/**
 * governance/index.ts — Public API for Majel Runtime Governance
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Re-exports the governance module surface:
 *   - Types: GovernanceRule, DerivedConstraintSet, TrustGapEvent, etc.
 *   - Stores: createGovernanceRuleStore, createTrustGapStore
 *   - Derivation: deriveConstraints (pure function)
 */

export type {
  RuleSeverity,
  RuleSource,
  RuleScope,
  GovernanceRule,
  DerivedConstraint,
  DerivedConstraintSet,
  TrustGapEvent,
  AgentTrustProfile,
} from "./types.js";

export {
  SPECIFICITY_WEIGHTS,
  PRIOR_ALPHA,
  PRIOR_BETA,
  MIN_OBSERVATIONS,
  MIN_CONFIDENCE,
  GAP_RATE_THRESHOLD,
  MAX_CONFIDENCE_REDUCTION,
  PATTERN_LEARNING_THRESHOLD,
  confidence,
  isActive,
} from "./types.js";

export { createGovernanceRuleStore } from "./rule-store.js";
export type { GovernanceRuleStore, ScoredGovernanceRule } from "./rule-store.js";

export { deriveConstraints } from "./derive.js";

export { createTrustGapStore } from "./trust-gap.js";
export type { TrustGapStore } from "./trust-gap.js";
