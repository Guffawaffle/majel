import type { BridgeSlot, CatalogOfficer, OfficerReservation } from "./types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import type {
  OfficerAbility,
  OfficerEvaluation,
  TargetContext,
  EffectScoreEntry,
} from "./types/effect-types.js";
import { evaluateEffect, evaluateOfficer } from "./effect-evaluator.js";
import {
  buildTargetContext,
  bridgeSlotToSlotContext,
  type TargetContextOverrides,
} from "./effect-context.js";
import captainViabilityKeysV0 from "./data/captain-viability-keys.v0.json";
import scoringContractV0 from "./data/scoring-contract.v0.json";

export interface CrewRecommendInput {
  officers: CatalogOfficer[];
  reservations: OfficerReservation[];
  intentKey: string;
  shipClass?: string | null;
  targetClass?: "explorer" | "interceptor" | "battleship" | "any";
  contextOverrides?: Omit<TargetContextOverrides, "shipClass" | "targetClass">;
  captainId?: string;
  minConfidence?: "low" | "medium" | "high";
  limit?: number;
  /** Required: effect-based scoring bundle (ADR-034). */
  effectBundle: EffectBundleData;
}

export interface CrewRecommendationFactor {
  key: string;
  label: string;
  score: number;
}

export interface CrewRecommendation {
  captainId: string;
  bridge1Id: string;
  bridge2Id: string;
  totalScore: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  factors: CrewRecommendationFactor[];
}

interface OfficerScoreBreakdown {
  goalFit: number;
  shipFit: number;
  counterFit: number;
  effectScore: number;
  readiness: number;
  reservation: number;
  captainBonus: number;
}

type IntentGroup = "combat" | "economy";

interface CaptainViabilityKeyConfig {
  version: string;
  combatRelevantKeys: string[];
  economyRelevantKeys: string[];
  metaAmplifierKeys: string[];
}

const captainViabilityConfig = captainViabilityKeysV0 as CaptainViabilityKeyConfig;
const CAPTAIN_COMBAT_RELEVANT_KEYS = new Set<string>(captainViabilityConfig.combatRelevantKeys);
const CAPTAIN_ECONOMY_RELEVANT_KEYS = new Set<string>(captainViabilityConfig.economyRelevantKeys);
const CAPTAIN_META_AMPLIFIER_KEYS = new Set<string>(captainViabilityConfig.metaAmplifierKeys);

function deriveIntentGroup(intentKey: string, ctx: TargetContext): IntentGroup {
  const lowerKey = intentKey.toLowerCase();
  if (/mining|cargo|survey|warp|loot|economy/.test(lowerKey)) {
    return "economy";
  }

  if (
    ctx.targetKind === "hostile"
    || ctx.targetKind === "player_ship"
    || ctx.targetKind === "station"
    || ctx.targetKind === "armada_target"
    || ctx.targetKind === "mission_npc"
  ) {
    return "combat";
  }

  return "combat";
}

function getReservationPenalty(officerId: string, reservations: OfficerReservation[]): number {
  const reservation = reservations.find((r) => r.officerId === officerId);
  if (!reservation) return 0;
  return reservation.locked ? -6 : -3;
}

function normalizeLevel(value: number | null): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, value / 60);
}

function normalizePower(value: number | null, maxPower: number): number {
  if (!value || value <= 0 || maxPower <= 0) return 0;
  return Math.min(1, value / maxPower);
}

// ═══════════════════════════════════════════════════════════════
// Effect-Based Scoring (ADR-034)
// ═══════════════════════════════════════════════════════════════

