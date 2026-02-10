/**
 * dock-types.ts — Drydock Type Definitions & Seed Data
 *
 * Majel — STFC Fleet Intelligence System
 *
 * All interfaces, type unions, and seed intent catalog for the
 * drydock loadout system (ADR-010).
 *
 * Extracted from dock-store.ts during ADR-018 Phase 1 migration.
 */

// ─── Intent Types ───────────────────────────────────────────

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

// ─── Dock Types ─────────────────────────────────────────────

export interface DockLoadout {
  dockNumber: number;
  label: string | null;
  notes: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface DockShip {
  id: number;
  dockNumber: number;
  shipId: string;
  isActive: boolean;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  shipName?: string;
}

export interface DockWithContext {
  dockNumber: number;
  label: string | null;
  notes: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  intents: Intent[];
  ships: DockShip[];
}

// ─── Crew Preset Types ─────────────────────────────────────

export interface CrewPreset {
  id: number;
  shipId: string;
  intentKey: string;
  presetName: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  shipName?: string;
  intentLabel?: string;
}

export interface CrewPresetMember {
  id: number;
  presetId: number;
  officerId: string;
  roleType: "bridge" | "below_deck";
  slot: string | null;
  officerName?: string;
}

export interface CrewPresetWithMembers extends CrewPreset {
  members: CrewPresetMember[];
  tags: string[];
}

export interface OfficerConflict {
  officerId: string;
  officerName: string;
  appearances: Array<{
    presetId: number;
    presetName: string;
    shipId: string;
    shipName: string;
    intentKey: string;
    intentLabel: string;
    dockNumbers: number[];
  }>;
}

// ─── Briefing Types ─────────────────────────────────────────

export interface DockBriefing {
  statusLines: string[];
  crewLines: string[];
  conflictLines: string[];
  insights: string[];
  text: string;
  totalChars: number;
}

// ─── Seed Data ──────────────────────────────────────────────

export const SEED_INTENTS: Array<Pick<Intent, "key" | "label" | "category" | "description" | "icon"> & { sortOrder: number }> = [
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
