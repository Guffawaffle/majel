import type { BridgeSlot, CatalogOfficer, OfficerReservation } from "./types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import type {
  OfficerAbility,
  OfficerEvaluation,
  TargetContext,
  EffectScoreEntry,
} from "./types/effect-types.js";
import { evaluateEffect, evaluateOfficer } from "./effect-evaluator.js";
import { buildTargetContext, bridgeSlotToSlotContext } from "./effect-context.js";

export interface CrewRecommendInput {
  officers: CatalogOfficer[];
  reservations: OfficerReservation[];
  intentKey: string;
  shipClass?: string | null;
  targetClass?: "explorer" | "interceptor" | "battleship" | "any";
  captainId?: string;
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
const EFFECT_SCALE = 10;

/**
 * Check whether an officer has a useful Captain Maneuver for the given context.
 * Returns true if at least one CM effect has a positive intent weight and isn't blocked.
 */
function isCaptainViable(
  abilities: OfficerAbility[],
  ctx: TargetContext,
  intentWeights: Record<string, number>,
): boolean {
  const cmAbilities = abilities.filter((a) => a.slot === "cm" && !a.isInert);
  if (cmAbilities.length === 0) return false;

  for (const ability of cmAbilities) {
    for (const effect of ability.effects) {
      const weight = intentWeights[effect.effectKey] ?? 0;
      if (weight <= 0) continue;
      const evalResult = evaluateEffect(effect, { ...ctx, slotContext: "captain" });
      if (evalResult.status !== "blocked") return true;
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
      const weight = intentWeights[effectEval.effectKey] ?? 0;
      const effect = ability?.effects.find((entry) => entry.id === effectEval.effectId);
      const magnitude = effect?.magnitude ?? 1;
      const contribution = magnitude * weight * effectEval.applicabilityMultiplier;
      entries.push({
        effectKey: effectEval.effectKey,
        intentWeight: weight,
        magnitude: effect?.magnitude ?? null,
        applicabilityMultiplier: effectEval.applicabilityMultiplier,
        contribution,
      });
    }
  }
  return entries.sort((a, b) => b.contribution - a.contribution);
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
    effectBundle: EffectBundleData;
  },
): OfficerScoreBreakdown {
  const intent = opts.effectBundle.intents.get(opts.intentKey);
  const ctx = buildTargetContext(intent, opts.shipClass, opts.targetClass);
  const weights = opts.effectBundle.intentWeights.get(opts.intentKey) ?? {};
  const abilities = opts.effectBundle.officerAbilities.get(officer.id) ?? [];
  const slotCtx = bridgeSlotToSlotContext(opts.slot);

  const evaluation = evaluateOfficer(officer.id, abilities, ctx, weights, slotCtx);
  const effectScore = Math.round(evaluation.totalScore * EFFECT_SCALE * 10) / 10;

  const readiness = Math.round(
    (normalizeLevel(officer.userLevel) * 4 + normalizePower(officer.userPower, opts.maxPower) * 2) * 10,
  ) / 10;
  const reservation = getReservationPenalty(officer.id, opts.reservations);

  let captainBonus = 0;
  if (opts.slot === "captain") {
    captainBonus = isCaptainViable(abilities, ctx, weights) ? 2 : -3;
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
 * Confidence thresholds calibrated for effect-based scoring.
 * Strong trio: ~40+, average trio: ~20, weak: <18.
 */
function effectConfidenceFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 30) return "high";
  if (score >= 18) return "medium";
  return "low";
}

function buildEffectReasons(
  captainName: string,
  captainBreakdown: EffectScoreEntry[],
  captainViable: boolean,
  captainFallbackUsed: boolean,
  synergyPairs: number,
  reservationTotal: number,
): string[] {
  const reasons: string[] = [];

  const topEffects = captainBreakdown
    .filter((e) => e.contribution > 0)
    .slice(0, 2);
  if (topEffects.length > 0) {
    reasons.push(
      `${captainName} contributes ${topEffects.map((e) => e.effectKey.replace(/_/g, " ")).join(", ")}.`,
    );
  }

  if (!captainViable) {
    reasons.push(`⚠ ${captainName} has no useful Captain Maneuver for this objective.`);
  }
  if (captainFallbackUsed) {
    reasons.push("No viable captains found; using best available fallback.");
  }

  if (synergyPairs > 0) {
    reasons.push(
      `Synergy group overlap (${synergyPairs} pair${synergyPairs > 1 ? "s" : ""}, +${Math.round(synergyPairs * 3)}% bonus).`,
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

  const intent = bundle.intents.get(input.intentKey);
  const ctx = buildTargetContext(intent, input.shipClass, input.targetClass);
  const weights = bundle.intentWeights.get(input.intentKey) ?? {};

  // Score all officers for captain slot with gating
  const captainScored = pool.map((o) => {
    const abilities = bundle.officerAbilities.get(o.id) ?? [];
    const evaluation = evaluateOfficer(o.id, abilities, ctx, weights, "captain");
    const effectScore = Math.round(evaluation.totalScore * EFFECT_SCALE * 10) / 10;
    const readiness = Math.round(
      (normalizeLevel(o.userLevel) * 4 + normalizePower(o.userPower, maxPower) * 2) * 10,
    ) / 10;
    const reservation = getReservationPenalty(o.id, input.reservations);
    const viable = isCaptainViable(abilities, ctx, weights);
    const captainBonus = viable ? 2 : -3;
    const total = effectScore + readiness + reservation + captainBonus;
    const breakdown = buildEffectBreakdown(abilities, evaluation, weights);
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

  for (const captainInfo of captainCandidates) {
    const captain = captainInfo.officer;

    // Score bridge candidates
    const bridgeScored = pool
      .filter((o) => o.id !== captain.id)
      .map((o) => {
        const abilities = bundle.officerAbilities.get(o.id) ?? [];
        const evaluation = evaluateOfficer(o.id, abilities, ctx, weights, "bridge");
        const effectScore = Math.round(evaluation.totalScore * EFFECT_SCALE * 10) / 10;
        const readiness = Math.round(
          (normalizeLevel(o.userLevel) * 4 + normalizePower(o.userPower, maxPower) * 2) * 10,
        ) / 10;
        const reservation = getReservationPenalty(o.id, input.reservations);
        const total = effectScore + readiness + reservation;
        return { officer: o, effectScore, readiness, reservation, total };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 14);

    for (let i = 0; i < bridgeScored.length; i += 1) {
      for (let j = i + 1; j < bridgeScored.length; j += 1) {
        const b1 = bridgeScored[i];
        const b2 = bridgeScored[j];

        const synergyPairs = countSynergyPairs(captain, b1.officer, b2.officer);
        const synergyMultiplier = 1 + synergyPairs * 0.03;

        const baseScore = captainInfo.total + b1.total + b2.total;
        const totalScore = Math.round(baseScore * synergyMultiplier * 10) / 10;

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
          captainInfo.viable,
          captainFallbackUsed,
          synergyPairs,
          captainInfo.reservation + b1.reservation + b2.reservation,
        );

        recs.push({
          captainId: captain.id,
          bridge1Id: b1.officer.id,
          bridge2Id: b2.officer.id,
          totalScore,
          confidence: effectConfidenceFromScore(totalScore),
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

  return Array.from(deduped.values()).slice(0, input.limit ?? 5);
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