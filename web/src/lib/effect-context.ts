/**
 * effect-context.ts — Shared helpers for building TargetContext + SlotContext
 *
 * Used by both crew-recommender.ts and crew-validator.ts to avoid duplication.
 */

import type { BridgeSlot } from "./types.js";
import type {
  TargetContext,
  SlotContext,
  ShipClass,
  Engagement,
  TargetKind,
} from "./types/effect-types.js";

export interface TargetContextOverrides {
  shipClass?: string | null;
  targetClass?: string | null;
  engagement?: Engagement | "auto";
  targetKind?: TargetKind | "auto";
  modeTag?: "auto" | "pve" | "pvp";
  extraTargetTags?: string[];
}

/**
 * Build a TargetContext from an intent's default context plus user overrides.
 */
export function buildTargetContext(
  intent: { defaultContext: TargetContext },
  overrides: TargetContextOverrides = {},
): TargetContext {
  const dc = intent.defaultContext;
  const tags = [...dc.targetTags];

  if (overrides.modeTag === "pve" || overrides.modeTag === "pvp") {
    if (!tags.includes(overrides.modeTag)) {
      tags.push(overrides.modeTag);
    }
  }

  if (overrides.extraTargetTags?.length) {
    for (const tag of overrides.extraTargetTags) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }

  const ctx: TargetContext = {
    targetKind: (overrides.targetKind && overrides.targetKind !== "auto"
      ? overrides.targetKind
      : dc.targetKind) as TargetKind,
    engagement: (overrides.engagement && overrides.engagement !== "auto"
      ? overrides.engagement
      : dc.engagement) as Engagement,
    targetTags: tags,
  };

  if (dc.shipContext?.shipClass) {
    ctx.shipContext = {
      shipClass: dc.shipContext.shipClass,
      shipId: dc.shipContext.shipId,
      shipTags: dc.shipContext.shipTags ? [...dc.shipContext.shipTags] : undefined,
    };
  }

  if (overrides.shipClass) {
    ctx.shipContext = { shipClass: overrides.shipClass as ShipClass };
  }

  if (overrides.targetClass && overrides.targetClass !== "any") {
    ctx.targetTags.push(`target_${overrides.targetClass}`);
  }

  return ctx;
}

/**
 * Map a BridgeSlot to a SlotContext for the evaluator.
 */
export function bridgeSlotToSlotContext(slot: BridgeSlot): SlotContext {
  return slot === "captain" ? "captain" : "bridge";
}
