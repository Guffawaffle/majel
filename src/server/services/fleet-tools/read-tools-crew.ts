/**
 * read-tools-crew.ts — Crew composition: owned officers, loadouts, suggestions, conflicts
 */

import type { ToolEnv } from "./declarations.js";
import { SEED_INTENTS, type SeedIntent } from "../../types/crew-types.js";
import { hullTypeLabel, officerClassLabel } from "../game-enums.js";
import { buildOfficerNameMap, buildShipNameMap } from "./read-tools-formatting.js";
import {
  calculateResearchAdvisory,
  extractRelevantBuffs,
  buildResearchCitations,
} from "./read-tools-research-helpers.js";
import { getAwayTeamLocks } from "./read-tools-context-helpers.js";

export async function listOwnedOfficers(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.overlayStore) {
    return { error: "Overlay system not available. The Admiral may need to set up ownership data first." };
  }
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }

  const overlays = await ctx.deps.overlayStore.listOfficerOverlays({ ownershipState: "owned" });

  const allOfficers = await ctx.deps.referenceStore.listOfficers();
  const refMap = new Map(allOfficers.map(o => [o.id, o]));

  const officers = overlays.map((overlay) => {
    const ref = refMap.get(overlay.refId);
    if (!ref) return null;
    return {
      id: ref.id,
      name: ref.name,
      rarity: ref.rarity,
      group: ref.groupName,
      officerClass: officerClassLabel(ref.officerClass),
      faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: ref.captainManeuver,
      officerAbility: ref.officerAbility,
      belowDeckAbility: ref.belowDeckAbility,
      level: overlay.level,
      rank: overlay.rank,
      power: overlay.power,
    };
  });

  const results = officers.filter(Boolean);
  return {
    officers: results,
    totalOwned: results.length,
  };
}

export async function getLoadoutDetail(loadoutId: number, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!loadoutId || isNaN(loadoutId)) {
    return { error: "Valid loadout ID is required." };
  }

  const loadout = await ctx.deps.crewStore.getLoadout(loadoutId);
  if (!loadout) {
    return { error: `Loadout not found: ${loadoutId}` };
  }

  const variants = await ctx.deps.crewStore.listVariants(loadoutId);
  const officerNames = await buildOfficerNameMap(loadout.bridgeCore?.members.map((member) => member.officerId) ?? [], ctx);
  const shipNames = await buildShipNameMap(loadout.shipId ? [loadout.shipId] : [], ctx);

  return {
    id: loadout.id,
    name: loadout.name,
    shipId: loadout.shipId,
    shipName: shipNames.get(loadout.shipId) ?? null,
    priority: loadout.priority,
    isActive: loadout.isActive,
    intentKeys: loadout.intentKeys,
    tags: loadout.tags,
    notes: loadout.notes,
    bridgeCore: loadout.bridgeCore
      ? {
          id: loadout.bridgeCore.id,
          name: loadout.bridgeCore.name,
          members: loadout.bridgeCore.members.map((m) => ({
            officerId: m.officerId,
            officerName: officerNames.get(m.officerId) ?? null,
            slot: m.slot,
          })),
        }
      : null,
    belowDeckPolicy: loadout.belowDeckPolicy
      ? {
          id: loadout.belowDeckPolicy.id,
          name: loadout.belowDeckPolicy.name,
          mode: loadout.belowDeckPolicy.mode,
          spec: loadout.belowDeckPolicy.spec,
        }
      : null,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      patch: v.patch,
      notes: v.notes,
    })),
  };
}

export async function findLoadoutsForIntent(intentKey: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.deps.crewStore.listLoadouts({ intentKey });
  const detailed = await Promise.all(
    loadouts.map(async (l) => {
      const full = await ctx.deps.crewStore!.getLoadout(l.id);
      return {
        id: l.id,
        name: l.name,
        shipId: l.shipId,
        isActive: l.isActive,
        bridgeCore: full?.bridgeCore
          ? {
              name: full.bridgeCore.name,
              members: full.bridgeCore.members.map((m) => ({
                officerId: m.officerId,
                slot: m.slot,
              })),
            }
          : null,
      };
    }),
  );

  return {
    intentKey,
    loadouts: detailed,
    totalLoadouts: detailed.length,
  };
}

