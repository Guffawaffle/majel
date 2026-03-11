/**
 * fleet-tools/mutate-tools-crew.ts — Crew composition mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Bridge cores, loadouts, presets, reservations, variants, effective state.
 * Extracted from mutate-tools.ts (#193).
 */

import type { BridgeSlot, VariantPatch } from "../../types/crew-types.js";
import type { ToolEnv } from "./declarations.js";
import { str, validName, validNotes } from "./mutate-tools-helpers.js";

// ─── Bridge Core ────────────────────────────────────────────

export async function createBridgeCoreTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "create_bridge_core", error: "Crew system not available." };
  }

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_bridge_core", ...name };

  const captain = str(args, "captain");
  const bridge1 = str(args, "bridge_1");
  const bridge2 = str(args, "bridge_2");

  if (!captain || !bridge1 || !bridge2) {
    return {
      tool: "create_bridge_core",
      error: "All three bridge slots are required: captain, bridge_1, bridge_2.",
      input: { captain: captain || null, bridge_1: bridge1 || null, bridge_2: bridge2 || null },
    };
  }

  const notes = validNotes(args);
  const members: Array<{ officerId: string; slot: BridgeSlot }> = [
    { officerId: captain, slot: "captain" },
    { officerId: bridge1, slot: "bridge_1" },
    { officerId: bridge2, slot: "bridge_2" },
  ];

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingCores = await ctx.deps.crewStore.listBridgeCores();

  // Check name match
  const nameMatch = existingCores.find(
    (c) => c.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_bridge_core",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingMembers: nameMatch.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
      message: `A bridge core named "${nameMatch.name}" already exists (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing bridge core ID ${nameMatch.id} in create_loadout.`,
        "Choose a different name to create a new bridge core.",
      ],
    };
  }

  // Check member-set match (same 3 officers regardless of slot/name)
  const requestedOfficers = [captain, bridge1, bridge2].sort();
  const memberMatch = existingCores.find((c) => {
    const existing = c.members.map((m) => m.officerId).sort();
    return existing.length === 3 &&
      existing[0] === requestedOfficers[0] &&
      existing[1] === requestedOfficers[1] &&
      existing[2] === requestedOfficers[2];
  });
  if (memberMatch) {
    return {
      tool: "create_bridge_core",
      status: "duplicate_detected",
      existingId: memberMatch.id,
      existingName: memberMatch.name,
      existingMembers: memberMatch.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
      message: `A bridge core with the same three officers already exists: "${memberMatch.name}" (ID ${memberMatch.id}).`,
      nextSteps: [
        `Use the existing bridge core ID ${memberMatch.id} in create_loadout.`,
        "Create with a different officer combination if this isn't the right crew.",
      ],
    };
  }

  const core = await ctx.deps.crewStore.createBridgeCore(name, members, notes);
  return {
    tool: "create_bridge_core",
    created: true,
    bridgeCore: {
      id: core.id,
      name: core.name,
      members: core.members.map((m) => ({ officerId: m.officerId, slot: m.slot })),
    },
    nextSteps: [
      "Use create_loadout to assign this bridge core to a ship loadout.",
      "Use get_officer_conflicts to verify no officers are double-booked.",
    ],
  };
}

// ─── Loadout ────────────────────────────────────────────────

export async function createLoadoutTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "create_loadout", error: "Crew system not available." };
  }

  const shipId = str(args, "ship_id");
  if (!shipId) return { tool: "create_loadout", error: "Ship ID is required.", input: { ship_id: null } };

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_loadout", ...name };

  const fields: {
    shipId: string; name: string; bridgeCoreId?: number; belowDeckPolicyId?: number;
    intentKeys?: string[]; notes?: string;
  } = { shipId, name };

  if (args.bridge_core_id != null) fields.bridgeCoreId = Number(args.bridge_core_id);
  if (args.below_deck_policy_id != null) fields.belowDeckPolicyId = Number(args.below_deck_policy_id);
  if (Array.isArray(args.intent_keys)) {
    fields.intentKeys = (args.intent_keys as string[]).map((k) => String(k).trim()).filter(Boolean);
  }
  fields.notes = validNotes(args);

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingLoadouts = await ctx.deps.crewStore.listLoadouts({ shipId });
  const nameMatch = existingLoadouts.find(
    (l) => l.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_loadout",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingShipId: nameMatch.shipId,
      message: `A loadout named "${nameMatch.name}" already exists for this ship (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing loadout ID ${nameMatch.id}.`,
        "Use create_variant to create an alternate configuration on the existing loadout.",
        "Choose a different name to create a new loadout.",
      ],
    };
  }

  const loadout = await ctx.deps.crewStore.createLoadout(fields);
  return {
    tool: "create_loadout",
    created: true,
    loadout: {
      id: loadout.id,
      name: loadout.name,
      shipId: loadout.shipId,
    },
    nextSteps: [
      "Use list_plan_items or get_effective_state to see where this loadout fits.",
      "Use create_variant to create alternate crew configurations for this loadout.",
    ],
  };
}

// ─── Preset ─────────────────────────────────────────────────

