import type { ToolContext } from "./declarations.js";
import { parseBattleLog, mapOfficerIdsToAbilities } from "./read-tools-data-helpers.js";
import { calculateResearchAdvisory, extractRelevantBuffs } from "./read-tools-research-helpers.js";

export async function analyzeBattleLog(
  battleLog: unknown,
  ctx: ToolContext,
): Promise<object> {
  const parsed = parseBattleLog(battleLog);
  if (!parsed) {
    return { error: "Invalid battle_log payload. Expected object with non-empty rounds array." };
  }

  const roundAnalysis = parsed.rounds.map((round) => {
    const damageReceived = round.damageReceived.reduce((sum, entry) => sum + entry.amount, 0);
    const damageDealt = round.damageDealt.reduce((sum, entry) => sum + entry.amount, 0);
    const incomingByType = new Map<string, number>();
    for (const event of round.damageReceived) {
      const key = event.type ?? "unknown";
      incomingByType.set(key, (incomingByType.get(key) ?? 0) + event.amount);
    }

    return {
      round: round.round,
      damageReceived,
      damageDealt,
      net: damageDealt - damageReceived,
      hullAfter: round.hullAfter,
      shieldAfter: round.shieldAfter,
      destroyed: round.destroyed,
      abilityTriggers: round.abilityTriggers,
      incomingByType: Array.from(incomingByType.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([type, amount]) => ({ type, amount })),
    };
  });

  const failureRound = roundAnalysis
    .filter((row) => row.destroyed)
    .sort((a, b) => a.round - b.round)[0]
    ?? [...roundAnalysis].sort((a, b) => b.damageReceived - a.damageReceived)[0];

  const topIncomingType = (failureRound.incomingByType[0]?.type ?? "unknown").toLowerCase();
  const likelyCause = topIncomingType.includes("kinetic")
    ? "kinetic_spike_overwhelmed_mitigation"
    : topIncomingType.includes("energy")
      ? "energy_spike_broke_shields"
      : "sustained_damage_exceeded_defense";

  const allTriggered = Array.from(new Set(roundAnalysis.flatMap((row) => row.abilityTriggers))).slice(0, 10);
  const officerRefs = await mapOfficerIdsToAbilities(
    Array.from(new Set([...parsed.attackerOfficers, ...parsed.defenderOfficers])),
    ctx,
  );

  const researchNodes = ctx.researchStore ? await ctx.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(researchNodes);
  const relevantBuffs = extractRelevantBuffs(researchNodes, "pvp").slice(0, 8);

  return {
    battle: {
      battleId: parsed.battleId,
      mode: parsed.mode,
      rounds: parsed.rounds.length,
    },
    failurePoint: {
      round: failureRound.round,
      likelyCause,
      damageReceived: failureRound.damageReceived,
      hullAfter: failureRound.hullAfter,
      shieldAfter: failureRound.shieldAfter,
      destroyed: failureRound.destroyed,
    },
    roundByRound: roundAnalysis,
    abilityHighlights: {
      triggeredAbilities: allTriggered,
      officerAbilities: officerRefs,
    },
    researchContext: {
      ...researchAdvisory,
      referencedBuffs: relevantBuffs.map((buff) => ({
        nodeName: buff.nodeName,
        nodeId: buff.nodeId,
        metric: buff.metric,
        value: buff.value,
        unit: buff.unit,
      })),
    },
  };
}

export async function suggestCounter(
  battleLog: unknown,
  ctx: ToolContext,
): Promise<object> {
  const analysis = await analyzeBattleLog(battleLog, ctx) as Record<string, unknown>;
  if (analysis.error) return analysis;

  const failure = analysis.failurePoint as Record<string, unknown>;
  const likelyCause = String(failure.likelyCause ?? "sustained_damage_exceeded_defense");
  const officerPool: Array<Record<string, unknown>> = [];

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map((officer) => [officer.id, officer]));
    for (const overlay of overlays) {
      const ref = refMap.get(overlay.refId);
      if (!ref) continue;
      officerPool.push({
        officerId: ref.id,
        name: ref.name,
        ability: ref.officerAbility ?? "",
      });
    }
  }

  const preferTerms = likelyCause.includes("energy")
    ? ["shield", "mitigation", "defense"]
    : likelyCause.includes("kinetic")
      ? ["hull", "defense", "mitigation"]
      : ["mitigation", "defense", "shield"];

  const swapCandidates = officerPool
    .filter((officer) => {
      const ability = String(officer.ability).toLowerCase();
      return preferTerms.some((token) => ability.includes(token));
    })
    .slice(0, 3)
    .map((officer) => ({
      action: "swap_in",
      officerId: officer.officerId,
      officerName: officer.name,
      reason: `Ability aligns with ${preferTerms.join("/")} mitigation focus.`,
    }));

  const researchContext = analysis.researchContext as Record<string, unknown>;
  const referencedBuffs = (researchContext.referencedBuffs as Array<Record<string, unknown>> | undefined) ?? [];
  const topBuff = referencedBuffs[0];

  return {
    failureSummary: {
      likelyCause,
      failedRound: failure.round,
    },
    recommendedChanges: [
      {
        category: "crew",
        recommendation: swapCandidates.length > 0
          ? "Rotate in defensive specialists from owned roster."
          : "Prioritize adding a defensive specialist to this matchup.",
        swaps: swapCandidates,
      },
      {
        category: "ship_tuning",
        recommendation: likelyCause.includes("energy")
          ? "Prioritize shield-focused mitigation and energy resistance tuning."
          : likelyCause.includes("kinetic")
            ? "Prioritize hull survivability and kinetic damage reduction."
            : "Balance shield and hull mitigation to reduce sustained damage collapse.",
      },
      {
        category: "research",
        recommendation: topBuff
          ? `Leverage ${String(topBuff.nodeName)} (${String(topBuff.metric)} ${String(topBuff.value)} ${String(topBuff.unit)}).`
          : "Research context unavailable or sparse; treat as advisory only.",
      },
    ],
    dataQuality: {
      hasOwnedRosterContext: officerPool.length > 0,
      hasResearchContext: referencedBuffs.length > 0,
      researchPriority: researchContext.priority ?? "none",
    },
  };
}