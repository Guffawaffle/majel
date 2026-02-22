/**
 * effect-evaluator.ts — Pure evaluator for ADR-034 Effect Taxonomy (#132)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * evaluateEffect() is a pure function: given a normalized EffectTag and a
 * TargetContext, it returns { status, issues[], applicabilityMultiplier }.
 *
 * No DB access, no side effects. Usable client-side and in tests.
 */

import type {
  EffectTag,
  EffectCondition,
  EffectEvaluation,
  EvaluationIssue,
  EvaluationStatus,
  TargetContext,
  IssueSeverity,
  OfficerAbility,
  AbilityEvaluation,
  OfficerEvaluation,
  SlotContext,
} from "./types/effect-types.js";

// ─── Core Evaluator ─────────────────────────────────────────

/**
 * Evaluate a single EffectTag against a TargetContext.
 *
 * Returns:
 *   - `works` (1.0) if the effect fully applies.
 *   - `conditional` (0.5) if it may apply at runtime (e.g., "when burning").
 *   - `blocked` (0.0) if it definitely doesn't apply.
 */
export function evaluateEffect(
  effect: EffectTag,
  ctx: TargetContext,
): EffectEvaluation {
  const issues: EvaluationIssue[] = [];

  // 1. Check target kind restrictions
  if (effect.applicableTargetKinds.length > 0) {
    if (!effect.applicableTargetKinds.includes(ctx.targetKind)) {
      issues.push(makeIssue(
        "not_applicable_to_target_kind",
        "blocker",
        `Effect applies to ${effect.applicableTargetKinds.join(", ")} but target is ${ctx.targetKind}`,
      ));
    }
  }

  // 2. Check target tag restrictions
  if (effect.applicableTargetTags.length > 0) {
    const missingTags = effect.applicableTargetTags.filter(
      (tag) => !ctx.targetTags.includes(tag),
    );
    if (missingTags.length > 0) {
      issues.push(makeIssue(
        "missing_required_target_tag",
        "blocker",
        `Target missing required tag(s): ${missingTags.join(", ")}`,
      ));
    }
  }

  // 3. Check each condition
  for (const cond of effect.conditions) {
    const condIssue = evaluateCondition(cond, ctx);
    if (condIssue) {
      issues.push(condIssue);
    }
  }

  // Determine status from issues
  const status = deriveStatus(issues);
  const applicabilityMultiplier =
    status === "works" ? 1.0 : status === "conditional" ? 0.5 : 0.0;

  return {
    effectId: effect.id,
    effectKey: effect.effectKey,
    status,
    issues,
    applicabilityMultiplier,
  };
}

// ─── Condition Evaluator ────────────────────────────────────

function evaluateCondition(
  cond: EffectCondition,
  ctx: TargetContext,
): EvaluationIssue | null {
  switch (cond.conditionKey) {
    // ── Engagement conditions ──
    case "requires_attacking":
      if (ctx.engagement !== "attacking" && ctx.engagement !== "any") {
        return makeIssue("requires_attacking", "blocker", "Only works when attacking");
      }
      return null;

    case "requires_defending":
      if (ctx.engagement !== "defending" && ctx.engagement !== "any") {
        return makeIssue("requires_defending", "blocker", "Only works when defending");
      }
      return null;

    // ── Mode conditions ──
    case "requires_pvp":
      if (!ctx.targetTags.includes("pvp")) {
        return makeIssue("requires_pvp", "blocker", "PvP only");
      }
      return null;

    case "requires_pve":
      if (!ctx.targetTags.includes("pve")) {
        return makeIssue("requires_pve", "blocker", "PvE only");
      }
      return null;

    case "requires_station_target":
      if (ctx.targetKind !== "station") {
        return makeIssue("requires_station_target", "blocker", "Station combat only");
      }
      return null;

    case "requires_armada_target":
      if (ctx.targetKind !== "armada_target") {
        return makeIssue("requires_armada_target", "blocker", "Armada only");
      }
      return null;

    // ── Ship class conditions ──
    case "requires_ship_class": {
      const requiredClass = cond.params?.class;
      if (requiredClass && ctx.shipContext?.shipClass !== requiredClass) {
        return makeIssue(
          "missing_required_ship_class",
          "blocker",
          `Requires ${requiredClass} ship, but yours is ${ctx.shipContext?.shipClass ?? "unknown"}`,
        );
      }
      return null;
    }

    case "requires_target_ship_class": {
      const targetClass = cond.params?.class;
      if (targetClass && !ctx.targetTags.includes(`target_${targetClass}`)) {
        return makeIssue(
          "missing_required_target_ship_class",
          "blocker",
          `Requires target to be ${targetClass}`,
        );
      }
      return null;
    }

    // ── Tag conditions ──
    case "requires_target_tag": {
      const tag = cond.params?.tag;
      if (tag && !ctx.targetTags.includes(tag)) {
        return makeIssue(
          "missing_required_target_tag",
          "blocker",
          `Target missing required tag: ${tag}`,
        );
      }
      return null;
    }

    case "requires_ship_tag": {
      const shipTag = cond.params?.tag;
      if (shipTag && !ctx.shipContext?.shipTags?.includes(shipTag)) {
        return makeIssue(
          "missing_required_ship_class",
          "blocker",
          `Ship missing required tag: ${shipTag}`,
        );
      }
      return null;
    }

    // ── Runtime/timing conditions (always conditional — can't know at crew-build time) ──
    case "at_combat_start":
    case "at_round_start":
    case "when_weapons_fire":
    case "per_round_stacking":
      // These always trigger during combat — they're "works" (not conditional).
      return null;

    case "when_shields_depleted":
      return makeIssue(
        "missing_required_status",
        "conditional",
        "Only activates when shields are depleted",
      );

    case "when_hull_breached":
      return makeIssue(
        "missing_required_status",
        "conditional",
        "Only activates when hull is breached",
      );

    case "when_burning":
      return makeIssue(
        "missing_required_status",
        "conditional",
        "Only activates when your ship is burning",
      );

    case "when_target_is_burning":
      if (ctx.targetTags.includes("target_burning")) return null;
      return makeIssue(
        "missing_required_status",
        "conditional",
        "Only activates when target is burning",
      );

    case "when_target_has_hull_breach":
      if (ctx.targetTags.includes("target_hull_breached")) return null;
      return makeIssue(
        "missing_required_status",
        "conditional",
        "Only activates when target hull is breached",
      );

    case "below_health_threshold":
      return makeIssue(
        "missing_required_status",
        "conditional",
        `Only activates below ${(Number(cond.params?.threshold ?? 50))}% health`,
      );

    default:
      return makeIssue(
        "unknown_condition",
        "conditional",
        `Unrecognized condition: ${cond.conditionKey}`,
      );
  }
}

