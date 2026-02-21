import type { BridgeSlot, CatalogOfficer, OfficerReservation } from "./types.js";

export interface CrewRecommendInput {
  officers: CatalogOfficer[];
  reservations: OfficerReservation[];
  intentKey: string;
  shipClass?: string | null;
  targetClass?: "explorer" | "interceptor" | "battleship" | "any";
  captainId?: string;
  limit?: number;
}

export interface CrewRecommendationFactor {
  key: "goalFit" | "shipFit" | "counterFit" | "synergy" | "readiness" | "reservation";
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
  "mining-gas": ["mining", "gas", "protected cargo", "survey"],
  "mining-crystal": ["mining", "crystal", "protected cargo", "survey"],
  "mining-ore": ["mining", "ore", "protected cargo", "survey"],
  "mining-tri": ["mining", "tritanium", "survey"],
  "mining-dil": ["mining", "dilithium", "survey"],
  "mining-para": ["mining", "parasteel", "survey"],
  "mining-lat": ["mining", "latinum", "survey"],
  "mining-iso": ["mining", "isogen", "survey"],
  "mining-data": ["mining", "data", "survey"],
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
  readiness: number;
  reservation: number;
  captainBonus: number;
}

function abilityBlob(officer: CatalogOfficer): string {
  return [officer.captainManeuver, officer.officerAbility, officer.belowDeckAbility]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getReservationPenalty(officerId: string, reservations: OfficerReservation[]): number {
  const reservation = reservations.find((r) => r.officerId === officerId);
  if (!reservation) return 0;
  return reservation.locked ? -6 : -3;
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function normalizeLevel(value: number | null): number {
  if (!value || value <= 0) return 0;
  return Math.min(1, value / 60);
}

function normalizePower(value: number | null, maxPower: number): number {
  if (!value || value <= 0 || maxPower <= 0) return 0;
  return Math.min(1, value / maxPower);
}

export function scoreOfficerForSlot(
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
  const text = abilityBlob(officer);
  const intentKeywords = INTENT_KEYWORDS[opts.intentKey] ?? INTENT_KEYWORDS.general;
  const reservation = getReservationPenalty(officer.id, opts.reservations);

  const goalFit = hasKeyword(text, intentKeywords) ? 6 : 0;

  const shipClass = (opts.shipClass ?? "").toLowerCase();
  const shipKeywords = shipClass && CLASS_KEYWORDS[shipClass] ? CLASS_KEYWORDS[shipClass] : [];
  const shipFit = shipKeywords.length > 0 && hasKeyword(text, shipKeywords) ? 3 : 0;

  const targetKeywords = opts.targetClass && opts.targetClass !== "any"
    ? CLASS_KEYWORDS[opts.targetClass]
    : [];
  const counterFit = targetKeywords.length > 0 && hasKeyword(text, targetKeywords) ? 3 : 0;

  const readiness = Math.round((normalizeLevel(officer.userLevel) * 4 + normalizePower(officer.userPower, opts.maxPower) * 2) * 10) / 10;

  const hasCaptainManeuver = Boolean((officer.captainManeuver ?? "").trim());
  const captainBonus = opts.slot === "captain" ? (hasCaptainManeuver ? 3 : -2) : 0;

  return {
    goalFit,
    shipFit,
    counterFit,
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

export function recommendBridgeTrios(input: CrewRecommendInput): CrewRecommendation[] {
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

  const captainCandidates = input.captainId
    ? rankedForCaptain.filter((o) => o.id === input.captainId)
    : rankedForCaptain.slice(0, 6);

  const recs: CrewRecommendation[] = [];

  for (const captain of captainCandidates) {
    const pairPool = pool.filter((o) => o.id !== captain.id).slice(0, 14);
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
    const key = [rec.captainId, rec.bridge1Id, rec.bridge2Id].sort().join("|");
    if (!deduped.has(key)) deduped.set(key, rec);
  }

  return Array.from(deduped.values()).slice(0, input.limit ?? 5);
}

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