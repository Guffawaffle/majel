/**
 * effect-types.ts — TargetContext + EffectTag taxonomy types (ADR-034)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * These types underpin the effect-based crew recommendation engine.
 * Shared between the client-side evaluator and the server-side effect store.
 */

// ─── TargetContext ──────────────────────────────────────────

/** Coarse target classification — what are we fighting/interacting with? */
export type TargetKind = "hostile" | "player_ship" | "station" | "armada_target" | "mission_npc";

/** Combat engagement mode. */
export type Engagement = "attacking" | "defending" | "any";

/** Ship class (ours or theirs). */
export type ShipClass = "explorer" | "interceptor" | "battleship" | "survey";

/** Bridge slot context. */
export type SlotContext = "captain" | "bridge" | "below_deck";

/**
 * The full target scenario being evaluated against.
 *
 * Built from intent defaults + user overrides. A TargetContext tells the
 * evaluator "what am I facing, with what ship, in what role?"
 */
export interface TargetContext {
  targetKind: TargetKind;
  engagement: Engagement;
  targetTags: string[];
  shipContext?: {
    shipClass: ShipClass;
    shipId?: string;
    shipTags?: string[];
  };
  slotContext?: SlotContext;
}

// ─── EffectTag ──────────────────────────────────────────────

/** Effect category for grouping/display. */
export type EffectCategory =
  | "damage"
  | "survivability"
  | "control"
  | "loot"
  | "mining"
  | "officer_stats";

/** Magnitude unit for numeric effect values. */
export type MagnitudeUnit = "percent" | "flat" | "rate" | "seconds" | "rounds" | "unknown";

/** How magnitudes stack when multiple officers contribute the same effect. */
export type StackingMode = "additive" | "multiplicative" | "unknown";

/** A normalized ability effect — one row in the catalog. */
export interface EffectTag {
  /** Unique ID of this catalog entry (catalog_ability_effect.id). */
  id: string;
  /** FK to catalog_officer_ability.id */
  abilityId: string;
  /** Normalized effect type from taxonomy_effect_key. */
  effectKey: string;
  /** Optional numeric magnitude (e.g., 0.10 for 10%). Null when magnitude is unknown. */
  magnitude: number | null;
  /** Unit for the magnitude value. */
  unit: MagnitudeUnit | null;
  /** How this effect stacks with others of the same key. */
  stacking: StackingMode | null;
  /** Target kinds this effect applies to (empty = all). */
  applicableTargetKinds: string[];
  /** Target tags this effect requires (empty = no tag requirements). */
  applicableTargetTags: string[];
  /** Conditions that must be met for this effect to apply. */
  conditions: EffectCondition[];
}

/** A typed condition on an effect. */
export interface EffectCondition {
  /** Condition key from taxonomy_condition_key. */
  conditionKey: string;
  /** Optional parameters (e.g., ship class for requires_ship_class). */
  params: Record<string, string> | null;
}

// ─── Officer Ability (catalog) ──────────────────────────────

/** An officer ability slot from the catalog. */
export interface OfficerAbility {
  id: string;
  officerId: string;
  slot: "cm" | "oa" | "bda";
  name: string | null;
  rawText: string | null;
  isInert: boolean;
  effects: EffectTag[];
}

// ─── Issue Types (explainability) ───────────────────────────

/** Severity levels for evaluation issues. */
export type IssueSeverity = "blocker" | "conditional" | "info";

/** A typed issue raised by the evaluator. */
export interface EvaluationIssue {
  /** Issue type slug from taxonomy_issue_type. */
  type: string;
  severity: IssueSeverity;
  /** Human-readable explanation. */
  message: string;
  /** Optional context (e.g., which tag was missing). */
  detail?: string;
}

// ─── Evaluation Result ──────────────────────────────────────

/**
 * Evaluation status for a single effect against a target context.
 *
 * - `works`: Effect fully applies.
 * - `conditional`: Effect may apply depending on runtime game state
 *   (e.g., "when target is burning" — we can't know this at crew-build time).
 * - `blocked`: Effect definitely doesn't apply (e.g., wrong target kind).
 */
export type EvaluationStatus = "works" | "conditional" | "blocked";

/** Result of evaluating a single EffectTag against a TargetContext. */
export interface EffectEvaluation {
  effectId: string;
  effectKey: string;
  status: EvaluationStatus;
  issues: EvaluationIssue[];
  /** Weight multiplier: works=1.0, conditional=0.5, blocked=0.0 */
  applicabilityMultiplier: number;
}