/** Effect evaluator scores are small decimals (0–2). Scale to match keyword score range. */
const EFFECT_SCALE = scoringContractV0.effectScale;
const UNKNOWN_EFFECT_PENALTY = scoringContractV0.uncertainty.unknownEffectPenalty;
const UNKNOWN_MAGNITUDE_PENALTY = scoringContractV0.uncertainty.unknownMagnitudePenalty;
const UNKNOWN_MAGNITUDE_CONTRIBUTION_FACTOR = scoringContractV0.uncertainty.unknownMagnitudeContributionFactor;
const CONFIDENCE_TOP_EFFECTS_WINDOW = scoringContractV0.confidence.topEffectsWindow;
const SYNERGY_PAIR_BONUS = scoringContractV0.synergyPairBonus;
const READINESS_LEVEL_WEIGHT = scoringContractV0.readiness.levelWeight;
const READINESS_POWER_WEIGHT = scoringContractV0.readiness.powerWeight;

function resolveIntentOrThrow(
  effectBundle: EffectBundleData,
  intentKey: string,
) {
  const intent = effectBundle.intents.get(intentKey);
  const weights = effectBundle.intentWeights.get(intentKey);
  if (!intent || !weights) {
    throw new Error(`Unknown intent key: ${intentKey}`);
  }
  return { intent, weights };
}

/**
 * Check whether an officer has a useful Captain Maneuver for the given context.
 * Returns true if at least one CM effect has a positive intent weight and isn't blocked.
 */
