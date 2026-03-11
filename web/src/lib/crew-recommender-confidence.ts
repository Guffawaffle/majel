/**
 * crew-recommender-confidence.ts — Confidence buckets + synergy (#192)
 */

import type { CatalogOfficer } from "./types.js";
import type { EffectScoreEntry } from "./types/effect-types.js";
import { summarizeUncertainty } from "./crew-recommender-scoring.js";
import scoringContractV0 from "./data/scoring-contract.v0.json";

export const SYNERGY_PAIR_BONUS = scoringContractV0.synergyPairBonus;

// ─── Confidence ─────────────────────────────────────────────

export function effectConfidenceFromBreakdowns(entries: EffectScoreEntry[]): "high" | "medium" | "low" {
  const uncertainty = summarizeUncertainty(entries);
  const confidenceValue =
    scoringContractV0.confidence.base
    - uncertainty.unknownEffectCount * scoringContractV0.confidence.unknownEffectPenalty
    - uncertainty.unknownMagnitudeCount * scoringContractV0.confidence.unknownMagnitudePenalty
    - uncertainty.conditionalTopCount * scoringContractV0.confidence.conditionalTopPenalty;

  if (confidenceValue >= scoringContractV0.confidence.highMin) return "high";
  if (confidenceValue >= scoringContractV0.confidence.mediumMin) return "medium";
  return "low";
}

// ─── Synergy ────────────────────────────────────────────────

export function countSynergyPairs(
  captain: CatalogOfficer,
  bridge1: CatalogOfficer,
  bridge2: CatalogOfficer,
): number {
  let pairs = 0;
  if (captain.synergyId && bridge1.synergyId && captain.synergyId === bridge1.synergyId) pairs++;
  if (captain.synergyId && bridge2.synergyId && captain.synergyId === bridge2.synergyId) pairs++;
  if (bridge1.synergyId && bridge2.synergyId && bridge1.synergyId === bridge2.synergyId) pairs++;
  return pairs;
}
