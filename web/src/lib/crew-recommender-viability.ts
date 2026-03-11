/**
 * crew-recommender-viability.ts — Captain viability gating (#192)
 */

import type { OfficerAbility, TargetContext } from "./types/effect-types.js";
import type { EffectBundleData } from "./effect-bundle-adapter.js";
import { evaluateEffect } from "./effect-evaluator.js";
import captainViabilityKeysV0 from "./data/captain-viability-keys.v0.json";

// ─── Types ──────────────────────────────────────────────────

export type IntentGroup = "combat" | "economy";

// ─── Captain Viability Keys ────────────────────────────────

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

// ─── Intent Resolution ─────────────────────────────────────

export function deriveIntentGroup(intentKey: string, ctx: TargetContext): IntentGroup {
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

export function resolveIntentOrThrow(
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

// ─── Captain Viability ──────────────────────────────────────

export function isCaptainViable(
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

function hasNoBenefitCaptainText(rawText: string | null): boolean {
  const normalized = rawText?.toLowerCase() ?? "";
  return normalized.includes("provides no benefit")
    || normalized.includes("does not have a captain")
    || normalized.includes("does not have a captain maneuver")
    || normalized.includes("does not have a captain's maneuver");
}

export function getCaptainViability(
  abilities: OfficerAbility[],
  ctx: TargetContext,
  intentWeights: Record<string, number>,
  intentGroup: IntentGroup,
): { viable: boolean; reason: string | null } {
  const cmAbilities = abilities.filter((a) => a.slot === "cm");
  const activeCmAbilities = cmAbilities.filter((a) => !a.isInert);
  if (activeCmAbilities.length === 0) {
    if (cmAbilities.some((ability) => ability.isInert && hasNoBenefitCaptainText(ability.rawText))) {
      return { viable: false, reason: "Captain Maneuver provides no benefit for this objective." };
    }
    return { viable: false, reason: "No usable Captain Maneuver for this objective." };
  }

  if (isCaptainViable(abilities, ctx, intentWeights, intentGroup)) {
    return { viable: true, reason: null };
  }

  return { viable: false, reason: "Captain Maneuver has no useful effect for this objective." };
}