/** Full evaluation of one officer's abilities against a TargetContext. */
export interface OfficerEvaluation {
  officerId: string;
  slot: SlotContext;
  abilities: AbilityEvaluation[];
  /** Aggregated score before intent weighting. */
  totalScore: number;
  /** All issues across all abilities. */
  issues: EvaluationIssue[];
}

/** Evaluation of a single ability (one slot) against a TargetContext. */
export interface AbilityEvaluation {
  abilityId: string;
  slot: "cm" | "oa" | "bda";
  effects: EffectEvaluation[];
  isInert: boolean;
}

// ─── Intent Definitions (data-driven) ───────────────────────

/**
 * An intent definition from the DB. Replaces static INTENT_CATALOG entries
 * with weighted feature vectors for scoring.
 */
export interface IntentDefinition {
  id: string;
  name: string;
  description: string;
  /** Default TargetContext for this intent. */
  defaultContext: TargetContext;
  /** Weighted effect vector: effectKey → weight (positive = desired, negative = undesired). */
  effectWeights: Record<string, number>;
}

// ─── Scoring ────────────────────────────────────────────────

/** Scored officer for recommendation ranking. */
export interface ScoredOfficer {
  officerId: string;
  /** Base score from effect weights × evaluation. */
  baseScore: number;
  /** Per-effect breakdown for "why" explanations. */
  effectBreakdown: EffectScoreEntry[];
  /** Evaluation results for explainability. */
  evaluation: OfficerEvaluation;
}

/** One entry in the effect-score breakdown. */
export interface EffectScoreEntry {
  effectKey: string;
  intentWeight: number;
  magnitude: number | null;
  applicabilityMultiplier: number;
  contribution: number;
}

// ─── Issue Type Catalog (for seed data typing) ──────────────

/** Issue type definition from taxonomy_issue_type. */
export interface IssueTypeDef {
  id: string;
  severity: IssueSeverity;
  defaultMessage: string;
}

/** Default issue type definitions. */
export const ISSUE_TYPES: Record<string, IssueTypeDef> = {
  not_applicable_to_target_kind: {
    id: "not_applicable_to_target_kind",
    severity: "blocker",
    defaultMessage: "Effect targets a different target kind",
  },
  missing_required_target_tag: {
    id: "missing_required_target_tag",
    severity: "blocker",
    defaultMessage: "Target doesn't have the required tag",
  },
  missing_required_target_ship_class: {
    id: "missing_required_target_ship_class",
    severity: "blocker",
    defaultMessage: "Target isn't the required ship class",
  },
  missing_required_ship_class: {
    id: "missing_required_ship_class",
    severity: "blocker",
    defaultMessage: "Your ship isn't the required class",
  },
  requires_attacking: {
    id: "requires_attacking",
    severity: "conditional",
    defaultMessage: "Only works when attacking",
  },
  requires_defending: {
    id: "requires_defending",
    severity: "conditional",
    defaultMessage: "Only works when defending",
  },
  requires_pvp: {
    id: "requires_pvp",
    severity: "conditional",
    defaultMessage: "PvP only",
  },
  requires_pve: {
    id: "requires_pve",
    severity: "conditional",
    defaultMessage: "PvE only",
  },
  requires_station_target: {
    id: "requires_station_target",
    severity: "conditional",
    defaultMessage: "Station combat only",
  },
  requires_armada_target: {
    id: "requires_armada_target",
    severity: "conditional",
    defaultMessage: "Armada only",
  },
  missing_required_status: {
    id: "missing_required_status",
    severity: "conditional",
    defaultMessage: "Requires specific combat state",
  },
  slot_mismatch: {
    id: "slot_mismatch",
    severity: "blocker",
    defaultMessage: "Effect is for a different slot",
  },
  unknown_condition: {
    id: "unknown_condition",
    severity: "conditional",
    defaultMessage: "Parser couldn't classify condition",
  },
  reserved_officer: {
    id: "reserved_officer",
    severity: "info",
    defaultMessage: "Officer is reserved on another loadout",
  },
  captain_maneuver_missing_or_inert: {
    id: "captain_maneuver_missing_or_inert",
    severity: "blocker",
    defaultMessage: "No usable captain maneuver for this objective",
  },
};