export async function activatePresetTool(presetId: number, ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "activate_preset", error: "Crew system not available." };
  }
  if (!presetId || isNaN(presetId)) {
    return { tool: "activate_preset", error: "Valid preset ID is required.", input: { preset_id: presetId } };
  }

  const preset = await ctx.deps.crewStore.getFleetPreset(presetId);
  if (!preset) {
    return { tool: "activate_preset", error: `Fleet preset not found with ID ${presetId}.`, input: { preset_id: presetId } };
  }

  // Return a guided action instead of executing directly.
  // Fleet-wide mutations require explicit user confirmation in the UI.
  return {
    tool: "activate_preset",
    guidedAction: true,
    actionType: "activate_preset",
    presetId: preset.id,
    presetName: preset.name,
    slotCount: preset.slots.length,
    message:
      `To activate this preset (${preset.slots.length} dock slots), ` +
      "direct the Admiral to Plan → Fleet Presets tab → click Activate. " +
      "This is a fleet-wide change that deactivates all other presets.",
    uiPath: "/app#plan/presets",
  };
}

// ─── Reservation ────────────────────────────────────────────

export async function setReservationTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "set_reservation", error: "Crew system not available." };
  }

  const officerId = str(args, "officer_id");
  if (!officerId) {
    return { tool: "set_reservation", error: "Officer ID is required.", input: { officer_id: null } };
  }

  const reservedFor = str(args, "reserved_for");

  // Clear reservation if reservedFor is empty
  if (!reservedFor) {
    const deleted = await ctx.deps.crewStore.deleteReservation(officerId);
    return {
      tool: "set_reservation",
      action: "cleared",
      officerId,
      existed: deleted,
      nextSteps: deleted
        ? ["Officer is now available for any crew assignment."]
        : ["No reservation existed for this officer — no change needed."],
    };
  }

  const locked = args.locked === true;
  const notes = validNotes(args);

  const reservation = await ctx.deps.crewStore.setReservation(officerId, reservedFor, locked, notes);
  return {
    tool: "set_reservation",
    action: "set",
    reservation: {
      officerId: reservation.officerId,
      reservedFor: reservation.reservedFor,
      locked: reservation.locked,
    },
    nextSteps: locked
      ? ["This officer is now hard-locked — the solver will skip them entirely."]
      : ["This is a soft reservation — the solver will warn but not block assignment."],
  };
}

// ─── Variant ────────────────────────────────────────────────

export async function createVariantTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "create_variant", error: "Crew system not available." };
  }

  const loadoutId = Number(args.loadout_id);
  if (!loadoutId || isNaN(loadoutId)) {
    return { tool: "create_variant", error: "Valid loadout ID is required.", input: { loadout_id: args.loadout_id ?? null } };
  }

  const name = validName(str(args, "name"), "Name");
  if (typeof name === "object") return { tool: "create_variant", ...name };

  // Build variant patch from optional bridge overrides
  const patch: VariantPatch = {};
  const bridgeOverrides: Partial<Record<BridgeSlot, string>> = {};
  const captain = str(args, "captain");
  const bridge1 = str(args, "bridge_1");
  const bridge2 = str(args, "bridge_2");
  if (captain) bridgeOverrides.captain = captain;
  if (bridge1) bridgeOverrides.bridge_1 = bridge1;
  if (bridge2) bridgeOverrides.bridge_2 = bridge2;
  if (Object.keys(bridgeOverrides).length > 0) patch.bridge = bridgeOverrides;

  const notes = validNotes(args);

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingVariants = await ctx.deps.crewStore.listVariants(loadoutId);
  const nameMatch = existingVariants.find(
    (v) => v.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameMatch) {
    return {
      tool: "create_variant",
      status: "duplicate_detected",
      existingId: nameMatch.id,
      existingName: nameMatch.name,
      existingBaseLoadoutId: nameMatch.baseLoadoutId,
      message: `A variant named "${nameMatch.name}" already exists on this loadout (ID ${nameMatch.id}).`,
      nextSteps: [
        `Use the existing variant ID ${nameMatch.id}.`,
        "Choose a different name to create a new variant.",
      ],
    };
  }

  const variant = await ctx.deps.crewStore.createVariant(loadoutId, name, patch, notes);
  return {
    tool: "create_variant",
    created: true,
    variant: {
      id: variant.id,
      baseLoadoutId: variant.baseLoadoutId,
      name: variant.name,
      patch: variant.patch,
    },
    nextSteps: [
      "Use get_loadout_detail to see how this variant looks against the base loadout.",
      "Use get_officer_conflicts to check for double-booked officers.",
    ],
  };
}

// ─── Effective State ────────────────────────────────────────

export async function getEffectiveStateTool(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "get_effective_state", error: "Crew system not available." };
  }

  const [state, presets] = await Promise.all([
    ctx.deps.crewStore.getEffectiveDockState(),
    ctx.deps.crewStore.listFleetPresets(),
  ]);

  const activePreset = presets.find((p) => p.isActive);
  const occupiedDocks = state.docks.filter((d) => d.loadout != null).length;

  return {
    tool: "get_effective_state",
    summary: {
      totalDocks: state.docks.length,
      occupiedDocks,
      emptyDocks: state.docks.length - occupiedDocks,
      awayTeams: state.awayTeams.length,
      conflicts: state.conflicts.length,
    },
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
  };
}
