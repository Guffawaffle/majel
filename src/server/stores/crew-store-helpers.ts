/**
 * crew-store-helpers.ts — Shared query helpers for crew-store domain modules
 *
 * Extracted from crew-store.ts (ADR-025) for #191 store decomposition.
 * Pure functions operating on a QueryExecutor — no closure over scope/userId.
 */

import type { QueryExecutor } from "../request-context.js";
import type {
  BridgeSlot,
  BridgeCore,
  BridgeCoreMember,
  BridgeCoreWithMembers,
  BelowDeckPolicy,
  Loadout,
  FleetPreset,
  FleetPresetSlot,
  FleetPresetWithSlots,
  ResolvedLoadout,
  VariantPatch,
} from "../types/crew-types.js";
import { VALID_BRIDGE_SLOTS } from "../types/crew-types.js";
import { BCM_COLS, BDP_COLS, FPS_COLS, LOADOUT_COLS } from "./crew-store-schema.js";

/** Batch-attach members to an array of bridge cores. */
export async function attachMembers(client: QueryExecutor, cores: BridgeCore[]): Promise<BridgeCoreWithMembers[]> {
  if (cores.length === 0) return [];
  const ids = cores.map((c) => c.id);
  const membersResult = await client.query(
    `SELECT ${BCM_COLS} FROM bridge_core_members WHERE bridge_core_id = ANY($1) ORDER BY slot`,
    [ids],
  );
  const membersByCore = new Map<number, BridgeCoreMember[]>();
  for (const m of membersResult.rows as BridgeCoreMember[]) {
    const arr = membersByCore.get(m.bridgeCoreId) ?? [];
    arr.push(m);
    membersByCore.set(m.bridgeCoreId, arr);
  }
  return cores.map((c) => ({ ...c, members: membersByCore.get(c.id) ?? [] }));
}

/** Batch-attach slots to an array of fleet presets. */
export async function attachSlots(client: QueryExecutor, presets: FleetPreset[]): Promise<FleetPresetWithSlots[]> {
  if (presets.length === 0) return [];
  const ids = presets.map((p) => p.id);
  const slotsResult = await client.query(
    `SELECT ${FPS_COLS} FROM fleet_preset_slots WHERE preset_id = ANY($1) ORDER BY priority`,
    [ids],
  );
  const slotsByPreset = new Map<number, FleetPresetSlot[]>();
  for (const s of slotsResult.rows as FleetPresetSlot[]) {
    const arr = slotsByPreset.get(s.presetId) ?? [];
    arr.push(s);
    slotsByPreset.set(s.presetId, arr);
  }
  return presets.map((p) => ({ ...p, slots: slotsByPreset.get(p.id) ?? [] }));
}

/** Resolve a loadout into a ResolvedLoadout (bridge + BDP + metadata). */
export async function resolveLoadout(client: QueryExecutor, loadoutId: number): Promise<ResolvedLoadout | null> {
  const loadoutResult = await client.query(
    `SELECT ${LOADOUT_COLS} FROM loadouts WHERE id = $1`, [loadoutId],
  );
  const loadout = loadoutResult.rows[0] as Loadout | undefined;
  if (!loadout) return null;

  const bridge = { captain: null as string | null, bridge_1: null as string | null, bridge_2: null as string | null };
  if (loadout.bridgeCoreId) {
    const membersResult = await client.query(
      `SELECT ${BCM_COLS} FROM bridge_core_members WHERE bridge_core_id = $1`,
      [loadout.bridgeCoreId],
    );
    for (const m of membersResult.rows as BridgeCoreMember[]) {
      bridge[m.slot] = m.officerId;
    }
  }

  let belowDeckPolicy: BelowDeckPolicy | null = null;
  if (loadout.belowDeckPolicyId) {
    const bdpResult = await client.query(
      `SELECT ${BDP_COLS} FROM below_deck_policies WHERE id = $1`,
      [loadout.belowDeckPolicyId],
    );
    belowDeckPolicy = (bdpResult.rows[0] as BelowDeckPolicy) ?? null;
  }

  return {
    loadoutId: loadout.id,
    shipId: loadout.shipId,
    name: loadout.name,
    bridge,
    belowDeckPolicy,
    intentKeys: loadout.intentKeys ?? [],
    tags: loadout.tags ?? [],
    notes: loadout.notes,
  };
}

/** Validate a VariantPatch against ADR-025 § Patch Merge Semantics. */
export function validatePatch(patch: VariantPatch): void {
  const allowedKeys = new Set(["bridge", "below_deck_policy_id", "below_deck_patch", "intent_keys"]);
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown patch key: "${key}". Allowed: ${[...allowedKeys].join(", ")}`);
    }
  }

  if (patch.below_deck_policy_id !== undefined && patch.below_deck_patch !== undefined) {
    throw new Error("Patch cannot contain both below_deck_policy_id and below_deck_patch (mutually exclusive)");
  }

  if (patch.bridge) {
    for (const slot of Object.keys(patch.bridge)) {
      if (!VALID_BRIDGE_SLOTS.includes(slot as BridgeSlot)) {
        throw new Error(`Invalid bridge slot: "${slot}". Must be one of: ${VALID_BRIDGE_SLOTS.join(", ")}`);
      }
    }
  }
}
