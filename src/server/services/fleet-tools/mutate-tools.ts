/**
 * fleet-tools/mutate-tools.ts — Mutation Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * ADR-025 mutation tools. These modify fleet state (bridge cores, loadouts,
 * presets, reservations, variants). Some require explicit user confirmation
 * via guided actions.
 */

import type { BridgeSlot, VariantPatch } from "../../types/crew-types.js";
import type { ToolContext } from "./declarations.js";

export async function createBridgeCoreTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const name = String(args.name ?? "").trim();
  const captain = String(args.captain ?? "").trim();
  const bridge1 = String(args.bridge_1 ?? "").trim();
  const bridge2 = String(args.bridge_2 ?? "").trim();
  const notes = args.notes ? String(args.notes).trim() : undefined;

  if (!name) return { error: "Name is required." };
  if (!captain || !bridge1 || !bridge2) return { error: "All three bridge slots are required: captain, bridge_1, bridge_2." };

  const members: Array<{ officerId: string; slot: BridgeSlot }> = [
    { officerId: captain, slot: "captain" },
    { officerId: bridge1, slot: "bridge_1" },
    { officerId: bridge2, slot: "bridge_2" },
  ];

  const core = await ctx.crewStore.createBridgeCore(name, members, notes);
  return {
    created: true,
    bridgeCore: {
      id: core.id,
      name: core.name,
      members: core.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
    },
  };
}

export async function createLoadoutTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const shipId = String(args.ship_id ?? "").trim();
  const name = String(args.name ?? "").trim();
  if (!shipId) return { error: "Ship ID is required." };
  if (!name) return { error: "Name is required." };

  const fields: {
    shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
    intentKeys?: string[]; notes?: string;
  } = { shipId, name };

  if (args.bridge_core_id != null) fields.bridgeCoreId = Number(args.bridge_core_id);
  if (args.below_deck_policy_id != null) fields.belowDeckPolicyId = Number(args.below_deck_policy_id);
  if (args.intent_keys) fields.intentKeys = String(args.intent_keys).split(",").map((k) => k.trim()).filter(Boolean);
  if (args.notes) fields.notes = String(args.notes).trim();

  const loadout = await ctx.crewStore.createLoadout(fields);
  return {
    created: true,
    loadout: {
      id: loadout.id,
      name: loadout.name,
      shipId: loadout.shipId,
    },
  };
}

export async function activatePresetTool(presetId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  if (!presetId || isNaN(presetId)) {
    return { error: "Valid preset ID is required." };
  }

  const preset = await ctx.crewStore.getFleetPreset(presetId);
  if (!preset) {
    return { error: `Fleet preset not found: ${presetId}` };
  }

  // Return a guided action instead of executing directly.
  // Fleet-wide mutations require explicit user confirmation in the UI.
  return {
    guidedAction: true,
    actionType: "activate_preset",
    presetId: preset.id,
    presetName: preset.name,
    slotCount: preset.slots.length,
    message: `To activate the "${preset.name}" preset (${preset.slots.length} slots), use the Fleet Ops view → Presets tab → click "Activate" on this preset. This is a fleet-wide change that deactivates all other presets.`,
    uiPath: "/app#fleet-ops/presets",
  };
}

export async function setReservationTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const officerId = String(args.officer_id ?? "").trim();
  const reservedFor = String(args.reserved_for ?? "").trim();
  if (!officerId) return { error: "Officer ID is required." };

  // Clear reservation if reservedFor is empty
  if (!reservedFor) {
    const deleted = await ctx.crewStore.deleteReservation(officerId);
    return {
      cleared: true,
      officerId,
      existed: deleted,
    };
  }

  const locked = String(args.locked ?? "false").toLowerCase() === "true";
  const notes = args.notes ? String(args.notes).trim() : undefined;

  const reservation = await ctx.crewStore.setReservation(officerId, reservedFor, locked, notes);
  return {
    set: true,
    reservation: {
      officerId: reservation.officerId,
      reservedFor: reservation.reservedFor,
      locked: reservation.locked,
    },
  };
}

export async function createVariantTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }
  const loadoutId = Number(args.loadout_id);
  const name = String(args.name ?? "").trim();
  if (!loadoutId || isNaN(loadoutId)) return { error: "Valid loadout ID is required." };
  if (!name) return { error: "Name is required." };

  // Build variant patch from optional bridge overrides
  const patch: VariantPatch = {};
  const bridgeOverrides: Partial<Record<BridgeSlot, string>> = {};
  if (args.captain) bridgeOverrides.captain = String(args.captain).trim();
  if (args.bridge_1) bridgeOverrides.bridge_1 = String(args.bridge_1).trim();
  if (args.bridge_2) bridgeOverrides.bridge_2 = String(args.bridge_2).trim();
  if (Object.keys(bridgeOverrides).length > 0) patch.bridge = bridgeOverrides;

  const notes = args.notes ? String(args.notes).trim() : undefined;

  const variant = await ctx.crewStore.createVariant(loadoutId, name, patch, notes);
  return {
    created: true,
    variant: {
      id: variant.id,
      baseLoadoutId: variant.baseLoadoutId,
      name: variant.name,
      patch: variant.patch,
    },
  };
}

export async function getEffectiveStateTool(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { error: "Crew system not available." };
  }

  const [state, presets] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listFleetPresets(),
  ]);

  const activePreset = presets.find((p) => p.isActive);

  return {
    activePreset: activePreset ? { id: activePreset.id, name: activePreset.name } : null,
    docks: state.docks.map((d) => ({
      dockNumber: d.dockNumber,
      source: d.source,
      intentKeys: d.intentKeys,
      variantPatch: d.variantPatch,
      loadout: d.loadout
        ? {
            loadoutId: d.loadout.loadoutId,
            name: d.loadout.name,
            shipId: d.loadout.shipId,
            bridge: d.loadout.bridge,
            belowDeckPolicy: d.loadout.belowDeckPolicy
              ? { name: d.loadout.belowDeckPolicy.name, mode: d.loadout.belowDeckPolicy.mode }
              : null,
          }
        : null,
    })),
    awayTeams: state.awayTeams.map((a) => ({
      label: a.label,
      officers: a.officers,
      source: a.source,
    })),
    conflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      locations: c.locations.map((loc) => ({
        type: loc.type,
        entityName: loc.entityName,
        slot: loc.slot,
      })),
    })),
    totalDocks: state.docks.length,
    totalConflicts: state.conflicts.length,
  };
}