function isCaptainViable(
  abilities: OfficerAbility[],
  ctx: TargetContext,
  intentWeights: Record<string, number>,
  intentGroup: IntentGroup,
): boolean {
  const cmAbilities = abilities.filter((a) => a.slot === "cm" && !a.isInert);
  if (cmAbilities.length === 0) return false;

  const allowlist = intentGroup === "combat"
    ? CAPTAIN_COMBAT_RELEVANT_KEYS
    : CAPTAIN_ECONOMY_RELEVANT_KEYS;

  for (const ability of cmAbilities) {
    for (const effect of ability.effects) {
      const evalResult = evaluateEffect(effect, { ...ctx, slotContext: "captain" });
      if (evalResult.status === "blocked") continue;

      const weight = intentWeights[effect.effectKey] ?? 0;
      const hasNonZeroWeight = Math.abs(weight) > 0;
      const isAllowlisted = allowlist.has(effect.effectKey);
      const isMetaAmplifier = CAPTAIN_META_AMPLIFIER_KEYS.has(effect.effectKey);

      if (isAllowlisted || hasNonZeroWeight || isMetaAmplifier) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build a per-effect score breakdown from evaluation results.
 */
function buildEffectBreakdown(
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

function summarizeUncertainty(entries: EffectScoreEntry[]): {
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

function scoreFromBreakdown(entries: EffectScoreEntry[]): number {
  const rawScore = entries.reduce((sum, entry) => sum + entry.contribution, 0);
  const uncertainty = summarizeUncertainty(entries);
  const penalty =
    uncertainty.unknownEffectCount * UNKNOWN_EFFECT_PENALTY
    + uncertainty.unknownMagnitudeCount * UNKNOWN_MAGNITUDE_PENALTY;
  return Math.round((rawScore - penalty) * EFFECT_SCALE * 10) / 10;
}

function humanizeEffectKey(effectKey: string): string {
  return effectKey.replace(/_/g, " ");
}

function summarizeStatusEvidence(entries: EffectScoreEntry[], status: "works" | "conditional" | "blocked"): string | null {
  const match = entries
    .filter((entry) => entry.status === status)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, status === "works" ? 2 : 1);

  if (match.length === 0) return null;

  const summary = match
    .map((entry) => `${humanizeEffectKey(entry.effectKey)} (${entry.status})`)
    .join(", ");

  return summary;
}

function scoreOfficerForSlotEffect(
  officer: CatalogOfficer,
  opts: {
    intentKey: string;
    shipClass?: string | null;
    targetClass?: string | null;
    reservations: OfficerReservation[];
    maxPower: number;
    slot: BridgeSlot;
    contextOverrides?: Omit<TargetContextOverrides, "shipClass" | "targetClass">;
    effectBundle: EffectBundleData;
  },
): OfficerScoreBreakdown {
  const resolved = resolveIntentOrThrow(opts.effectBundle, opts.intentKey);
  const ctx = buildTargetContext(resolved.intent, {
    shipClass: opts.shipClass,
    targetClass: opts.targetClass,
    ...opts.contextOverrides,
  });
  const intentGroup = deriveIntentGroup(opts.intentKey, ctx);
  const weights = resolved.weights;
  const abilities = opts.effectBundle.officerAbilities.get(officer.id) ?? [];
  const slotCtx = bridgeSlotToSlotContext(opts.slot);

  const evaluation = evaluateOfficer(officer.id, abilities, ctx, weights, slotCtx);
  const breakdown = buildEffectBreakdown(abilities, evaluation, weights);
  const effectScore = scoreFromBreakdown(breakdown);

  const readiness = Math.round(
    (
      normalizeLevel(officer.userLevel) * READINESS_LEVEL_WEIGHT
      + normalizePower(officer.userPower, opts.maxPower) * READINESS_POWER_WEIGHT
    ) * 10,
  ) / 10;
  const reservation = getReservationPenalty(officer.id, opts.reservations);

  let captainBonus = 0;
  if (opts.slot === "captain") {
    captainBonus = isCaptainViable(abilities, ctx, weights, intentGroup) ? 2 : -3;
  }

  return {
    goalFit: 0,
    shipFit: 0,
    counterFit: 0,
    effectScore,
    readiness,
    reservation,
    captainBonus,
  };
}

// ─── Effect-Based Recommender ───────────────────────────────

/**
 * Confidence buckets penalize uncertainty and conditional concentration.
 */
function effectConfidenceFromBreakdowns(entries: EffectScoreEntry[]): "high" | "medium" | "low" {
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

function buildEffectReasons(
  captainName: string,
  captainBreakdown: EffectScoreEntry[],
  bridge1Name: string,
  bridge1Breakdown: EffectScoreEntry[],
  bridge2Name: string,
  bridge2Breakdown: EffectScoreEntry[],
  captainViable: boolean,
  captainFallbackInRun: boolean,
  includeFallbackWarning: boolean,
  synergyPairs: number,
  reservationTotal: number,
): string[] {
  const reasons: string[] = [];

  const worksEvidence = summarizeStatusEvidence(captainBreakdown, "works");
  if (worksEvidence) {
    reasons.push(`${captainName} (Captain): ${worksEvidence}.`);
  }

  const conditionalEvidence = summarizeStatusEvidence(captainBreakdown, "conditional");
  if (conditionalEvidence) {
    reasons.push(`${captainName} situational effects: ${conditionalEvidence}.`);
  }

  const blockedEvidence = summarizeStatusEvidence(captainBreakdown, "blocked");
  if (blockedEvidence) {
    reasons.push(`${captainName} blocked for current target: ${blockedEvidence}.`);
  }

  const bridge1Works = summarizeStatusEvidence(bridge1Breakdown, "works");
  if (bridge1Works) {
    reasons.push(`${bridge1Name} (Bridge): ${bridge1Works}.`);
  }

  const bridge2Works = summarizeStatusEvidence(bridge2Breakdown, "works");
  if (bridge2Works) {
    reasons.push(`${bridge2Name} (Bridge): ${bridge2Works}.`);
  }

  if (!captainViable && !captainFallbackInRun) {
    reasons.push(`⚠ ${captainName} has no useful Captain Maneuver for this objective.`);
  }
  if (includeFallbackWarning) {
    reasons.push("No viable captains found; using best available fallback.");
  }

  if (synergyPairs > 0) {
    reasons.push(
      `Synergy group overlap (${synergyPairs} pair${synergyPairs > 1 ? "s" : ""}, +${Math.round(synergyPairs * SYNERGY_PAIR_BONUS * 100)}% bonus).`,
    );
  }

  if (reservationTotal < 0) {
    reasons.push("Includes reserved officer(s); review before saving.");
  }

  return reasons;
}

function countSynergyPairs(
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

function recommendBridgeTriosEffect(input: CrewRecommendInput): CrewRecommendation[] {
  const bundle = input.effectBundle;
  const pool = input.officers.filter((o) => o.ownershipState !== "unowned");
  if (pool.length < 3) return [];

  const maxPower = Math.max(...pool.map((o) => o.userPower ?? 0), 1);
  const byId = new Map(pool.map((o) => [o.id, o]));

  const resolved = resolveIntentOrThrow(bundle, input.intentKey);
  const ctx = buildTargetContext(resolved.intent, {
    shipClass: input.shipClass,
    targetClass: input.targetClass,
    ...input.contextOverrides,
  });
  const intentGroup = deriveIntentGroup(input.intentKey, ctx);
  const weights = resolved.weights;

  // Score all officers for captain slot with gating
  const captainScored = pool.map((o) => {
    const abilities = bundle.officerAbilities.get(o.id) ?? [];
    const evaluation = evaluateOfficer(o.id, abilities, ctx, weights, "captain");
    const breakdown = buildEffectBreakdown(abilities, evaluation, weights);
    const effectScore = scoreFromBreakdown(breakdown);
    const readiness = Math.round(
      (
        normalizeLevel(o.userLevel) * READINESS_LEVEL_WEIGHT
        + normalizePower(o.userPower, maxPower) * READINESS_POWER_WEIGHT
      ) * 10,
    ) / 10;
    const reservation = getReservationPenalty(o.id, input.reservations);
    const viable = isCaptainViable(abilities, ctx, weights, intentGroup);
    const captainBonus = viable ? 2 : -3;
    const total = effectScore + readiness + reservation + captainBonus;
    return { officer: o, effectScore, readiness, reservation, captainBonus, total, viable, breakdown };
  });

  // Sort: viable captains first, then by total score
  captainScored.sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1;
    return b.total - a.total;
  });

  const preferredCaptain = input.captainId ? byId.get(input.captainId) : null;
  const viableCaptains = captainScored.filter((entry) => entry.viable);
  const captainFallbackUsed = !preferredCaptain && viableCaptains.length === 0;
  const captainCandidates = preferredCaptain
    ? captainScored.filter((s) => s.officer.id === preferredCaptain.id)
    : (viableCaptains.length > 0 ? viableCaptains.slice(0, 6) : captainScored.slice(0, 2));

  const recs: CrewRecommendation[] = [];
  let fallbackWarningEmitted = false;
  for (const captainInfo of captainCandidates) {
    const captain = captainInfo.officer;

    // Score bridge candidates
    const bridgeScored = pool
      .filter((o) => o.id !== captain.id)
      .map((o) => {
        const abilities = bundle.officerAbilities.get(o.id) ?? [];
        const evaluation = evaluateOfficer(o.id, abilities, ctx, weights, "bridge");
        const breakdown = buildEffectBreakdown(abilities, evaluation, weights);
        const effectScore = scoreFromBreakdown(breakdown);
        const readiness = Math.round(
          (
            normalizeLevel(o.userLevel) * READINESS_LEVEL_WEIGHT
            + normalizePower(o.userPower, maxPower) * READINESS_POWER_WEIGHT
          ) * 10,
        ) / 10;
        const reservation = getReservationPenalty(o.id, input.reservations);
        const total = effectScore + readiness + reservation;
        return { officer: o, effectScore, readiness, reservation, total, breakdown };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 14);

    for (let i = 0; i < bridgeScored.length; i += 1) {
      for (let j = i + 1; j < bridgeScored.length; j += 1) {
        const b1 = bridgeScored[i];
        const b2 = bridgeScored[j];

        const synergyPairs = countSynergyPairs(captain, b1.officer, b2.officer);
        const synergyMultiplier = 1 + synergyPairs * SYNERGY_PAIR_BONUS;

        const baseScore = captainInfo.total + b1.total + b2.total;
        const totalScore = Math.round(baseScore * synergyMultiplier * 10) / 10;
        const confidence = effectConfidenceFromBreakdowns([
          ...captainInfo.breakdown,
          ...b1.breakdown,
          ...b2.breakdown,
        ]);

        const factors: CrewRecommendationFactor[] = [
          { key: "effectScore", label: "Effect Score", score: Math.round((captainInfo.effectScore + b1.effectScore + b2.effectScore) * 10) / 10 },
          { key: "captainGating", label: "Captain Bonus", score: captainInfo.captainBonus },
          { key: "synergy", label: "Synergy", score: Math.round(baseScore * (synergyMultiplier - 1) * 10) / 10 },
          { key: "readiness", label: "Readiness", score: Math.round((captainInfo.readiness + b1.readiness + b2.readiness) * 10) / 10 },
          { key: "reservation", label: "Reservation Penalty", score: captainInfo.reservation + b1.reservation + b2.reservation },
        ];

        const reasons = buildEffectReasons(
          captain.name,
          captainInfo.breakdown,
          b1.officer.name,
          b1.breakdown,
          b2.officer.name,
          b2.breakdown,
          captainInfo.viable,
          captainFallbackUsed,
          captainFallbackUsed && !fallbackWarningEmitted,
          synergyPairs,
          captainInfo.reservation + b1.reservation + b2.reservation,
        );

        if (captainFallbackUsed && !fallbackWarningEmitted) {
          fallbackWarningEmitted = true;
        }

        recs.push({
          captainId: captain.id,
          bridge1Id: b1.officer.id,
          bridge2Id: b2.officer.id,
          totalScore,
          confidence,
          reasons,
          factors,
        });
      }
    }
  }

  const deduped = new Map<string, CrewRecommendation>();
  for (const rec of recs.sort((a, b) => b.totalScore - a.totalScore)) {
    const key = `${rec.captainId}|${[rec.bridge1Id, rec.bridge2Id].sort().join("|")}`;
    if (!deduped.has(key)) deduped.set(key, rec);
  }

  const minimumConfidence = input.minConfidence ?? "low";
  const threshold = minimumConfidence === "high" ? 3 : minimumConfidence === "medium" ? 2 : 1;
  const confidenceRank = (value: CrewRecommendation["confidence"]): number => {
    if (value === "high") return 3;
    if (value === "medium") return 2;
    return 1;
  };

  return Array.from(deduped.values())
    .filter((rec) => confidenceRank(rec.confidence) >= threshold)
    .slice(0, input.limit ?? 5);
}

// ═══════════════════════════════════════════════════════════════
// Public API (effect-based only)
// ═══════════════════════════════════════════════════════════════

export function scoreOfficerForSlot(
  officer: CatalogOfficer,
  opts: {
    intentKey: string;
    shipClass?: string | null;
    targetClass?: "explorer" | "interceptor" | "battleship" | "any";
    contextOverrides?: Omit<TargetContextOverrides, "shipClass" | "targetClass">;
    reservations: OfficerReservation[];
    maxPower: number;
    slot: BridgeSlot;
    effectBundle: EffectBundleData;
  },
): OfficerScoreBreakdown {
  if (!opts.effectBundle) {
    throw new Error("Effect bundle is required for scoreOfficerForSlot.");
  }
  return scoreOfficerForSlotEffect(officer, { ...opts, effectBundle: opts.effectBundle });
}

export function recommendBridgeTrios(input: CrewRecommendInput): CrewRecommendation[] {
  if (!input.effectBundle) {
    throw new Error("Effect bundle is required for recommendBridgeTrios.");
  }
  return recommendBridgeTriosEffect(input);
}

// ═══════════════════════════════════════════════════════════════
// Utility Exports (unchanged)
// ═══════════════════════════════════════════════════════════════

export function recommendationSlots(rec: CrewRecommendation): Record<BridgeSlot, string> {
  return {
    captain: rec.captainId,
    bridge_1: rec.bridge1Id,
    bridge_2: rec.bridge2Id,
  };
}

export function confidenceLabel(confidence: CrewRecommendation["confidence"]): string {
  if (confidence === "high") return "High";
  if (confidence === "medium") return "Medium";
  return "Low";
}

export function findOfficerName(officers: CatalogOfficer[], id: string): string {
  return officers.find((officer) => officer.id === id)?.name ?? id;
}