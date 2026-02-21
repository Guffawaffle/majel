export type BridgeSlot = "captain" | "bridge_1" | "bridge_2";
export type BelowDeckMode = "stats_then_bda" | "pinned_only" | "stat_fill_only";
export type PlanSource = "manual" | "preset";
export type IntentCategory = "mining" | "combat" | "utility" | "custom";

export interface OfficerReservation {
  officerId: string;
  reservedFor: string;
  locked: boolean;
  notes: string | null;
  createdAt: string;
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

export interface BridgeCoreWithMembers {
  id: number;
  name: string;
  notes: string | null;
  members: Array<{
    id: number;
    bridgeCoreId: number;
    officerId: string;
    slot: "captain" | "bridge_1" | "bridge_2";
  }>;
}

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
  createdAt?: string;
  updatedAt?: string;
}

export interface BelowDeckPolicy {
  id: number;
  name: string;
  mode: BelowDeckMode;
  spec: { pinned?: string[]; prefer_modifiers?: string[]; avoid_reserved?: boolean; max_slots?: number };
  notes: string | null;
}

export interface Dock {
  dockNumber: number;
  label: string | null;
  unlocked: boolean;
  notes: string | null;
}

export interface VariantPatch {
  bridge?: Partial<Record<BridgeSlot, string>>;
  below_deck_policy_id?: number;
  below_deck_patch?: { pinned_add?: string[]; pinned_remove?: string[] };
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

export interface ResolvedLoadout {
  loadoutId: number;
  shipId: string;
  name: string;
  bridge: Record<BridgeSlot, string | null>;
  belowDeckPolicy: BelowDeckPolicy | null;
  intentKeys: string[];
  tags: string[];
  notes: string | null;
}

export interface EffectiveAwayTeam {
  label: string | null;
  officers: string[];
  source: PlanSource;
}

export interface EffectiveDockEntry {
  dockNumber: number;
  loadout: ResolvedLoadout | null;
  variantPatch: VariantPatch | null;
  intentKeys: string[];
  source: PlanSource;
}

export interface EffectiveDockState {
  docks: EffectiveDockEntry[];
  awayTeams: EffectiveAwayTeam[];
  conflicts: OfficerConflict[];
}

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

export interface IntentDef {
  key: string;
  label: string;
  icon: string;
  category: IntentCategory;
}
