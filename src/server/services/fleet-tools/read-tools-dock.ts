/**
 * read-tools-dock.ts — Dock state, officer conflicts, and fleet analysis
 */

import type { ToolEnv } from "./declarations.js";
import { buildOfficerNameMap, buildShipNameMap } from "./read-tools-formatting.js";

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
