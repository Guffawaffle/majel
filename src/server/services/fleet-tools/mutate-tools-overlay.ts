/**
 * fleet-tools/mutate-tools-overlay.ts — Overlay & inventory mutation tools
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Simple property setters: set_ship_overlay, set_officer_overlay, update_inventory.
 * All trust:auto — no confirmation required.
 * Extracted from mutate-tools.ts (#193).
 */

import type { ToolEnv } from "./declarations.js";
import type { OwnershipState, SetShipOverlayInput, SetOfficerOverlayInput } from "../../stores/overlay-store.js";
import { VALID_OWNERSHIP_STATES } from "../../stores/overlay-store.js";
import { str, MAX_NAME_LEN, MAX_NOTES_LEN } from "./mutate-tools-helpers.js";

// ─── Set Ship Overlay ───────────────────────────────────────

export async function setShipOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.overlayStore) {
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
  if (args.power != null) input.power = Math.max(1, Number(args.power));
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.deps.overlayStore.setShipOverlay(input);

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

// ─── Set Officer Overlay ────────────────────────────────────

export async function setOfficerOverlayTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.overlayStore) {
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
  if (args.power != null) input.power = Math.max(1, Number(args.power));
  if (args.target != null) input.target = Boolean(args.target);
  if (args.target_note != null) input.targetNote = str(args, "target_note").slice(0, MAX_NOTES_LEN);

  const overlay = await ctx.deps.overlayStore.setOfficerOverlay(input);

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

// ─── Update Inventory ───────────────────────────────────────

export async function updateInventoryTool(
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  if (!ctx.deps.inventoryStore) {
    return { tool: "update_inventory", error: "Inventory store not available." };
  }

  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return {
      tool: "update_inventory",
      error: "items array is required and must contain at least one item.",
      input: { items: rawItems },
    };
  }

  const VALID_CATEGORIES = ["ore", "gas", "crystal", "parts", "currency", "blueprint", "other"];
  const validatedItems: Array<{ category: string; name: string; grade: string | null; quantity: number; unit: string | null }> = [];
  const errors: string[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i] as Record<string, unknown>;
    const category = String(item.category ?? "").trim().toLowerCase();
    const name = String(item.name ?? "").trim();
    const grade = item.grade != null ? String(item.grade).trim() : null;
    const quantity = Number(item.quantity ?? 0);

    if (!VALID_CATEGORIES.includes(category)) {
      errors.push(`Item ${i}: invalid category '${category}'. Must be one of: ${VALID_CATEGORIES.join(", ")}`);
      continue;
    }
    if (!name) {
      errors.push(`Item ${i}: name is required.`);
      continue;
    }
    if (name.length > MAX_NAME_LEN) {
      errors.push(`Item ${i}: name must be ${MAX_NAME_LEN} characters or fewer.`);
      continue;
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      errors.push(`Item ${i}: quantity must be a non-negative number.`);
      continue;
    }

    validatedItems.push({ category, name, grade, quantity, unit: null });
  }

  if (validatedItems.length === 0) {
    return {
      tool: "update_inventory",
      error: "No valid items to record.",
      validationErrors: errors,
      input: { items: rawItems },
    };
  }

  const source = str(args, "source") || "chat";
  const result = await ctx.deps.inventoryStore.upsertItems({
    source,
    capturedAt: new Date().toISOString(),
    items: validatedItems.map(v => ({
      category: v.category as import("../../stores/inventory-store.js").InventoryCategory,
      name: v.name,
      grade: v.grade,
      quantity: v.quantity,
      unit: v.unit,
    })),
  });

  return {
    tool: "update_inventory",
    recorded: true,
    upserted: result.upserted,
    categories: result.categories,
    items: validatedItems.map(v => ({ category: v.category, name: v.name, grade: v.grade, quantity: v.quantity })),
    ...(errors.length > 0 ? { warnings: errors } : {}),
    nextSteps: [
      "Use list_inventory to verify the recorded inventory.",
      "Use calculate_upgrade_path to check resource gaps for a specific ship upgrade.",
    ],
  };
}
