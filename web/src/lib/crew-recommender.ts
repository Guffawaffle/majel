/**
 * crew-recommender.ts — Bridge Crew Recommender (barrel) (#192)
 *
 * Decomposed into pipeline modules:
 *   crew-recommender-scoring.ts    — Scoring math + effect breakdown
 *   crew-recommender-viability.ts  — Captain viability gating
 *   crew-recommender-rationale.ts  — Explainability / rationale formatting
 *   crew-recommender-confidence.ts — Confidence + synergy
 */

import type { BridgeSlot, CatalogOfficer, OfficerReservation } from "./types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import type { TargetContextOverrides } from "./effect-context.js";
import { evaluateOfficer } from "./effect-evaluator.js";
import { buildTargetContext, bridgeSlotToSlotContext } from "./effect-context.js";

import {
  normalizeLevel,
  normalizePower,
  buildEffectBreakdown,
  scoreFromBreakdown,
  READINESS_LEVEL_WEIGHT,
  READINESS_POWER_WEIGHT,
} from "./crew-recommender-scoring.js";
import {
  deriveIntentGroup,
  resolveIntentOrThrow,
  getCaptainViability,
} from "./crew-recommender-viability.js";
import {
  reservationExclusionSummary,
  buildEffectReasons,
} from "./crew-recommender-rationale.js";
import {
  effectConfidenceFromBreakdowns,
  countSynergyPairs,
  SYNERGY_PAIR_BONUS,
} from "./crew-recommender-confidence.js";

export type ReservationExclusionMode = "allow" | "exclude_locked" | "exclude_all_reserved";

export interface CrewRecommendInput {
  officers: CatalogOfficer[];
  reservations: OfficerReservation[];
  reservationExclusionMode?: ReservationExclusionMode;
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

export interface OfficerScoreBreakdown {
  goalFit: number;
  shipFit: number;
  counterFit: number;
  effectScore: number;
  readiness: number;
  reservation: number;
  captainBonus: number;
  captainReason: string | null;
}

// ─── Reservation Helpers ────────────────────────────────────

function getReservationPenalty(officerId: string, reservations: OfficerReservation[]): number {
  const reservation = reservations.find((r) => r.officerId === officerId);
  if (!reservation) return 0;
  return reservation.locked ? -6 : -3;
}

function getReservationForOfficer(officerId: string, reservations: OfficerReservation[]): OfficerReservation | undefined {
  return reservations.find((reservation) => reservation.officerId === officerId);
}

function isExcludedByReservationMode(
  officerId: string,
  reservations: OfficerReservation[],
  mode: ReservationExclusionMode,
): boolean {
  if (mode === "allow") return false;
  const reservation = getReservationForOfficer(officerId, reservations);
  if (!reservation) return false;
  if (mode === "exclude_all_reserved") return true;
  return reservation.locked;
}

// ─── Single-Officer Scoring ─────────────────────────────────

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
  let captainReason: string | null = null;
  if (opts.slot === "captain") {
    const captainViability = getCaptainViability(abilities, ctx, weights, intentGroup);
    captainBonus = captainViability.viable ? 2 : -3;
    captainReason = captainViability.reason;
  }

  return {
    goalFit: 0,
    shipFit: 0,
    counterFit: 0,
    effectScore,
    readiness,
    reservation,
    captainBonus,
    captainReason,
  };
}

// ─── Pipeline Orchestration ─────────────────────────────────

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
  const reservationExclusionMode = input.reservationExclusionMode ?? "allow";

  const preferredCaptain = input.captainId ? byId.get(input.captainId) : null;
  const reservationModeReason = reservationExclusionSummary(input.reservations, reservationExclusionMode);
  const preferredCaptainOverrideReason = preferredCaptain
    && isExcludedByReservationMode(preferredCaptain.id, input.reservations, reservationExclusionMode)
    ? "Preferred captain override kept a reserved officer eligible despite reservation exclusion mode."
    : null;
  const recommendationPool = pool.filter((officer) => (
    !isExcludedByReservationMode(officer.id, input.reservations, reservationExclusionMode)
    || officer.id === preferredCaptain?.id
  ));

  if (recommendationPool.length < 3) return [];

  // Score all officers for captain slot with gating
  const captainScored = recommendationPool.map((o) => {
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
    const captainViability = getCaptainViability(abilities, ctx, weights, intentGroup);
    const viable = captainViability.viable;
    const captainBonus = viable ? 2 : -3;
    const total = effectScore + readiness + reservation + captainBonus;
    return {
      officer: o,
      effectScore,
      readiness,
      reservation,
      captainBonus,
      total,
      viable,
      captainReason: captainViability.reason,
      breakdown,
    };
  });

  // Sort: viable captains first, then by total score
  captainScored.sort((a, b) => {
    if (a.viable !== b.viable) return a.viable ? -1 : 1;
    return b.total - a.total;
  });

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
    const bridgeScored = recommendationPool
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
          captainInfo.captainReason,
          captainFallbackUsed,
          captainFallbackUsed && !fallbackWarningEmitted,
          reservationModeReason,
          preferredCaptainOverrideReason,
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