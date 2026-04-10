/**
 * read-tools-dock.ts — Dock state, officer conflicts, and fleet analysis
 */

import type { ToolEnv } from "./declarations.js";
import { buildOfficerNameMap, buildShipNameMap } from "./read-tools-formatting.js";
import { getAwayTeamLocks } from "./read-tools-context-helpers.js";

export async function listDocks(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.deps.crewStore.getEffectiveDockState();
  const shipNames = await buildShipNameMap(state.docks.map((dock) => dock.loadout?.shipId ?? ""), ctx);
  const officerNames = await buildOfficerNameMap(
    state.docks.flatMap((dock) => dock.loadout ? Object.values(dock.loadout.bridge).filter((value): value is string => Boolean(value)) : []),
    ctx,
  );
  const results = state.docks.map((d) => ({
    dockNumber: d.dockNumber,
    intentKeys: d.intentKeys,
    source: d.source,
    variantPatch: d.variantPatch,
    assignment: d.loadout
      ? {
          loadoutId: d.loadout.loadoutId,
          loadoutName: d.loadout.name,
          shipId: d.loadout.shipId,
          shipName: shipNames.get(d.loadout.shipId) ?? null,
          bridge: d.loadout.bridge,
          bridgeNames: Object.fromEntries(
            Object.entries(d.loadout.bridge)
              .filter(([, officerId]) => Boolean(officerId))
              .map(([slot, officerId]) => [slot, officerNames.get(officerId as string) ?? officerId]),
          ),
          belowDeckPolicy: d.loadout.belowDeckPolicy
            ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
            : null,
        }
      : null,
  }));

  return { docks: results };
}

export async function getOfficerConflicts(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.deps.crewStore.getEffectiveDockState();
  const officerNames = await buildOfficerNameMap(state.conflicts.map((conflict) => conflict.officerId), ctx);
  return {
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      officerName: officerNames.get(c.officerId) ?? null,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityId: loc.entityId,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
    totalConflicts: state.conflicts.length,
  };
}

export async function analyzeFleet(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const [effectiveState, planItems, loadouts, presets, reservations] = await Promise.all([
    ctx.deps.crewStore.getEffectiveDockState(),
    ctx.deps.crewStore.listPlanItems(),
    ctx.deps.crewStore.listLoadouts(),
    ctx.deps.crewStore.listFleetPresets(),
    ctx.deps.crewStore.listReservations(),
  ]);

  const activePreset = presets.find((p) => p.isActive);

  return {
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name, slots: activePreset.slots.length } : null,
    docks: effectiveState.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      assignment: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            loadoutName: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    loadouts: loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      isActive: l.isActive,
      intentKeys: l.intentKeys,
    })),
    planItems: planItems.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      isActive: p.isActive,
      source: p.source,
    })),
    awayTeams: effectiveState.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: effectiveState.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => loc.entityName),
      locationCount: c.locations.length,
    })),
    totalDocks: effectiveState.docks.length,
    totalLoadouts: loadouts.length,
    totalPlanItems: planItems.length,
    totalConflicts: effectiveState.conflicts.length,
    reservations: reservations.map((r) => ({
      officerId: r.officerId,
      reservedFor: r.reservedFor,
      locked: r.locked,
    })),
    totalReservations: reservations.length,
  };
}

export async function getArmadaContext(
  loadoutIds: number[] | undefined,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const [effectiveState, reservations, awayTeamLocks] = await Promise.all([
    ctx.deps.crewStore.getEffectiveDockState(),
    ctx.deps.crewStore.listReservations(),
    getAwayTeamLocks(ctx),
  ]);

  // Build fast-lookup sets
  const awayTeamByOfficerId = new Map(awayTeamLocks.map((lock) => [lock.officerId, lock]));
  const hardReservationMap = new Map(
    reservations.filter((r) => r.locked).map((r) => [r.officerId, r]),
  );

  // Resolve which docks to analyze
  const assignedDocks = effectiveState.docks.filter((d) => d.loadout != null);
  const docksToCheck = loadoutIds && loadoutIds.length > 0
    ? assignedDocks.filter((d) => loadoutIds.includes(d.loadout!.loadoutId))
    : assignedDocks;

  // Batch name lookups
  const allShipIds = docksToCheck.map((d) => d.loadout!.shipId);
  const allOfficerIds = docksToCheck.flatMap((d) => {
    const b = d.loadout!.bridge;
    return [b.captain, b.bridge_1, b.bridge_2].filter((id): id is string => Boolean(id));
  });
  const [shipNames, officerNames] = await Promise.all([
    buildShipNameMap(allShipIds, ctx),
    buildOfficerNameMap(allOfficerIds, ctx),
  ]);

  const ships = docksToCheck.map((d) => {
    const loadout = d.loadout!;
    const bridgeOfficerIds = [loadout.bridge.captain, loadout.bridge.bridge_1, loadout.bridge.bridge_2]
      .filter((id): id is string => Boolean(id));

    const lockReasons: { type: string; officerId: string; officerName: string | null; detail: string }[] = [];

    for (const officerId of bridgeOfficerIds) {
      const awayLock = awayTeamByOfficerId.get(officerId);
      if (awayLock) {
        lockReasons.push({
          type: "away_team",
          officerId,
          officerName: officerNames.get(officerId) ?? null,
          detail: `On away mission: ${awayLock.missionName}${awayLock.returnTime ? ` (returns ${awayLock.returnTime})` : ""}`,
        });
      }
      const reservation = hardReservationMap.get(officerId);
      if (reservation) {
        lockReasons.push({
          type: "officer_reserved",
          officerId,
          officerName: officerNames.get(officerId) ?? null,
          detail: `Reserved for: ${reservation.reservedFor}`,
        });
      }
    }

    return {
      dockNumber: d.dockNumber,
      loadoutId: loadout.loadoutId,
      loadoutName: loadout.name,
      shipId: loadout.shipId,
      shipName: shipNames.get(loadout.shipId) ?? null,
      intentKeys: d.intentKeys,
      available: lockReasons.length === 0,
      lockReasons,
      bridge: Object.fromEntries(
        Object.entries(loadout.bridge)
          .filter(([, id]) => Boolean(id))
          .map(([slot, id]) => [slot, { id, name: officerNames.get(id as string) ?? null }]),
      ),
    };
  });

  const availableCount = ships.filter((s) => s.available).length;
  const lockedCount = ships.length - availableCount;

  return {
    totalAssignedShips: ships.length,
    availableForArmada: availableCount,
    lockedOrUnavailable: lockedCount,
    ships,
    note: ships.length === 0
      ? "No assigned ships found. Use assign_dock to set up dock assignments first."
      : undefined,
  };
}
