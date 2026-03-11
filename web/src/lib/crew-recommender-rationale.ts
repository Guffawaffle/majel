/**
 * crew-recommender-rationale.ts — Explainability / rationale formatting (#192)
 */

import type { OfficerReservation } from "./types.js";
import type { EffectScoreEntry } from "./types/effect-types.js";
import type { ReservationExclusionMode } from "./crew-recommender.js";
import scoringContractV0 from "./data/scoring-contract.v0.json";

const SYNERGY_PAIR_BONUS = scoringContractV0.synergyPairBonus;

// ─── Reservation Summary ───────────────────────────────────

export function reservationExclusionSummary(
  reservations: OfficerReservation[],
  mode: ReservationExclusionMode,
): string | null {
  if (mode === "allow") return null;
  const excluded = reservations.filter((reservation) => {
    if (mode === "exclude_all_reserved") return true;
    return reservation.locked;
  });
  if (excluded.length === 0) return null;
  return mode === "exclude_locked"
    ? `Excluded ${excluded.length} locked reserved officer${excluded.length === 1 ? "" : "s"} from suggestions.`
    : `Excluded ${excluded.length} reserved officer${excluded.length === 1 ? "" : "s"} from suggestions.`;
}

// ─── Effect Evidence ────────────────────────────────────────

function humanizeEffectKey(effectKey: string): string {
  return effectKey.replace(/_/g, " ");
}

export function summarizeStatusEvidence(entries: EffectScoreEntry[], status: "works" | "conditional" | "blocked"): string | null {
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

// ─── Reason Builder ─────────────────────────────────────────

export function buildEffectReasons(
  captainName: string,
  captainBreakdown: EffectScoreEntry[],
  bridge1Name: string,
  bridge1Breakdown: EffectScoreEntry[],
  bridge2Name: string,
  bridge2Breakdown: EffectScoreEntry[],
  captainViable: boolean,
  captainReason: string | null,
  captainFallbackInRun: boolean,
  includeFallbackWarning: boolean,
  reservationModeReason: string | null,
  preferredCaptainOverrideReason: string | null,
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

  if (!captainViable && captainReason) {
    reasons.push(`⚠ ${captainName}: ${captainReason}`);
  }
  if (includeFallbackWarning) {
    reasons.push("No viable captains found; using best available fallback.");
  }

  if (reservationModeReason) {
    reasons.push(reservationModeReason);
  }

  if (preferredCaptainOverrideReason) {
    reasons.push(preferredCaptainOverrideReason);
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
