/**
 * loadout-types.ts — Loadout Architecture Type Definitions & Seed Data (ADR-022)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * All interfaces, type unions, and seed intent catalog for the
 * loadout-first fleet management system.
 *
 * Replaces dock-types.ts (ADR-010).
 */

// ─── Intent Types (carried over from ADR-010) ──────────────────

export interface Intent {
  key: string;
  label: string;
  category: string;
  description: string | null;
  icon: string | null;
  isBuiltin: boolean;
  sortOrder: number;
  createdAt: string;
}

export type IntentCategory = "mining" | "combat" | "utility" | "custom";

export const VALID_INTENT_CATEGORIES: IntentCategory[] = [
  "mining", "combat", "utility", "custom",
];

// ─── Loadout Types (L2 — primary entity) ────────────────────────

/** A named Ship + Crew configuration. Exists independently of docks or plans. */
export interface Loadout {
  id: number;
  shipId: string;
  name: string;
  priority: number;
  isActive: boolean;
  intentKeys: string[];       // intent_catalog keys this loadout suits
  tags: string[];             // freeform user tags
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  shipName?: string;          // joined from reference_ships
}

/** An officer assigned to a loadout. */
export interface LoadoutMember {
  id: number;
  loadoutId: number;
  officerId: string;
  roleType: "bridge" | "below_deck";
  slot: string | null;        // 'captain', 'officer_1', etc.
  officerName?: string;       // joined from reference_officers
}

/** Loadout with its crew members resolved. */
export interface LoadoutWithMembers extends Loadout {
  members: LoadoutMember[];
}

// ─── Dock Types (L3 — resource slots, metadata only) ───────────

/** A physical drydock slot. Simplified from ADR-010: no child relationships. */
export interface Dock {
  dockNumber: number;
  label: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Dock with its currently assigned plan item (if any). */
export interface DockWithAssignment extends Dock {
  assignment: PlanItemSummary | null;
}

/** Lightweight plan item info for dock context. */
export interface PlanItemSummary {
  id: number;
  intentKey: string | null;
  label: string | null;
  loadoutId: number | null;
  loadoutName: string | null;
  shipName: string | null;
  isActive: boolean;
}

// ─── Plan Types (L3 — scheduling layer) ─────────────────────────

/** A plan item: an objective + a loadout/officers + a resource (dock or away). */
export interface PlanItem {
  id: number;
  intentKey: string | null;
  label: string | null;
  loadoutId: number | null;
  dockNumber: number | null;     // NULL for away teams
  priority: number;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Plan item with resolved loadout, dock, and intent info. */
export interface PlanItemWithContext extends PlanItem {
  intentLabel: string | null;
  loadoutName: string | null;
  shipId: string | null;
  shipName: string | null;
  dockLabel: string | null;
  members: LoadoutMember[];       // from loadout, or empty for away teams
  awayMembers: PlanAwayMember[];  // only populated when loadout_id IS NULL
}

/** An officer assigned to an away team plan item. */
export interface PlanAwayMember {
  id: number;
  planItemId: number;
  officerId: string;
  officerName?: string;  // joined from reference_officers
}

// ─── Analysis Types ─────────────────────────────────────────────

/** An officer appearing in multiple active plan-item contexts. */
export interface OfficerConflict {
  officerId: string;
  officerName: string;
  appearances: Array<{
    planItemId: number;
    planItemLabel: string | null;
    intentKey: string | null;
    dockNumber: number | null;
    source: "loadout" | "away_team";
    loadoutName: string | null;
  }>;
}

/** Result of validatePlan(). */
export interface PlanValidation {
  valid: boolean;
  dockConflicts: Array<{ dockNumber: number; planItemIds: number[]; labels: string[] }>;
  officerConflicts: OfficerConflict[];
  unassignedLoadouts: Array<{ planItemId: number; label: string | null }>;
  unassignedDocks: Array<{ planItemId: number; label: string | null }>;
  warnings: string[];
}

// ─── Solver Types ───────────────────────────────────────────────

/** A single assignment decision made by the solver. */
export interface SolverAssignment {
  planItemId: number;
  planItemLabel: string | null;
  loadoutId: number | null;
  loadoutName: string | null;
  dockNumber: number | null;
  action: "assigned" | "queued" | "conflict" | "unchanged";
  explanation: string;
}

/** Full solver result with explanations and validation. */
export interface SolverResult {
  assignments: SolverAssignment[];
  applied: boolean;           // true if changes were written to DB
  conflicts: OfficerConflict[];
  summary: string;            // human-readable summary
  warnings: string[];
}

// ─── Seed Data ──────────────────────────────────────────────────

export const SEED_INTENTS: Array<
  Pick<Intent, "key" | "label" | "category" | "description" | "icon"> & { sortOrder: number }
> = [
  { key: "general", label: "General", category: "utility", description: "General-purpose crew configuration", icon: "⚙️", sortOrder: 0 },
  // Mining
  { key: "mining-gas", label: "Gas Mining", category: "mining", description: "Collecting raw gas from nodes", icon: "⛽", sortOrder: 10 },
  { key: "mining-crystal", label: "Crystal Mining", category: "mining", description: "Collecting raw crystal from nodes", icon: "💎", sortOrder: 11 },
  { key: "mining-ore", label: "Ore Mining", category: "mining", description: "Collecting raw ore from nodes", icon: "⛏️", sortOrder: 12 },
  { key: "mining-tri", label: "Tritanium Mining", category: "mining", description: "Collecting tritanium from refined nodes", icon: "🔩", sortOrder: 13 },
  { key: "mining-dil", label: "Dilithium Mining", category: "mining", description: "Collecting dilithium from refined nodes", icon: "🔮", sortOrder: 14 },
  { key: "mining-para", label: "Parasteel Mining", category: "mining", description: "Collecting parasteel from refined nodes", icon: "🛡️", sortOrder: 15 },
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
