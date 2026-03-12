/**
 * read-tools-planning.ts — Plan validation, plan items, and intent listing
 */

import type { ToolEnv } from "./declarations.js";
import { SEED_INTENTS, type SeedIntent } from "../../types/crew-types.js";
import { buildOfficerNameMap } from "./read-tools-formatting.js";

export async function validatePlan(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const state = await ctx.deps.crewStore.getEffectiveDockState();
  const planItems = await ctx.deps.crewStore.listPlanItems({ active: true });
  const officerNames = await buildOfficerNameMap(state.conflicts.map((conflict) => conflict.officerId), ctx);

  const emptyDocks = state.docks.filter((d) => !d.loadout);
  const unassignedPlanItems = planItems.filter((p) => p.dockNumber == null && !p.awayOfficers?.length);

  return {
    valid: state.conflicts.length === 0 && unassignedPlanItems.length === 0,
    officerConflicts: state.conflicts.map((c) => ({
      officerId: c.officerId,
      officerName: officerNames.get(c.officerId) ?? null,
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

export async function listPlanItems(ctx: ToolEnv): Promise<object> {
  if (!ctx.deps.crewStore) {
    return { error: "Crew system not available." };
  }

  const items = await ctx.deps.crewStore.listPlanItems();
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

export async function listIntents(category: string | undefined, _ctx: ToolEnv): Promise<object> {
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
