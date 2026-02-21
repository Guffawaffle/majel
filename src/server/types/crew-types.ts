/**
 * crew-types.ts — Types for ADR-025 Crew Composition Model
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Covers: BridgeCores, BelowDeckPolicies, Loadouts, Variants,
 *         Docks, FleetPresets, PlanItems, OfficerReservations.
 */

// ─── Intent Catalog ─────────────────────────────────────────

export type IntentCategory = "mining" | "combat" | "utility" | "custom";

export const VALID_INTENT_CATEGORIES: IntentCategory[] = [
  "mining", "combat", "utility", "custom",
];

export interface SeedIntent {
  key: string;
  label: string;
  category: IntentCategory;
  description: string;
  icon: string;
  sortOrder: number;
}

export const SEED_INTENTS: SeedIntent[] = [
  { key: "general", label: "General", category: "utility", description: "General-purpose crew configuration", icon: "⚙️", sortOrder: 0 },
  // Mining
  { key: "mining-gas", label: "Gas Mining", category: "mining", description: "Collecting raw gas from nodes", icon: "⛽", sortOrder: 10 },
  { key: "mining-crystal", label: "Crystal Mining", category: "mining", description: "Collecting raw crystal from nodes", icon: "💎", sortOrder: 11 },
  { key: "mining-ore", label: "Ore Mining", category: "mining", description: "Collecting raw ore from nodes", icon: "⛏️", sortOrder: 12 },
  { key: "mining-tri", label: "Tritanium Mining", category: "mining", description: "Collecting tritanium from refined nodes", icon: "🔩", sortOrder: 13 },
  { key: "mining-dil", label: "Dilithium Mining", category: "mining", description: "Collecting dilithium from refined nodes", icon: "🔮", sortOrder: 14 },
  { key: "mining-para", label: "Parsteel Mining", category: "mining", description: "Collecting parsteel from refined nodes", icon: "🛡️", sortOrder: 15 },
  { key: "mining-lat", label: "Latinum Mining", category: "mining", description: "Collecting latinum from nodes", icon: "💰", sortOrder: 16 },
  { key: "mining-iso", label: "Isogen Mining", category: "mining", description: "Collecting isogen from nodes", icon: "☢️", sortOrder: 17 },
  { key: "mining-data", label: "Data Mining", category: "mining", description: "Collecting data from nodes", icon: "📊", sortOrder: 18 },
  // Combat
  { key: "grinding", label: "Hostile Grinding", category: "combat", description: "Grinding hostile NPCs for dailies and events", icon: "⚔️", sortOrder: 20 },
  { key: "grinding-swarm", label: "Swarm Grinding", category: "combat", description: "Grinding swarm hostiles specifically", icon: "🐝", sortOrder: 21 },
  { key: "grinding-eclipse", label: "Eclipse Grinding", category: "combat", description: "Grinding eclipse hostiles specifically", icon: "🌑", sortOrder: 22 },
  { key: "armada", label: "Armada", category: "combat", description: "Group armada operations", icon: "🎯", sortOrder: 23 },
  { key: "armada-solo", label: "Solo Armada", category: "combat", description: "Solo armada takedowns", icon: "🎯", sortOrder: 24 },
  { key: "pvp", label: "PvP/Raiding", category: "combat", description: "Player vs player combat and raiding", icon: "💀", sortOrder: 25 },
  { key: "base-defense", label: "Base Defense", category: "combat", description: "Defending your starbase", icon: "🏰", sortOrder: 26 },
  // Utility
  { key: "exploration", label: "Exploration", category: "utility", description: "Exploring new systems and sectors", icon: "🔭", sortOrder: 30 },
  { key: "cargo-run", label: "Cargo Run", category: "utility", description: "Transporting cargo between stations", icon: "📦", sortOrder: 31 },
  { key: "events", label: "Events", category: "utility", description: "Special timed event activities", icon: "🎪", sortOrder: 32 },
  { key: "voyages", label: "Voyages", category: "utility", description: "Long-range autonomous voyages", icon: "🚀", sortOrder: 33 },
  { key: "away-team", label: "Away Team", category: "utility", description: "Ground-based away team missions", icon: "🖖", sortOrder: 34 },
];

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
