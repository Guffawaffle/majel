import type { BridgeSlot, CatalogOfficer, OfficerReservation } from "./types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import type {
  OfficerAbility,
  OfficerEvaluation,
  TargetContext,
  SlotContext,
  ShipClass,
  EffectScoreEntry,
} from "./types/effect-types.js";
import { evaluateOfficer } from "./effect-evaluator.js";

export interface CrewRecommendInput {
  officers: CatalogOfficer[];
  reservations: OfficerReservation[];
  intentKey: string;
  shipClass?: string | null;
  targetClass?: "explorer" | "interceptor" | "battleship" | "any";
  captainId?: string;
  limit?: number;
  /** When provided, use effect-based scoring (ADR-034). */
  effectBundle?: EffectBundleData;
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

const INTENT_KEYWORDS: Record<string, string[]> = {
  grinding: ["hostile", "damage", "pve", "mitigation", "armor", "shield", "hull"],
  "grinding-swarm": ["swarm", "hostile", "pve"],
  "grinding-eclipse": ["eclipse", "hostile", "pve"],
  armada: ["armada", "group", "allies", "team", "damage", "critical"],
  "armada-solo": ["armada", "solo", "damage", "surviv"],
  pvp: ["player", "pvp", "critical", "weapon", "mitigation", "defense"],
  "base-defense": ["base", "defense", "mitigation", "shield", "hull"],
  exploration: ["warp", "exploration", "speed"],
  voyages: ["warp", "cargo", "speed"],
  "cargo-run": ["cargo", "protected cargo", "warp"],
  events: ["event", "hostile", "armada", "mining"],
  "away-team": ["away", "mission", "trait"],
  general: ["damage", "defense", "health", "hostile", "mining"],
};

const CLASS_KEYWORDS: Record<string, string[]> = {
  explorer: ["explorer", "explorers"],
  interceptor: ["interceptor", "interceptors"],
  battleship: ["battleship", "battleships"],
};

interface OfficerScoreBreakdown {
  goalFit: number;
  shipFit: number;
  counterFit: number;
  effectScore: number;
  readiness: number;
  reservation: number;
  captainBonus: number;
}

interface StructuredAbility {
  name?: string | null;
  description?: string | null;
  shortDescription?: string | null;
}

interface StructuredAbilities {
  captainManeuver?: StructuredAbility | null;
  officerAbility?: StructuredAbility | null;
  belowDeckAbility?: StructuredAbility | null;
}

const MINING_RESOURCE_KEYWORDS: Record<string, string[]> = {
  "mining-gas": ["gas"],
  "mining-crystal": ["crystal"],
  "mining-ore": ["ore"],
  "mining-tri": ["tritanium"],
  "mining-dil": ["dilithium"],
  "mining-para": ["parsteel"],
  "mining-lat": ["latinum"],
  "mining-iso": ["isogen"],
  "mining-data": ["data", "decoded data", "corrupted data"],
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function getStructuredAbilities(officer: CatalogOfficer): StructuredAbilities {
  if (!officer.abilities || typeof officer.abilities !== "object") return {};
  const raw = officer.abilities as Record<string, unknown>;
  return {
    captainManeuver: typeof raw.captainManeuver === "object" && raw.captainManeuver
      ? raw.captainManeuver as StructuredAbility
      : null,
    officerAbility: typeof raw.officerAbility === "object" && raw.officerAbility
      ? raw.officerAbility as StructuredAbility
      : null,
    belowDeckAbility: typeof raw.belowDeckAbility === "object" && raw.belowDeckAbility
      ? raw.belowDeckAbility as StructuredAbility
      : null,
  };
}

function joinAbilityText(primary: string | null, structured: StructuredAbility | null | undefined): string {
  return [
    normalizeText(structured?.name),
    normalizeText(structured?.shortDescription),
    normalizeText(structured?.description),
    normalizeText(primary),
  ].filter(Boolean).join(" ");
}

function activeAbilityTextBySlot(officer: CatalogOfficer, slot: BridgeSlot): string {
  const structured = getStructuredAbilities(officer);
  const cmText = joinAbilityText(officer.captainManeuver, structured.captainManeuver);
  const oaText = joinAbilityText(officer.officerAbility, structured.officerAbility);

  // Activation rules:
  // - CM: captain slot only
  // - OA: all bridge slots (captain + bridge_1 + bridge_2)
  // - BDA: below-deck slots only (excluded from this bridge recommender)
  if (slot === "captain") {
    return [cmText, oaText].filter(Boolean).join(" ");
  }

  return oaText;
}

function miningGoalFit(intentKey: string, slot: BridgeSlot, captainText: string, bridgeText: string): number {
  const keywords = MINING_RESOURCE_KEYWORDS[intentKey] ?? [];
  const text = slot === "captain" ? captainText : bridgeText;
  const resourceSpecific = keywords.length > 0 && keywords.some((keyword) =>
    new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  const isMining = /\bmining\b|\bminer\b/.test(text);

  if (resourceSpecific && isMining) return slot === "captain" ? 10 : 8;
  if (isMining) return slot === "captain" ? 3 : 4;
  return 0;
}

function getReservationPenalty(officerId: string, reservations: OfficerReservation[]): number {
  const reservation = reservations.find((r) => r.officerId === officerId);
  if (!reservation) return 0;
  return reservation.locked ? -6 : -3;
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
}

function normalizeLevel(value: number | null): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, value / 60);
}

function normalizePower(value: number | null, maxPower: number): number {
  if (!value || value <= 0 || maxPower <= 0) return 0;
  return Math.min(1, value / maxPower);
}

function scoreOfficerForSlotLegacy(
  officer: CatalogOfficer,
  opts: {
    intentKey: string;
    shipClass?: string | null;
    targetClass?: "explorer" | "interceptor" | "battleship" | "any";
    reservations: OfficerReservation[];
    maxPower: number;
    slot: BridgeSlot;
  },
): OfficerScoreBreakdown {
  const activeText = activeAbilityTextBySlot(officer, opts.slot);
  const structured = getStructuredAbilities(officer);
  const captainText = activeAbilityTextBySlot(officer, "captain");
  const bridgeText = activeAbilityTextBySlot(officer, "bridge_1");
  const intentKeywords = INTENT_KEYWORDS[opts.intentKey] ?? INTENT_KEYWORDS.general;
  const reservation = getReservationPenalty(officer.id, opts.reservations);

  let goalFit = 0;
  if (opts.intentKey.startsWith("mining-")) {
    goalFit = miningGoalFit(opts.intentKey, opts.slot, captainText, bridgeText);
  } else {
    goalFit = hasKeyword(activeText, intentKeywords) ? 6 : 0;
  }

  const shipClass = (opts.shipClass ?? "").toLowerCase();
  const shipKeywords = shipClass && CLASS_KEYWORDS[shipClass] ? CLASS_KEYWORDS[shipClass] : [];
  const shipFit = shipKeywords.length > 0 && hasKeyword(activeText, shipKeywords) ? 3 : 0;

  const targetKeywords = opts.targetClass && opts.targetClass !== "any"
    ? CLASS_KEYWORDS[opts.targetClass]
    : [];
  const counterFit = targetKeywords.length > 0 && hasKeyword(activeText, targetKeywords) ? 3 : 0;

  const readiness = Math.round((normalizeLevel(officer.userLevel) * 4 + normalizePower(officer.userPower, opts.maxPower) * 2) * 10) / 10;

  const hasCaptainManeuver = Boolean(
    (officer.captainManeuver ?? "").trim()
    || normalizeText(structured.captainManeuver?.name)
    || normalizeText(structured.captainManeuver?.shortDescription)
    || normalizeText(structured.captainManeuver?.description),
  );
  const cmFullText = [
    normalizeText(structured.captainManeuver?.name),
    normalizeText(structured.captainManeuver?.shortDescription),
    normalizeText(structured.captainManeuver?.description),
    normalizeText(officer.captainManeuver),
  ].filter(Boolean).join(" ");
  const isInertCm = /\bhas no effect\b|\binert\b|\bdoes nothing\b/.test(cmFullText);
  const captainBonus = opts.slot === "captain" ? (hasCaptainManeuver && !isInertCm ? 3 : -2) : 0;

  return {
    goalFit,
    shipFit,
    counterFit,
    effectScore: 0,
    readiness,
    reservation,
    captainBonus,
  };
}

function synergyScore(a: CatalogOfficer, b: CatalogOfficer): number {
  if (!a.synergyId || !b.synergyId) return 0;
  return a.synergyId === b.synergyId ? 4 : 0;
}

function confidenceFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 28) return "high";
  if (score >= 18) return "medium";
  return "low";
}

