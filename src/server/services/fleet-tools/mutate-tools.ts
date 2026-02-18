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
import type { TargetStatus, TargetType, UpdateTargetInput } from "../../stores/target-store.js";
import { VALID_TARGET_TYPES, VALID_TARGET_STATUSES } from "../../stores/target-store.js";
import type { OwnershipState, SetShipOverlayInput, SetOfficerOverlayInput } from "../../stores/overlay-store.js";
import { VALID_OWNERSHIP_STATES } from "../../stores/overlay-store.js";

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

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingCores = await ctx.crewStore.listBridgeCores();

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

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingLoadouts = await ctx.crewStore.listLoadouts({ shipId });
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
      "direct the Admiral to Plan → Fleet Presets tab → click Activate. " +
      "This is a fleet-wide change that deactivates all other presets.",
    uiPath: "/app#plan/presets",
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

  // ─── Dupe detection (#81) ───────────────────────────────
  const existingVariants = await ctx.crewStore.listVariants(loadoutId);
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

// ─── Target Mutation Tools (#80) ────────────────────────────

export async function createTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "create_target", error: "Target system not available." };
  }

  const targetType = str(args, "target_type") as TargetType;
  if (!targetType || !VALID_TARGET_TYPES.includes(targetType)) {
    return {
      tool: "create_target",
      error: `Invalid target_type. Must be one of: ${VALID_TARGET_TYPES.join(", ")}.`,
      input: { target_type: targetType || null },
    };
  }

  const refId = str(args, "ref_id") || null;
  const loadoutId = args.loadout_id != null ? Number(args.loadout_id) : null;

  // officer/ship targets should have a ref_id; crew targets should have a loadout_id
  if ((targetType === "officer" || targetType === "ship") && !refId) {
    return {
      tool: "create_target",
      error: `ref_id is required for ${targetType} targets.`,
      input: { target_type: targetType, ref_id: null },
    };
  }
  if (targetType === "crew" && !loadoutId && !refId) {
    return {
      tool: "create_target",
      error: "crew targets require either loadout_id or ref_id.",
      input: { target_type: targetType, loadout_id: null, ref_id: null },
    };
  }

  // Dupe detection — check for active targets with the same ref_id
  if (refId) {
    const existing = await ctx.targetStore.listByRef(refId);
    const activeMatch = existing.find((t) => t.status === "active");
    if (activeMatch) {
      return {
        tool: "create_target",
        status: "duplicate_detected",
        existingId: activeMatch.id,
        existingType: activeMatch.targetType,
        existingPriority: activeMatch.priority,
        existingReason: activeMatch.reason,
        message: `An active ${activeMatch.targetType} target for ${refId} already exists (ID ${activeMatch.id}).`,
        nextSteps: [
          `Use update_target to modify the existing target (ID ${activeMatch.id}).`,
          "Use list_targets to see all current targets.",
        ],
      };
    }
  }

  const priority = args.priority != null ? Number(args.priority) : 2;
  if (priority < 1 || priority > 3) {
    return {
      tool: "create_target",
      error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
      input: { priority },
    };
  }

  const reason = str(args, "reason") || null;
  const targetTier = args.target_tier != null ? Number(args.target_tier) : null;
  const targetLevel = args.target_level != null ? Number(args.target_level) : null;
  const targetRank = str(args, "target_rank") || null;

  const target = await ctx.targetStore.create({
    targetType,
    refId,
    loadoutId,
    priority,
    reason: reason ? reason.slice(0, MAX_NOTES_LEN) : null,
    targetTier,
    targetLevel,
    targetRank,
  });

  return {
    tool: "create_target",
    created: true,
    target: {
      id: target.id,
      targetType: target.targetType,
      refId: target.refId,
      loadoutId: target.loadoutId,
      priority: target.priority,
      reason: target.reason,
      status: target.status,
    },
    nextSteps: [
      "Use list_targets to see all current targets.",
      "Use suggest_targets to get AI-driven acquisition recommendations.",
      "Use complete_target when this goal is achieved.",
    ],
  };
}

export async function updateTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "update_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "update_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "update_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  const fields: UpdateTargetInput = {};
  let hasUpdates = false;

  if (args.priority != null) {
    const p = Number(args.priority);
    if (p < 1 || p > 3) {
      return {
        tool: "update_target",
        error: "Priority must be between 1 and 3 (1 = high, 3 = low).",
        input: { target_id: targetId, priority: args.priority },
      };
    }
    fields.priority = p;
    hasUpdates = true;
  }

  if (args.status != null) {
    const s = str(args, "status") as TargetStatus;
    if (!VALID_TARGET_STATUSES.includes(s)) {
      return {
        tool: "update_target",
        error: `Invalid status. Must be one of: ${VALID_TARGET_STATUSES.join(", ")}.`,
        input: { target_id: targetId, status: s },
      };
    }
    // For "achieved", direct to complete_target which uses markAchieved
    if (s === "achieved") {
      return {
        tool: "update_target",
        error: "To mark a target achieved, use complete_target instead — it records the achievement timestamp.",
        input: { target_id: targetId, status: s },
        nextSteps: [`Call complete_target with target_id ${targetId}.`],
      };
    }
    fields.status = s;
    hasUpdates = true;
  }

  if (args.reason != null) {
    fields.reason = str(args, "reason").slice(0, MAX_NOTES_LEN) || null;
    hasUpdates = true;
  }
  if (args.target_tier != null) {
    fields.targetTier = Number(args.target_tier);
    hasUpdates = true;
  }
  if (args.target_level != null) {
    fields.targetLevel = Number(args.target_level);
    hasUpdates = true;
  }
  if (args.target_rank != null) {
    fields.targetRank = str(args, "target_rank") || null;
    hasUpdates = true;
  }

  if (!hasUpdates) {
    return {
      tool: "update_target",
      error: "No fields to update — provide at least one of: priority, status, reason, target_tier, target_level, target_rank.",
      input: { target_id: targetId },
    };
  }

  const updated = await ctx.targetStore.update(targetId, fields);
  if (!updated) {
    return { tool: "update_target", error: `Failed to update target ${targetId}.` };
  }

  return {
    tool: "update_target",
    updated: true,
    target: {
      id: updated.id,
      targetType: updated.targetType,
      refId: updated.refId,
      priority: updated.priority,
      status: updated.status,
      reason: updated.reason,
    },
    nextSteps: [
      "Use list_targets to see updated target list.",
      updated.status === "abandoned"
        ? "Target has been abandoned — it will no longer appear in active recommendations."
        : "Use complete_target when this goal is achieved.",
    ],
  };
}

