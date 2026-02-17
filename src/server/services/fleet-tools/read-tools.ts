/**
 * fleet-tools/read-tools.ts — Read-Only Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * All read-only fleet intelligence tools. Safe to call without confirmation.
 * Covers: fleet overview, search, details, docks, conflicts, crew composition,
 * targets, and analysis.
 */

import type { ToolContext } from "./declarations.js";
import { detectTargetConflicts } from "../target-conflicts.js";
import { SEED_INTENTS, type SeedIntent } from "../../types/crew-types.js";

/** Maximum results for search tools to avoid overwhelming the model context. */
const SEARCH_LIMIT = 20;

/** Hull type numeric → human label (from stfc.space frontend). */
const HULL_TYPE_LABELS: Record<number, string> = {
  0: "Destroyer",
  1: "Survey",
  2: "Explorer",
  3: "Battleship",
  4: "Defense",
  5: "Armada",
};

/** Officer class numeric → human label. */
const OFFICER_CLASS_LABELS: Record<number, string> = {
  1: "Command",
  2: "Science",
  3: "Engineering",
};

// ─── Phase 1: Core Read Tools ───────────────────────────────

export async function getFleetOverview(ctx: ToolContext): Promise<object> {
  const overview: Record<string, unknown> = {};

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    overview.referenceCatalog = {
      officers: refCounts.officers,
      ships: refCounts.ships,
    };
  }

  if (ctx.overlayStore) {
    const overlayCounts = await ctx.overlayStore.counts();
    overview.overlays = {
      officers: overlayCounts.officers,
      ships: overlayCounts.ships,
    };
  }

  if (ctx.crewStore) {
    const [loadouts, docks, planItems, bridgeCores, presets, reservations] = await Promise.all([
      ctx.crewStore.listLoadouts(),
      ctx.crewStore.listDocks(),
      ctx.crewStore.listPlanItems(),
      ctx.crewStore.listBridgeCores(),
      ctx.crewStore.listFleetPresets(),
      ctx.crewStore.listReservations(),
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

export async function searchOfficers(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to import wiki data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const officers = await ctx.referenceStore.searchOfficers(query);
  // Fetch reservations if crew store is available
  const reservations = ctx.crewStore ? await ctx.crewStore.listReservations() : [];
  const reservationMap = new Map(reservations.map((r) => [r.officerId, r]));

  const results = officers.slice(0, SEARCH_LIMIT).map((o) => {
    const res = reservationMap.get(o.id);
    return {
      id: o.id,
      name: o.name,
      rarity: o.rarity,
      group: o.groupName,
      officerClass: o.officerClass != null ? OFFICER_CLASS_LABELS[o.officerClass] ?? o.officerClass : null,
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

export async function searchShips(query: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }
  if (!query.trim()) {
    return { error: "Search query is required." };
  }

  const ships = await ctx.referenceStore.searchShips(query);
  const results = ships.slice(0, SEARCH_LIMIT).map((s) => ({
    id: s.id,
    name: s.name,
    shipClass: s.shipClass,
    grade: s.grade,
    rarity: s.rarity,
    faction: s.faction,
    tier: s.tier,
    hullType: s.hullType != null ? HULL_TYPE_LABELS[s.hullType] ?? s.hullType : null,
    maxTier: s.maxTier,
  }));

  return {
    results,
    totalFound: ships.length,
    truncated: ships.length > SEARCH_LIMIT,
  };
}

export async function getOfficerDetail(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const result: Record<string, unknown> = {
    reference: {
      id: officer.id,
      name: officer.name,
      rarity: officer.rarity,
      group: officer.groupName,
      officerClass: officer.officerClass != null ? OFFICER_CLASS_LABELS[officer.officerClass] ?? officer.officerClass : null,
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

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getOfficerOverlay(officerId);
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

export async function getShipDetail(shipId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
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
      hullType: ship.hullType != null ? HULL_TYPE_LABELS[ship.hullType] ?? ship.hullType : null,
      maxTier: ship.maxTier,
      maxLevel: ship.maxLevel,
      buildTimeInSeconds: ship.buildTimeInSeconds,
      officerBonus: ship.officerBonus,
      crewSlots: ship.crewSlots,
      ability: ship.ability,
      source: ship.source,
    },
  };

  // Merge overlay if available
  if (ctx.overlayStore) {
    const overlay = await ctx.overlayStore.getShipOverlay(shipId);
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

export async function listDocks(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
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
          bridge: d.loadout.bridge,
          belowDeckPolicy: d.loadout.belowDeckPolicy
            ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
            : null,
        }
      : null,
  }));

  return { docks: results };
}

export async function getOfficerConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  return {
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
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

export async function validatePlan(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.crewStore.getEffectiveDockState();
  const planItems = await ctx.crewStore.listPlanItems({ active: true });

  const emptyDocks = state.docks.filter((d) => !d.loadout);
  const unassignedPlanItems = planItems.filter((p) => p.dockNumber == null && !p.awayOfficers?.length);

  return {
    valid: state.conflicts.length === 0 && unassignedPlanItems.length === 0,
    officerConflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.length,
    })),
    emptyDocks: emptyDocks.map((d) => d.dockNumber),
    unassignedPlanItems: unassignedPlanItems.map((p) => ({
      planItemId: p.id,
      label: p.label,
    })),
    totalDocks: state.docks.length,
    totalPlanItems: planItems.length,
    totalConflicts: state.conflicts.length,
  };
}

// ─── Phase 2: Crew Composition Implementations ──────────────

export async function listOwnedOfficers(ctx: ToolContext): Promise<object> {
  if (!ctx.overlayStore) {
    return { error: "Overlay system not available. The Admiral may need to set up ownership data first." };
  }
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available. The Admiral may need to sync reference data first." };
  }

  const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });

  // Batch-fetch all reference officers (avoids N+1 per overlay)
  const allOfficers = await ctx.referenceStore.listOfficers();
  const refMap = new Map(allOfficers.map(o => [o.id, o]));

  const officers = overlays.map((overlay) => {
    const ref = refMap.get(overlay.refId);
    if (!ref) return null;
    return {
      id: ref.id,
      name: ref.name,
      rarity: ref.rarity,
      group: ref.groupName,
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

export async function getLoadoutDetail(loadoutId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!loadoutId || isNaN(loadoutId)) {
    return { error: "Valid loadout ID is required." };
  }

  const loadout = await ctx.crewStore.getLoadout(loadoutId);
  if (!loadout) {
    return { error: `Loadout not found: ${loadoutId}` };
  }

  const variants = await ctx.crewStore.listVariants(loadoutId);

  return {
    id: loadout.id,
    name: loadout.name,
    shipId: loadout.shipId,
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

export async function listPlanItems(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const items = await ctx.crewStore.listPlanItems();
  return {
    planItems: items.map((p) => ({
      id: p.id,
      label: p.label,
      intentKey: p.intentKey,
      dockNumber: p.dockNumber,
      loadoutId: p.loadoutId,
      variantId: p.variantId,
      priority: p.priority,
      isActive: p.isActive,
      source: p.source,
      awayOfficers: p.awayOfficers,
    })),
    totalItems: items.length,
  };
}

export async function listIntents(category: string | undefined, _ctx: ToolContext): Promise<object> {
  let intents = SEED_INTENTS;
  if (category) {
    intents = intents.filter((i: SeedIntent) => i.category === category);
  }
  return {
    intents: intents.map((i: SeedIntent) => ({
      key: i.key,
      label: i.label,
      category: i.category,
      description: i.description,
      icon: i.icon,
    })),
    totalIntents: intents.length,
  };
}

export async function findLoadoutsForIntent(intentKey: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!intentKey.trim()) {
    return { error: "Intent key is required." };
  }

  const loadouts = await ctx.crewStore.listLoadouts({ intentKey });
  const detailed = await Promise.all(
    loadouts.map(async (l) => {
      const full = await ctx.crewStore!.getLoadout(l.id);
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
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!shipId.trim()) {
    return { error: "Ship ID is required." };
  }

  const ship = await ctx.referenceStore.getShip(shipId);
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

  const ownedOfficers: Array<Record<string, unknown>> = [];
  if (ctx.overlayStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    for (const overlay of overlays) {
      const ref = refMap.get(overlay.refId);
      if (!ref) continue;
      ownedOfficers.push({
        id: ref.id,
        name: ref.name,
        rarity: ref.rarity,
        group: ref.groupName,
        captainManeuver: ref.captainManeuver,
        officerAbility: ref.officerAbility,
        belowDeckAbility: ref.belowDeckAbility,
        level: overlay.level,
        rank: overlay.rank,
      });
    }
  }

  const existingLoadouts: Array<Record<string, unknown>> = [];
  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts({ shipId });
    const loadoutIds = loadouts.map(l => l.id);
    const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
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

  return {
    ship: {
      id: ship.id,
      name: ship.name,
      shipClass: ship.shipClass,
      grade: ship.grade,
      rarity: ship.rarity,
      faction: ship.faction,
    },
    intent,
    ownedOfficers,
    existingLoadouts,
    totalOwnedOfficers: ownedOfficers.length,
  };
}

export async function analyzeFleet(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const [effectiveState, planItems, loadouts, presets, reservations] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listPlanItems(),
    ctx.crewStore.listLoadouts(),
    ctx.crewStore.listFleetPresets(),
    ctx.crewStore.listReservations(),
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

export async function resolveConflict(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.referenceStore) {
    return { error: "Reference catalog not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  const officer = await ctx.referenceStore.getOfficer(officerId);
  if (!officer) {
    return { error: `Officer not found: ${officerId}` };
  }

  const reservation = await ctx.crewStore.getReservation(officerId);

  const state = await ctx.crewStore.getEffectiveDockState();
  const conflict = state.conflicts.find((c) => c.officerId === officerId) ?? null;

  const alternatives: Array<Record<string, unknown>> = [];
  if (officer.groupName) {
    const groupOfficers = await ctx.referenceStore.listOfficers({ groupName: officer.groupName });
    const altIds = groupOfficers.filter(a => a.id !== officerId).map(a => a.id);
    const overlayMap = new Map<string, boolean>();
    if (ctx.overlayStore && altIds.length > 0) {
      const ownedOverlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
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
        captainManeuver: alt.captainManeuver,
        officerAbility: alt.officerAbility,
        belowDeckAbility: alt.belowDeckAbility,
        owned: overlayMap.get(alt.id) ?? false,
      });
    }
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
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

export async function whatIfRemoveOfficer(officerId: string, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!officerId.trim()) {
    return { error: "Officer ID is required." };
  }

  let officerName: string | null = null;
  if (ctx.referenceStore) {
    const officer = await ctx.referenceStore.getOfficer(officerId);
    officerName = officer?.name ?? null;
  }

  const loadouts = await ctx.crewStore.listLoadouts();
  const loadoutIds = loadouts.map(l => l.id);
  const fullMap = await ctx.crewStore.getLoadoutsByIds(loadoutIds);
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

  const planItems = await ctx.crewStore.listPlanItems();
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

// ─── Target/Goal Tracking Implementations ───────────────────

export async function listTargets(
  targetType: string | undefined,
  status: string | undefined,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }

  const filters: Record<string, unknown> = {};
  if (targetType) filters.targetType = targetType;
  if (status) filters.status = status;
  else filters.status = "active";

  const targets = await ctx.targetStore.list(
    Object.keys(filters).length > 0 ? filters as never : undefined,
  );

  return {
    targets: targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      targetTier: t.targetTier,
      targetRank: t.targetRank,
      targetLevel: t.targetLevel,
      reason: t.reason,
      priority: t.priority,
      status: t.status,
      autoSuggested: t.autoSuggested,
      achievedAt: t.achievedAt,
    })),
    totalTargets: targets.length,
  };
}

export async function suggestTargets(ctx: ToolContext): Promise<object> {
  const result: Record<string, unknown> = {};

  if (ctx.referenceStore) {
    const refCounts = await ctx.referenceStore.counts();
    result.catalogSize = { officers: refCounts.officers, ships: refCounts.ships };
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listOfficerOverlays({ ownershipState: "owned" });
    const allOfficers = await ctx.referenceStore.listOfficers();
    const refMap = new Map(allOfficers.map(o => [o.id, o]));
    result.ownedOfficers = overlays
      .map((overlay) => {
        const ref = refMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          rarity: ref.rarity,
          group: ref.groupName,
          captainManeuver: ref.captainManeuver,
          officerAbility: ref.officerAbility,
          belowDeckAbility: ref.belowDeckAbility,
          level: overlay.level,
          rank: overlay.rank,
        };
      })
      .filter(Boolean);
  }

  if (ctx.overlayStore && ctx.referenceStore) {
    const overlays = await ctx.overlayStore.listShipOverlays({ ownershipState: "owned" });
    const allShips = await ctx.referenceStore.listShips();
    const shipMap = new Map(allShips.map(s => [s.id, s]));
    result.ownedShips = overlays
      .map((overlay) => {
        const ref = shipMap.get(overlay.refId);
        if (!ref) return null;
        return {
          id: ref.id,
          name: ref.name,
          shipClass: ref.shipClass,
          grade: ref.grade,
          rarity: ref.rarity,
          faction: ref.faction,
          tier: overlay.tier ?? ref.tier,
          level: overlay.level,
        };
      })
      .filter(Boolean);
  }

  if (ctx.crewStore) {
    const loadouts = await ctx.crewStore.listLoadouts();
    result.loadouts = loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      shipId: l.shipId,
      intentKeys: l.intentKeys,
    }));
  }

  if (ctx.targetStore) {
    const targets = await ctx.targetStore.list({ status: "active" } as never);
    result.existingTargets = targets.map((t) => ({
      id: t.id,
      targetType: t.targetType,
      refId: t.refId,
      loadoutId: t.loadoutId,
      reason: t.reason,
      priority: t.priority,
    }));
  }

  if (ctx.crewStore) {
    const state = await ctx.crewStore.getEffectiveDockState();
    result.officerConflicts = state.conflicts.map((c) => ({
      officerId: c.officerId,
      locationCount: c.locations.length,
    }));
  }

  if (ctx.overlayStore) {
    const targetedOfficers = await ctx.overlayStore.listOfficerOverlays({ target: true });
    const targetedShips = await ctx.overlayStore.listShipOverlays({ target: true });
    result.overlayTargets = {
      officers: targetedOfficers.length,
      ships: targetedShips.length,
    };
  }

  return result;
}

export async function detectConflicts(ctx: ToolContext): Promise<object> {
  if (!ctx.targetStore) {
    return { error: "Target system not available." };
  }
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const conflicts = await detectTargetConflicts(ctx.targetStore, ctx.crewStore);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const c of conflicts) {
    byType[c.conflictType] = (byType[c.conflictType] ?? 0) + 1;
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
  }

  return {
    conflicts: conflicts.map((c) => ({
      conflictType: c.conflictType,
      severity: c.severity,
      resource: c.resource,
      description: c.description,
      suggestion: c.suggestion,
      targetA: c.targetA,
      targetB: c.targetB,
    })),
    summary: {
      totalConflicts: conflicts.length,
      byType,
      bySeverity,
    },
  };
}