function recommendBridgeTriosLegacy(input: CrewRecommendInput): CrewRecommendation[] {
  const pool = input.officers.filter((o) => o.ownershipState !== "unowned");
  if (pool.length < 3) return [];

  const maxPower = Math.max(...pool.map((o) => o.userPower ?? 0), 1);
  const byId = new Map(pool.map((o) => [o.id, o]));

  const rankedForCaptain = [...pool]
    .sort((a, b) => {
      const sa = scoreOfficerForSlot(a, {
        intentKey: input.intentKey,
        shipClass: input.shipClass,
        targetClass: input.targetClass,
        reservations: input.reservations,
        maxPower,
        slot: "captain",
      });
      const sb = scoreOfficerForSlot(b, {
        intentKey: input.intentKey,
        shipClass: input.shipClass,
        targetClass: input.targetClass,
        reservations: input.reservations,
        maxPower,
        slot: "captain",
      });
      const scoreA = sa.goalFit + sa.shipFit + sa.counterFit + sa.readiness + sa.reservation + sa.captainBonus;
      const scoreB = sb.goalFit + sb.shipFit + sb.counterFit + sb.readiness + sb.reservation + sb.captainBonus;
      return scoreB - scoreA;
    })
    .slice(0, 12);

  const preferredCaptain = input.captainId ? byId.get(input.captainId) : null;
  const captainCandidates = preferredCaptain
    ? [preferredCaptain]
    : rankedForCaptain.slice(0, 6);

  const recs: CrewRecommendation[] = [];

  for (const captain of captainCandidates) {
    const pairPool = pool
      .filter((o) => o.id !== captain.id)
      .sort((a, b) => {
        const sa = scoreOfficerForSlot(a, {
          intentKey: input.intentKey,
          shipClass: input.shipClass,
          targetClass: input.targetClass,
          reservations: input.reservations,
          maxPower,
          slot: "bridge_1",
        });
        const sb = scoreOfficerForSlot(b, {
          intentKey: input.intentKey,
          shipClass: input.shipClass,
          targetClass: input.targetClass,
          reservations: input.reservations,
          maxPower,
          slot: "bridge_1",
        });
        const scoreA = sa.goalFit + sa.shipFit + sa.counterFit + sa.readiness + sa.reservation;
        const scoreB = sb.goalFit + sb.shipFit + sb.counterFit + sb.readiness + sb.reservation;
        return scoreB - scoreA;
      })
      .slice(0, 14);
    for (let i = 0; i < pairPool.length; i += 1) {
      for (let j = i + 1; j < pairPool.length; j += 1) {
        const bridge1 = pairPool[i];
        const bridge2 = pairPool[j];
        if (bridge1.id === bridge2.id) continue;

        const c = scoreOfficerForSlot(captain, {
          intentKey: input.intentKey,
          shipClass: input.shipClass,
          targetClass: input.targetClass,
          reservations: input.reservations,
          maxPower,
          slot: "captain",
        });
        const b1 = scoreOfficerForSlot(bridge1, {
          intentKey: input.intentKey,
          shipClass: input.shipClass,
          targetClass: input.targetClass,
          reservations: input.reservations,
          maxPower,
          slot: "bridge_1",
        });
        const b2 = scoreOfficerForSlot(bridge2, {
          intentKey: input.intentKey,
          shipClass: input.shipClass,
          targetClass: input.targetClass,
          reservations: input.reservations,
          maxPower,
          slot: "bridge_2",
        });

        const synergy = synergyScore(captain, bridge1) + synergyScore(captain, bridge2) + Math.round(synergyScore(bridge1, bridge2) / 2);

        const factors: CrewRecommendationFactor[] = [
          { key: "goalFit", label: "Goal Fit", score: c.goalFit + b1.goalFit + b2.goalFit },
          { key: "shipFit", label: "Ship Fit", score: c.shipFit + b1.shipFit + b2.shipFit },
          { key: "counterFit", label: "Counter Fit", score: c.counterFit + b1.counterFit + b2.counterFit },
          { key: "synergy", label: "Synergy", score: synergy },
          { key: "readiness", label: "Readiness", score: Math.round((c.readiness + b1.readiness + b2.readiness) * 10) / 10 },
          { key: "reservation", label: "Reservation Penalty", score: c.reservation + b1.reservation + b2.reservation },
        ];

        const totalScore = Math.round(
          (factors.reduce((acc, factor) => acc + factor.score, 0) + c.captainBonus) * 10,
        ) / 10;

        const reasons: string[] = [];
        if (c.captainBonus > 0) reasons.push(`${captain.name} has a Captain Maneuver.`);
        if (synergy > 0) reasons.push(`Synergy group overlap detected (+${synergy}).`);
        if (factors.find((f) => f.key === "goalFit")?.score) reasons.push("Ability text aligns with selected objective.");
        if ((c.reservation + b1.reservation + b2.reservation) < 0) reasons.push("Includes reserved officer(s); review before saving.");

        recs.push({
          captainId: captain.id,
          bridge1Id: bridge1.id,
          bridge2Id: bridge2.id,
          totalScore,
          confidence: confidenceFromScore(totalScore),
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
// Effect-Based Scoring (ADR-034)
// ═══════════════════════════════════════════════════════════════

/** Effect evaluator scores are small decimals (0–2). Scale to match keyword score range. */
const EFFECT_SCALE = 10;

/**
 * Build a TargetContext from an intent's default context plus user overrides.
 */
function buildTargetContext(
  intent: { defaultContext: TargetContext } | undefined,
  shipClass?: string | null,
  targetClass?: string | null,
): TargetContext {
  const dc = intent?.defaultContext;
  const ctx: TargetContext = {
    targetKind: dc?.targetKind ?? "hostile",
    engagement: dc?.engagement ?? "any",
    targetTags: [...(dc?.targetTags ?? [])],
  };

  if (shipClass) {
    ctx.shipContext = { shipClass: shipClass as ShipClass };
  }

  if (targetClass && targetClass !== "any") {
    ctx.targetTags.push(`target_${targetClass}`);
  }

  return ctx;
}

function bridgeSlotToSlotContext(slot: BridgeSlot): SlotContext {
  return slot === "captain" ? "captain" : "bridge";
}

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
      if (
        effect.applicableTargetKinds.length > 0
        && !effect.applicableTargetKinds.includes(ctx.targetKind)
      ) continue;
      return true;
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
      const effect = ability?.effects.find((e) => e.effectKey === effectEval.effectKey);
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
  const bundle = input.effectBundle!;
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
  const captainCandidates = preferredCaptain
    ? captainScored.filter((s) => s.officer.id === preferredCaptain.id)
    : captainScored.slice(0, 6);

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
// Public API (dispatches based on effectBundle feature flag)
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
    effectBundle?: EffectBundleData;
  },
): OfficerScoreBreakdown {
  if (opts.effectBundle) {
    return scoreOfficerForSlotEffect(officer, { ...opts, effectBundle: opts.effectBundle });
  }
  return scoreOfficerForSlotLegacy(officer, opts);
}

export function recommendBridgeTrios(input: CrewRecommendInput): CrewRecommendation[] {
  if (input.effectBundle) {
    return recommendBridgeTriosEffect(input);
  }
  return recommendBridgeTriosLegacy(input);
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