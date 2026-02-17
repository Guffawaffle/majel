/**
 * fleet-tools/mutate-tools.ts — Mutation Tool Implementations
 *
 * Majel — STFC Fleet Intelligence System
 *
 * ADR-025 mutation tools. These modify fleet state (bridge cores, loadouts,
 * presets, reservations, variants). Some require explicit user confirmation
 * via guided actions.
 *
 * AX design principles:
 * - Every response includes `tool` name for context in multi-turn loops
 * - Success responses include `nextSteps` hints so the model knows what to do next
 * - Error responses echo the invalid `input` so the model can self-correct
 * - Consistent shape: { tool, ...result } on success, { tool, error, input? } on failure
 */

import type { BridgeSlot, VariantPatch } from "../../types/crew-types.js";
import type { ToolContext } from "./declarations.js";

// ─── Helpers ────────────────────────────────────────────────

/** Max length for user-provided name/notes fields. */
const MAX_NAME_LEN = 120;
const MAX_NOTES_LEN = 500;

/** Safely extract and trim a string arg; returns "" if absent. */
function str(args: Record<string, unknown>, key: string): string {
  return String(args[key] ?? "").trim();
}

/** Validate and truncate a name field. Returns the cleaned name or an error string. */
function validName(raw: string, label: string): string | { error: string } {
  if (!raw) return { error: `${label} is required.` };
  if (raw.length > MAX_NAME_LEN)
    return { error: `${label} must be ${MAX_NAME_LEN} characters or fewer (got ${raw.length}).` };
  return raw;
}

/** Validate and truncate optional notes. */
function validNotes(args: Record<string, unknown>): string | undefined {
  const raw = str(args, "notes");
  if (!raw) return undefined;
  return raw.slice(0, MAX_NOTES_LEN);
}

// ─── Mutation Tools ─────────────────────────────────────────

export async function createBridgeCoreTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
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

  const core = await ctx.crewStore.createBridgeCore(name, members, notes);
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

export async function createLoadoutTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
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

  const loadout = await ctx.crewStore.createLoadout(fields);
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

export async function activatePresetTool(presetId: number, ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "activate_preset", error: "Crew system not available." };
  }
  if (!presetId || isNaN(presetId)) {
    return { tool: "activate_preset", error: "Valid preset ID is required.", input: { preset_id: presetId } };
  }

  const preset = await ctx.crewStore.getFleetPreset(presetId);
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
      "direct the Admiral to Fleet Ops → Presets tab → click Activate. " +
      "This is a fleet-wide change that deactivates all other presets.",
    uiPath: "/app#fleet-ops/presets",
  };
}

export async function setReservationTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "set_reservation", error: "Crew system not available." };
  }

  const officerId = str(args, "officer_id");
  if (!officerId) {
    return { tool: "set_reservation", error: "Officer ID is required.", input: { officer_id: null } };
  }

  const reservedFor = str(args, "reserved_for");

  // Clear reservation if reservedFor is empty
  if (!reservedFor) {
    const deleted = await ctx.crewStore.deleteReservation(officerId);
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

  const reservation = await ctx.crewStore.setReservation(officerId, reservedFor, locked, notes);
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

export async function createVariantTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.crewStore) {
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

  const variant = await ctx.crewStore.createVariant(loadoutId, name, patch, notes);
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

export async function getEffectiveStateTool(ctx: ToolContext): Promise<object> {
  if (!ctx.crewStore) {
    return { tool: "get_effective_state", error: "Crew system not available." };
  }

  const [state, presets] = await Promise.all([
    ctx.crewStore.getEffectiveDockState(),
    ctx.crewStore.listFleetPresets(),
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