export async function suggestCrew(
  shipId: string,
  intentKey: string | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.deps.referenceStore.getShip(shipId);
  if (!ship) {
    return { error: `Ship not found: ${shipId}` };
  }

  let intent: { key: string; label: string; category: string; description: string | null } | null = null;
  if (intentKey) {
    const match = SEED_INTENTS.find((i: SeedIntent) => i.key === intentKey);
    if (match) {
      intent = {
        key: match.key,
        label: match.label,
        category: match.category,
        description: match.description,
      };
    }
  }

  const unavailableOfficerReasons = new Map<string, string[]>();
  const awayTeamLocks = await getAwayTeamLocks(ctx);
  for (const assignment of awayTeamLocks) {
    const reasons = unavailableOfficerReasons.get(assignment.officerId) ?? [];
    reasons.push("away_team");
    unavailableOfficerReasons.set(assignment.officerId, reasons);
  }
  if (ctx.deps.crewStore) {
    const reservations = await ctx.deps.crewStore.listReservations();
    for (const reservation of reservations) {
      if (!reservation.locked) continue;
      const reasons = unavailableOfficerReasons.get(reservation.officerId) ?? [];
      reasons.push("reservation_locked");
      unavailableOfficerReasons.set(reservation.officerId, reasons);
    }
  }

  const ownedOfficers: Array<Record<string, unknown>> = [];
  const excludedOfficers: Array<Record<string, unknown>> = [];
  if (ctx.deps.overlayStore) {
    const overlays = await ctx.deps.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.deps.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    for (const overlay of overlays) {
      const ref = refMap.get(overlay.refId);
      if (!ref) continue;
      const reasons = unavailableOfficerReasons.get(ref.id) ?? [];
      if (reasons.length > 0) {
        excludedOfficers.push({
          id: ref.id,
          name: ref.name,
          reasons: Array.from(new Set(reasons)).sort(),
        });
        continue;
      }
      ownedOfficers.push({
        id: ref.id,
        name: ref.name,
        rarity: ref.rarity,
        group: ref.groupName,
        officerClass: officerClassLabel(ref.officerClass),
        faction: ref.faction ? (ref.faction as Record<string, unknown>).name ?? null : null,
        captainManeuver: ref.captainManeuver,
        officerAbility: ref.officerAbility,
        belowDeckAbility: ref.belowDeckAbility,
        level: overlay.level,
        rank: overlay.rank,
      });
    }
  }

  const existingLoadouts: Array<Record<string, unknown>> = [];
  if (ctx.deps.crewStore) {
    const loadouts = await ctx.deps.crewStore.listLoadouts({ shipId });
    const loadoutIds = loadouts.map(l => l.id);
    const fullMap = await ctx.deps.crewStore.getLoadoutsByIds(loadoutIds);
    for (const l of loadouts) {
      const full = fullMap.get(l.id);
      existingLoadouts.push({
        id: l.id,
        name: l.name,
        isActive: l.isActive,
        intentKeys: l.intentKeys,
        bridgeCore: full?.bridgeCore
          ? full.bridgeCore.members.map((m) => ({
              officerId: m.officerId,
              slot: m.slot,
            }))
          : [],
      });
    }
  }

  const researchNodes = ctx.deps.researchStore ? await ctx.deps.researchStore.listNodes() : [];
  const researchAdvisory = calculateResearchAdvisory(researchNodes);
  const relevantResearchBuffs = extractRelevantBuffs(researchNodes, intentKey);
  const researchCitations = buildResearchCitations(relevantResearchBuffs);

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
    },
    intent,
    ownedOfficers,
    excludedOfficers,
    existingLoadouts,
    totalOwnedOfficers: ownedOfficers.length,
    totalExcludedOfficers: excludedOfficers.length,
    researchContext: {
      ...researchAdvisory,
      relevantBuffCount: relevantResearchBuffs.length,
      citations: researchCitations,
      note:
        researchAdvisory.priority === "low"
          ? "Research data is sparse/stale; use only as a secondary signal."
          : "Research data coverage is sufficient to refine recommendations.",
    },
    recommendationHints: {
      prioritizeBaseFit: researchAdvisory.priority !== "medium",
      useResearchAsTiebreaker: researchAdvisory.priority === "low",
      useResearchInCoreScoring: researchAdvisory.priority === "medium",
      citationRequirement:
        researchCitations.length > 0
          ? "When referencing research in rationale, cite by nodeName + nodeId from researchContext.citations."
          : "No research citations available; avoid claiming specific research bonuses.",
    },
  };
}