export async function completeTargetTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.targetStore) {
    return { tool: "complete_target", error: "Target system not available." };
  }

  const targetId = Number(args.target_id);
  if (!targetId || isNaN(targetId)) {
    return {
      tool: "complete_target",
      error: "Valid target_id is required.",
      input: { target_id: args.target_id ?? null },
    };
  }

  const existing = await ctx.targetStore.get(targetId);
  if (!existing) {
    return {
      tool: "complete_target",
      error: `Target not found with ID ${targetId}.`,
      input: { target_id: targetId },
    };
  }

  if (existing.status === "achieved") {
    return {
      tool: "complete_target",
      status: "already_achieved",
      target: {
        id: existing.id,
        targetType: existing.targetType,
        refId: existing.refId,
        achievedAt: existing.achievedAt,
      },
      message: "This target was already marked as achieved.",
    };
  }

  if (existing.status === "abandoned") {
    return {
      tool: "complete_target",
      error: "Cannot complete an abandoned target. Use update_target to reactivate it first (set status to 'active').",
      input: { target_id: targetId },
    };
  }

  const achieved = await ctx.targetStore.markAchieved(targetId);
  if (!achieved) {
    return { tool: "complete_target", error: `Failed to mark target ${targetId} as achieved.` };
  }

  return {
    tool: "complete_target",
    completed: true,
    target: {
      id: achieved.id,
      targetType: achieved.targetType,
      refId: achieved.refId,
      priority: achieved.priority,
      reason: achieved.reason,
      status: achieved.status,
      achievedAt: achieved.achievedAt,
    },
    nextSteps: [
      "Use suggest_targets for new acquisition recommendations.",
      "Use list_targets with status 'achieved' to review accomplishments.",
    ],
  };
}

// ─── Overlay Mutation Tools ─────────────────────────────────

/**
 * Set or update a ship's personal overlay: ownership state, current tier/level/power.
 * This lets the Admiral record their actual in-game ship progression.
 */
export async function setShipOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.overlayStore) {
    return { tool: "set_ship_overlay", error: "Overlay store not available." };
  }

  const shipId = str(args, "ship_id");
  if (!shipId) {
    return { tool: "set_ship_overlay", error: "ship_id is required.", input: args };
  }

  if (args.ownership_state != null && !VALID_OWNERSHIP_STATES.includes(args.ownership_state as OwnershipState)) {
    return {
      tool: "set_ship_overlay",
      error: `Invalid ownership_state. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`,
      input: { ownership_state: args.ownership_state },
    };
  }

  const input: SetShipOverlayInput = { refId: shipId };
  if (args.ownership_state != null) input.ownershipState = args.ownership_state as OwnershipState;
  if (args.tier != null) input.tier = Number(args.tier);
  if (args.level != null) input.level = Number(args.level);
  if (args.power != null) input.power = Number(args.power);
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.overlayStore.setShipOverlay(input);

  return {
    tool: "set_ship_overlay",
    updated: true,
    shipId,
    overlay: {
      ownershipState: overlay.ownershipState,
      tier: overlay.tier,
      level: overlay.level,
      power: overlay.power,
      target: overlay.target,
      targetNote: overlay.targetNote,
    },
    nextSteps: ["Use get_ship_detail to see the full ship record with updated overlay."],
  };
}

/**
 * Set or update an officer's personal overlay: ownership state, current level/rank/power.
 * This lets the Admiral record their actual in-game officer progression.
 */
export async function setOfficerOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  if (!ctx.overlayStore) {
    return { tool: "set_officer_overlay", error: "Overlay store not available." };
  }

  const officerId = str(args, "officer_id");
  if (!officerId) {
    return { tool: "set_officer_overlay", error: "officer_id is required.", input: args };
  }

  if (args.ownership_state != null && !VALID_OWNERSHIP_STATES.includes(args.ownership_state as OwnershipState)) {
    return {
      tool: "set_officer_overlay",
      error: `Invalid ownership_state. Must be one of: ${VALID_OWNERSHIP_STATES.join(", ")}`,
      input: { ownership_state: args.ownership_state },
    };
  }

  const input: SetOfficerOverlayInput = { refId: officerId };
  if (args.ownership_state != null) input.ownershipState = args.ownership_state as OwnershipState;
  if (args.level != null) input.level = Number(args.level);
  if (args.rank != null) input.rank = str(args, "rank");
  if (args.power != null) input.power = Number(args.power);
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.overlayStore.setOfficerOverlay(input);

  return {
    tool: "set_officer_overlay",
    updated: true,
    officerId,
    overlay: {
      ownershipState: overlay.ownershipState,
      level: overlay.level,
      rank: overlay.rank,
      power: overlay.power,
      target: overlay.target,
      targetNote: overlay.targetNote,
    },
    nextSteps: ["Use get_officer_detail to see the full officer record with updated overlay."],
  };
}
