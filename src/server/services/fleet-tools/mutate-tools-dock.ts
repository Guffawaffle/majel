/**
 * fleet-tools/mutate-tools-dock.ts — Dock assignment mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * State-machine dock management: assign, update, remove.
 * Dock ↔ plan-item lifecycle with deactivation semantics.
 * Extracted from mutate-tools.ts (#193).
 */

import type { ToolEnv } from "./declarations.js";
import { str, validNotes } from "./mutate-tools-helpers.js";

// ─── Assign Dock ────────────────────────────────────────────

export async function assignDockTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "assign_dock", error: "Crew system not available." };
  }

  const dockNumber = args.dock_number != null ? Number(args.dock_number) : NaN;
  if (!Number.isInteger(dockNumber) || dockNumber < 1) {
    return {
      tool: "assign_dock",
      error: "dock_number must be a positive integer (e.g. 1, 2, 3).",
      input: { dock_number: args.dock_number ?? null },
    };
  }

  const loadoutId = args.loadout_id != null ? Number(args.loadout_id) : undefined;
  const variantId = args.variant_id != null ? Number(args.variant_id) : undefined;

  if (!loadoutId && !variantId) {
    return {
      tool: "assign_dock",
      error: "At least one of loadout_id or variant_id is required.",
      input: { loadout_id: null, variant_id: null },
    };
  }

  const label = str(args, "label") || undefined;
  const notes = validNotes(args);

  // Ensure the dock slot exists
  await ctx.deps.crewStore.upsertDock(dockNumber, {
    label: label ?? `Dock ${dockNumber}`,
    unlocked: true,
  });

  // Deactivate any existing plan items for this dock
  const existingItems = await ctx.deps.crewStore.listPlanItems({ dockNumber, active: true });
  for (const item of existingItems) {
    await ctx.deps.crewStore.updatePlanItem(item.id, { isActive: false });
  }

  // Create the new plan item
  const planItem = await ctx.deps.crewStore.createPlanItem({
    dockNumber,
    loadoutId,
    variantId,
    source: "manual",
    label: label ?? `Dock ${dockNumber} assignment`,
    isActive: true,
    notes,
  });

  return {
    tool: "assign_dock",
    created: true,
    planItem: {
      id: planItem.id,
      dockNumber: planItem.dockNumber,
      loadoutId: planItem.loadoutId,
      variantId: planItem.variantId,
      label: planItem.label,
    },
    nextSteps: [
      "Use get_effective_state to verify the full dock configuration.",
      "Use validate_plan to check for officer conflicts.",
    ],
  };
}

// ─── Update Dock ────────────────────────────────────────────

export async function updateDockTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "update_dock", error: "Crew system not available." };
  }

  const planItemId = args.plan_item_id != null ? Number(args.plan_item_id) : NaN;
  if (!Number.isInteger(planItemId) || planItemId < 1) {
    return {
      tool: "update_dock",
      error: "plan_item_id is required and must be a positive integer.",
      input: { plan_item_id: args.plan_item_id ?? null },
    };
  }

  const existing = await ctx.deps.crewStore.getPlanItem(planItemId);
  if (!existing) {
    return {
      tool: "update_dock",
      error: `Plan item ${planItemId} not found.`,
      input: { plan_item_id: planItemId },
    };
  }

  const fields: Record<string, unknown> = {};
  if (args.loadout_id != null) fields.loadoutId = Number(args.loadout_id);
  if (args.variant_id != null) fields.variantId = Number(args.variant_id);
  if (args.dock_number != null) fields.dockNumber = Number(args.dock_number);
  if (args.label != null) fields.label = str(args, "label");
  if (args.is_active != null) fields.isActive = Boolean(args.is_active);
  fields.notes = validNotes(args);

  const updated = await ctx.deps.crewStore.updatePlanItem(planItemId, fields);
  if (!updated) {
    return { tool: "update_dock", error: `Failed to update plan item ${planItemId}.` };
  }

  return {
    tool: "update_dock",
    updated: true,
    planItem: {
      id: updated.id,
      dockNumber: updated.dockNumber,
      loadoutId: updated.loadoutId,
      variantId: updated.variantId,
      label: updated.label,
      isActive: updated.isActive,
    },
    nextSteps: [
      "Use get_effective_state to verify the updated dock configuration.",
    ],
  };
}

// ─── Remove Dock Assignment ─────────────────────────────────

export async function removeDockAssignmentTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { tool: "remove_dock_assignment", error: "Crew system not available." };
  }

  const dockNumber = args.dock_number != null ? Number(args.dock_number) : NaN;
  if (!Number.isInteger(dockNumber) || dockNumber < 1) {
    return {
      tool: "remove_dock_assignment",
      error: "dock_number must be a positive integer.",
      input: { dock_number: args.dock_number ?? null },
    };
  }

  // Deactivate all active plan items for this dock
  const items = await ctx.deps.crewStore.listPlanItems({ dockNumber, active: true });
  if (items.length === 0) {
    return {
      tool: "remove_dock_assignment",
      removed: false,
      message: `Dock ${dockNumber} has no active assignments to remove.`,
    };
  }

  for (const item of items) {
    await ctx.deps.crewStore.updatePlanItem(item.id, { isActive: false });
  }

  return {
    tool: "remove_dock_assignment",
    removed: true,
    dockNumber,
    deactivatedCount: items.length,
    nextSteps: [
      "Use get_effective_state to verify the dock is now empty.",
      "Use assign_dock to assign a new loadout to this dock.",
    ],
  };
}
