/**
 * crew-types.ts — Types for ADR-025 Crew Composition Model
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Covers: BridgeCores, BelowDeckPolicies, Loadouts, Variants,
 *         Docks, FleetPresets, PlanItems, OfficerReservations.
 */

// ─── Bridge Cores ───────────────────────────────────────────

export type BridgeSlot = "captain" | "bridge_1" | "bridge_2";

export const VALID_BRIDGE_SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

export interface BridgeCore {
  id: number;
  name: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeCoreMember {
  id: number;
  bridgeCoreId: number;
  officerId: string;
  slot: BridgeSlot;
}

export interface BridgeCoreWithMembers extends BridgeCore {
  members: BridgeCoreMember[];
}

// ─── Below Deck Policies ────────────────────────────────────

export type BelowDeckMode = "stats_then_bda" | "pinned_only" | "stat_fill_only";

export const VALID_BELOW_DECK_MODES: BelowDeckMode[] = ["stats_then_bda", "pinned_only", "stat_fill_only"];

export interface BelowDeckPolicySpec {
  pinned?: string[];           // canonical officer IDs
  prefer_modifiers?: string[]; // BDA modifier types
  avoid_reserved?: boolean;
  max_slots?: number;
}

export interface BelowDeckPolicy {
  id: number;
  name: string;
  mode: BelowDeckMode;
  specVersion: number;
  spec: BelowDeckPolicySpec;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Loadouts ───────────────────────────────────────────────

export interface Loadout {
  id: number;
  shipId: string;
  bridgeCoreId: number | null;
  belowDeckPolicyId: number | null;
  name: string;
  priority: number;
  isActive: boolean;
  intentKeys: string[];
  tags: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoadoutWithRefs extends Loadout {
  bridgeCore: BridgeCoreWithMembers | null;
  belowDeckPolicy: BelowDeckPolicy | null;
}

// ─── Loadout Variants ───────────────────────────────────────

export interface VariantPatch {
  bridge?: Partial<Record<BridgeSlot, string>>;
  below_deck_policy_id?: number;
  below_deck_patch?: {
    pinned_add?: string[];
    pinned_remove?: string[];
  };
  intent_keys?: string[];
}

export interface LoadoutVariant {
  id: number;
  baseLoadoutId: number;
  name: string;
  patch: VariantPatch;
  notes: string | null;
  createdAt: string;
}

// ─── Docks ──────────────────────────────────────────────────

export interface Dock {
  dockNumber: number;
  label: string | null;
  unlocked: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Fleet Presets ──────────────────────────────────────────

export interface FleetPreset {
  id: number;
  name: string;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetPresetSlot {
  id: number;
  presetId: number;
  dockNumber: number | null;
  loadoutId: number | null;
  variantId: number | null;
  awayOfficers: string[] | null;
  label: string | null;
  priority: number;
  notes: string | null;
}

export interface FleetPresetWithSlots extends FleetPreset {
  slots: FleetPresetSlot[];
}

// ─── Plan Items ─────────────────────────────────────────────

export type PlanSource = "manual" | "preset";

export interface PlanItem {
  id: number;
  intentKey: string | null;
  label: string | null;
  loadoutId: number | null;
  variantId: number | null;
  dockNumber: number | null;
  awayOfficers: string[] | null;
  priority: number;
  isActive: boolean;
  source: PlanSource;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Officer Reservations ───────────────────────────────────

export interface OfficerReservation {
  officerId: string;
  reservedFor: string;
  locked: boolean;
  notes: string | null;
  createdAt: string;
}

// ─── Effective State (D6) ───────────────────────────────────

export interface ResolvedLoadout {
  loadoutId: number;
  shipId: string;
  name: string;
  bridge: {
    captain: string | null;
    bridge_1: string | null;
    bridge_2: string | null;
  };
  belowDeckPolicy: BelowDeckPolicy | null;
  intentKeys: string[];
  tags: string[];
  notes: string | null;
}

export interface OfficerConflict {
  officerId: string;
  locations: Array<{
    type: "bridge" | "plan_item" | "preset_slot";
    entityId: number;
    entityName: string;
    slot?: string;
  }>;
}

export interface EffectiveDockEntry {
  dockNumber: number;
  loadout: ResolvedLoadout | null;
  variantPatch: VariantPatch | null;
  intentKeys: string[];
  source: PlanSource;
}

export interface EffectiveAwayTeam {
  label: string | null;
  officers: string[];
  source: PlanSource;
}

export interface EffectiveDockState {
  docks: EffectiveDockEntry[];
  awayTeams: EffectiveAwayTeam[];
  conflicts: OfficerConflict[];
}