// ─── Ability Evaluator ──────────────────────────────────────

/**
 * Evaluate all effects of a single officer ability against a TargetContext.
 */
export function evaluateAbility(
  ability: OfficerAbility,
  ctx: TargetContext,
): AbilityEvaluation {
  if (ability.isInert) {
    return {
      abilityId: ability.id,
      slot: ability.slot,
      effects: [],
      isInert: true,
    };
  }

  const effects = ability.effects.map((effect) => evaluateEffect(effect, ctx));

  return {
    abilityId: ability.id,
    slot: ability.slot,
    effects,
    isInert: false,
  };
}

// ─── Officer Evaluator ──────────────────────────────────────

/**
 * Evaluate all of an officer's abilities against a TargetContext.
 * Returns aggregated score and issues.
 *
 * @param abilities - All abilities for this officer (cm, oa, bda).
 * @param ctx - Target context to evaluate against.
 * @param intentWeights - Effect weight vector for the intent (effectKey → weight).
 * @param slotContext - What slot this officer is being considered for.
 */
export function evaluateOfficer(
  officerId: string,
  abilities: OfficerAbility[],
  ctx: TargetContext,
  intentWeights: Record<string, number>,
  slotContext: SlotContext,
): OfficerEvaluation {
  const slotCtx: TargetContext = { ...ctx, slotContext };
  const abilityEvals: AbilityEvaluation[] = [];
  const allIssues: EvaluationIssue[] = [];
  let totalScore = 0;

  // Filter abilities by slot activation rules:
  //   captain slot: CM + OA active
  //   bridge slot:  OA only
  //   below_deck:   BDA only
  const activeSlots = getActiveSlots(slotContext);

  for (const ability of abilities) {
    if (!activeSlots.includes(ability.slot)) continue;

    const abilityEval = evaluateAbility(ability, slotCtx);
    abilityEvals.push(abilityEval);

    for (const effectEval of abilityEval.effects) {
      const weight = intentWeights[effectEval.effectKey] ?? 0;
      const effect = ability.effects.find((entry) => entry.id === effectEval.effectId);
      const magnitude = effect?.magnitude ?? 1;
      const contribution = magnitude * weight * effectEval.applicabilityMultiplier;
      totalScore += contribution;
      allIssues.push(...effectEval.issues);
    }
  }

  return {
    officerId,
    slot: slotContext,
    abilities: abilityEvals,
    totalScore,
    issues: allIssues,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function getActiveSlots(slotContext: SlotContext): string[] {
  switch (slotContext) {
    case "captain":
      return ["cm", "oa"];
    case "bridge":
      return ["oa"];
    case "below_deck":
      return ["bda"];
  }
}

function deriveStatus(issues: EvaluationIssue[]): EvaluationStatus {
  if (issues.some((i) => i.severity === "blocker")) return "blocked";
  if (issues.some((i) => i.severity === "conditional")) return "conditional";
  return "works";
}

function makeIssue(
  type: string,
  severity: IssueSeverity,
  message: string,
  detail?: string,
): EvaluationIssue {
  return { type, severity, message, ...(detail ? { detail } : {}) };
}