export async function resolveConflict(officerId: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.deps.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const reservation = await ctx.deps.crewStore.getReservation(officerId);

  const state = await ctx.deps.crewStore.getEffectiveDockState();
  const conflict = state.conflicts.find((c) => c.officerId === officerId) ?? null;

  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.deps.referenceStore.listOfficers({ groupName: officer.groupName });
    const altIds = groupOfficers.filter(a => a.id !== officerId).map(a => a.id);
    const overlayMap = new Map<string, boolean>();
    if (ctx.deps.overlayStore && altIds.length > 0) {
      const ownedOverlays = await ctx.deps.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
      const ownedSet = new Set(ownedOverlays.map(o => o.refId));
      for (const id of altIds) overlayMap.set(id, ownedSet.has(id));
    }
    for (const alt of groupOfficers) {
      if (alt.id === officerId) continue;
      alternatives.push({
        id: alt.id,
        name: alt.name,
        rarity: alt.rarity,
        group: alt.groupName,
        officerClass: officerClassLabel(alt.officerClass),
        faction: alt.faction ? (alt.faction as Record<string, unknown>).name ?? null : null,
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned: overlayMap.get(alt.id) ?? false,
      });
    }
  }

  const loadouts = await ctx.deps.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.deps.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  return {
    officer: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
    },
    conflict: conflict
      ? {
          locations: conflict.locations.map((loc) => ({
            type: loc.type,
            entityName: loc.entityName,
            slot: loc.slot,
          })),
        }
      : null,
    alternatives,
    affectedLoadouts,
    reservation: reservation
      ? { reservedFor: reservation.reservedFor, locked: reservation.locked }
      : null,
  };
}

export async function whatIfRemoveOfficer(officerId: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  let officerName: string | null = null;
  if (ctx.deps.referenceStore) {
    const officer = await ctx.deps.referenceStore.getOfficer(officerId);
    officerName = officer?.name ?? null;
  }

  const loadouts = await ctx.deps.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.deps.crewStore.getLoadoutsByIds(loadoutIds);
  const affectedLoadouts: Array<Record<string, unknown>> = [];
  for (const l of loadouts) {
    const full = fullMap.get(l.id);
    if (full?.bridgeCore?.members.some((m) => m.officerId === officerId)) {
      affectedLoadouts.push({
        loadoutId: l.id,
        loadoutName: l.name,
        shipId: l.shipId,
      });
    }
  }

  const planItems = await ctx.deps.crewStore.listPlanItems();
  const affectedAwayTeams = planItems
    .filter((p) => p.awayOfficers?.includes(officerId))
    .map((p) => ({
      planItemId: p.id,
      planItemLabel: p.label,
    }));

  return {
    officerId,
    officerName,
    affectedLoadouts,
    affectedAwayTeams,
    totalAffectedLoadouts: affectedLoadouts.length,
    totalAffectedAwayTeams: affectedAwayTeams.length,
    totalAffected: affectedLoadouts.length + affectedAwayTeams.length,
  };
}
