/**
 * effect-context.ts — Shared helpers for building TargetContext + SlotContext
 *
 * Used by both crew-recommender.ts and crew-validator.ts to avoid duplication.
 */

import type { BridgeSlot } from "./types.js";
import type { TargetContext, SlotContext, ShipClass } from "./types/effect-types.js";

/**
 * Build a TargetContext from an intent's default context plus user overrides.
 */
export function buildTargetContext(
  intent: { defaultContext: TargetContext } | undefined,
  shipClass?: string | null,
  targetClass?: string | null,
): TargetContext {
  const dc = intent?.defaultContext;
  const ctx: TargetContext = {
    targetKind: dc?.targetKind ?? "hostile",
    engagement: dc?.engagement ?? "any",
    targetTags: [...(dc?.targetTags ?? [])],
  };

  if (shipClass) {
    ctx.shipContext = { shipClass: shipClass as ShipClass };
  }

  if (targetClass && targetClass !== "any") {
    ctx.targetTags.push(`target_${targetClass}`);
  }

  return ctx;
}

/**
 * Map a BridgeSlot to a SlotContext for the evaluator.
 */
export function bridgeSlotToSlotContext(slot: BridgeSlot): SlotContext {
  return slot === "captain" ? "captain" : "bridge";
}
