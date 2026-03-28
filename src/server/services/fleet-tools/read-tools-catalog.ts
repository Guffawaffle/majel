/**
 * read-tools-catalog.ts — Fleet overview, search, and detail tools
 */

import type { ToolEnv } from "./declarations.js";
import { hullTypeLabel, officerClassLabel } from "../game-enums.js";
import { annotateBuildCostResources } from "./read-tools-formatting.js";

const SEARCH_LIMIT = 20;

export async function getFleetOverview(ctx: ToolEnv): Promise<object> {
  const overview: Record<string, unknown> = {};

  if (ctx.deps.referenceStore) {
    const refCounts = await ctx.deps.referenceStore.counts();
    overview.referenceCatalog = {
      officers: refCounts.officers,
      ships: refCounts.ships,
    };
  }

  if (ctx.deps.overlayStore) {
    const overlayCounts = await ctx.deps.overlayStore.counts();
    overview.overlays = {
      officers: overlayCounts.officers,
      ships: overlayCounts.ships,
    };
  }

  if (ctx.deps.crewStore) {
    const [loadouts, docks, planItems, bridgeCores, presets, reservations] = await Promise.all([
      ctx.deps.crewStore.listLoadouts(),
      ctx.deps.crewStore.listDocks(),
      ctx.deps.crewStore.listPlanItems(),
      ctx.deps.crewStore.listBridgeCores(),
      ctx.deps.crewStore.listFleetPresets(),
      ctx.deps.crewStore.listReservations(),
    ]);
    const activePreset = presets.find((p) => p.isActive);
    overview.crew = {
      loadouts: loadouts.length,
      docks: docks.length,
      planItems: planItems.length,
      bridgeCores: bridgeCores.length,
      fleetPresets: presets.length,
      activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
      reservations: reservations.length,
      lockedReservations: reservations.filter((r) => r.locked).length,
    };
  }

  return overview;
}

export async function searchOfficers(query: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const officers = await ctx.deps.referenceStore.searchOfficers(query);
  const reservations = ctx.deps.crewStore ? await ctx.deps.crewStore.listReservations() : [];
  const reservationMap = new Map(reservations.map((r) => [r.officerId, r]));

  const results = officers.slice(0, SEARCH_LIMIT).map((o) => {
    const res = reservationMap.get(o.id);
    return {
      id: o.id,
      name: o.name,
      rarity: o.rarity,
      group: o.groupName,
      officerClass: officerClassLabel(o.officerClass),
      captainManeuver: o.captainManeuver,
      officerAbility: o.officerAbility,
      ...(o.faction ? { faction: (o.faction as Record<string, unknown>).name ?? null } : {}),
      ...(res ? { reservation: { reservedFor: res.reservedFor, locked: res.locked } } : {}),
    };
  });

  return {
    results,
    totalFound: officers.length,
    truncated: officers.length > SEARCH_LIMIT,
  };
}

export async function searchShips(query: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const ships = await ctx.deps.referenceStore.searchShips(query);
  const results = ships.slice(0, SEARCH_LIMIT).map((s) => ({
    id: s.id,
    name: s.name,
    shipClass: s.shipClass,
    grade: s.grade,
    rarity: s.rarity,
    faction: s.faction,
    tier: s.tier,
    hullType: hullTypeLabel(s.hullType),
    maxTier: s.maxTier,
  }));

  return {
    results,
    totalFound: ships.length,
    truncated: ships.length > SEARCH_LIMIT,
  };
}

export async function getOfficerDetail(officerId: string, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.deps.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officerClassLabel(officer.officerClass),
      faction: officer.faction ? (officer.faction as Record<string, unknown>).name ?? null : null,
      captainManeuver: officer.captainManeuver,
      officerAbility: officer.officerAbility,
      belowDeckAbility: officer.belowDeckAbility,
      maxRank: officer.maxRank,
      synergyId: officer.synergyId,
      abilities: officer.abilities,
      traitConfig: officer.traitConfig,
      source: officer.source,
    },
  };

  if (ctx.deps.overlayStore) {
    const overlay = await ctx.deps.overlayStore.getOfficerOverlay(officerId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        level: overlay.level,
        rank: overlay.rank,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

export async function getShipDetail(shipId: string, ctx: ToolEnv): Promise<object> {
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

  const result: Record<string, unknown> = {
    reference: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
      tier: ship.tier,
      hullType: hullTypeLabel(ship.hullType),
      maxTier: ship.maxTier,
      maxLevel: ship.maxLevel,
      blueprintsRequired: ship.blueprintsRequired,
      buildRequirements: annotateBuildCostResources(ship.buildRequirements, ctx),
      tiers: annotateBuildCostResources(ship.tiers, ctx),
      buildTimeInSeconds: ship.buildTimeInSeconds,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
      ability: ship.ability,
      source: ship.source,
    },
  };

  if (ctx.deps.overlayStore) {
    const overlay = await ctx.deps.overlayStore.getShipOverlay(shipId);
    if (overlay) {
      result.overlay = {
        ownershipState: overlay.ownershipState,
        target: overlay.target,
        tier: overlay.tier,
        level: overlay.level,
        power: overlay.power,
        targetNote: overlay.targetNote,
        targetPriority: overlay.targetPriority,
      };
    }
  }

  return result;
}

const BATCH_LIMIT = 10;

export async function getOfficersDetail(officerIds: string[], ctx: ToolEnv): Promise<object> {
  if (!Array.isArray(officerIds) || officerIds.length === 0) {
    return { error: "officer_ids must be a non-empty array." };
  }
  const ids = officerIds.slice(0, BATCH_LIMIT);
  const results: Record<string, object> = {};
  for (const id of ids) {
    results[id] = await getOfficerDetail(id, ctx);
  }
  return { officers: results, count: Object.keys(results).length };
}

export async function getShipsDetail(shipIds: string[], ctx: ToolEnv): Promise<object> {
  if (!Array.isArray(shipIds) || shipIds.length === 0) {
    return { error: "ship_ids must be a non-empty array." };
  }
  const ids = shipIds.slice(0, BATCH_LIMIT);
  const results: Record<string, object> = {};
  for (const id of ids) {
    results[id] = await getShipDetail(id, ctx);
  }
  return { ships: results, count: Object.keys(results).length };
}
