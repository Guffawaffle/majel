/**
 * crew-recommender-scoring.ts — Scoring math + effect breakdown (#192)
 */

import type {
  OfficerAbility,
  OfficerEvaluation,
  EffectScoreEntry,
} from "./types/effect-types.js";
import scoringContractV0 from "./data/scoring-contract.v0.json";

// ─── Scoring Constants ──────────────────────────────────────

/** Effect evaluator scores are small decimals (0–2). Scale to match keyword score range. */
export const EFFECT_SCALE = scoringContractV0.effectScale;
export const UNKNOWN_EFFECT_PENALTY = scoringContractV0.uncertainty.unknownEffectPenalty;
export const UNKNOWN_MAGNITUDE_PENALTY = scoringContractV0.uncertainty.unknownMagnitudePenalty;
export const UNKNOWN_MAGNITUDE_CONTRIBUTION_FACTOR = scoringContractV0.uncertainty.unknownMagnitudeContributionFactor;
export const READINESS_LEVEL_WEIGHT = scoringContractV0.readiness.levelWeight;
export const READINESS_POWER_WEIGHT = scoringContractV0.readiness.powerWeight;

// ─── Helpers ────────────────────────────────────────────────

export function normalizeLevel(value: number | null): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, value / 60);
}

export function normalizePower(value: number | null, maxPower: number): number {
  if (!value || value <= 0 || maxPower <= 0) return 0;
  return Math.min(1, value / maxPower);
}

// ─── Effect Breakdown ───────────────────────────────────────

export function buildEffectBreakdown(
  abilities: OfficerAbility[],
  evaluation: OfficerEvaluation,
  intentWeights: Record<string, number>,
): EffectScoreEntry[] {
  const entries: EffectScoreEntry[] = [];
  for (const abilEval of evaluation.abilities) {
    const ability = abilities.find((a) => a.id === abilEval.abilityId);
    for (const effectEval of abilEval.effects) {
      const hasKnownWeight = Object.hasOwn(intentWeights, effectEval.effectKey);
      const weight = hasKnownWeight ? intentWeights[effectEval.effectKey] ?? 0 : 0;
      const effect = ability?.effects.find((entry) => entry.id === effectEval.effectId);
      const hasUnknownMagnitude = effect?.magnitude == null;
      const magnitude = effect?.magnitude ?? 1;
      const baseContribution = magnitude * weight * effectEval.applicabilityMultiplier;
      const contribution = hasUnknownMagnitude
        ? baseContribution * UNKNOWN_MAGNITUDE_CONTRIBUTION_FACTOR
        : baseContribution;
      entries.push({
        effectKey: effectEval.effectKey,
        status: effectEval.status,
        intentWeight: weight,
        magnitude: effect?.magnitude ?? null,
        applicabilityMultiplier: effectEval.applicabilityMultiplier,
        contribution,
        isUnknownEffectKey: !hasKnownWeight,
        hasUnknownMagnitude,
      });
    }
  }
  return entries.sort((a, b) => b.contribution - a.contribution);
}

// ─── Uncertainty ────────────────────────────────────────────

const CONFIDENCE_TOP_EFFECTS_WINDOW = scoringContractV0.confidence.topEffectsWindow;

export function summarizeUncertainty(entries: EffectScoreEntry[]): {
  unknownEffectCount: number;
  unknownMagnitudeCount: number;
  conditionalTopCount: number;
} {
  const unknownEffectCount = entries.filter((entry) => entry.isUnknownEffectKey).length;
  const unknownMagnitudeCount = entries.filter((entry) => entry.hasUnknownMagnitude).length;

  const topContributing = [...entries]
    .filter((entry) => entry.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, CONFIDENCE_TOP_EFFECTS_WINDOW);

  const conditionalTopCount = topContributing
    .filter((entry) => entry.status === "conditional")
    .length;

  return { unknownEffectCount, unknownMagnitudeCount, conditionalTopCount };
}

// ─── Score Calculation ──────────────────────────────────────

export function scoreFromBreakdown(entries: EffectScoreEntry[]): number {
  const rawScore = entries.reduce((sum, entry) => sum + entry.contribution, 0);
  const uncertainty = summarizeUncertainty(entries);
  const penalty =
    uncertainty.unknownEffectCount * UNKNOWN_EFFECT_PENALTY
    + uncertainty.unknownMagnitudeCount * UNKNOWN_MAGNITUDE_PENALTY;
  return Math.round((rawScore - penalty) * EFFECT_SCALE * 10) / 10;
}
