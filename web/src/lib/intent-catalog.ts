/**
 * Static intent catalog — mirrors the `intent_catalog` DB table.
 *
 * These 22 entries are the built-in intents seeded by crew-store.ts.
 * Custom user intents aren't modelled here — they come from the API.
 */
import type { IntentDef, IntentCategory } from "./types.js";

export const INTENT_CATALOG: readonly IntentDef[] = [
  { key: "general",          label: "General",           icon: "⚙️",  category: "utility" },
  { key: "mining-gas",       label: "Gas Mining",        icon: "⛽",  category: "mining" },
  { key: "mining-crystal",   label: "Crystal Mining",    icon: "💎",  category: "mining" },
  { key: "mining-ore",       label: "Ore Mining",        icon: "⛏️",  category: "mining" },
  { key: "mining-tri",       label: "Tritanium",         icon: "🔩",  category: "mining" },
  { key: "mining-dil",       label: "Dilithium",         icon: "🔮",  category: "mining" },
  { key: "mining-para",      label: "Parasteel",         icon: "🛡️",  category: "mining" },
  { key: "mining-lat",       label: "Latinum",           icon: "💰",  category: "mining" },
  { key: "mining-iso",       label: "Isogen",            icon: "☢️",  category: "mining" },
  { key: "mining-data",      label: "Data",              icon: "📊",  category: "mining" },
  { key: "grinding",         label: "Hostile Grinding",  icon: "⚔️",  category: "combat" },
  { key: "grinding-swarm",   label: "Swarm",             icon: "🐝",  category: "combat" },
  { key: "grinding-eclipse", label: "Eclipse",           icon: "🌑",  category: "combat" },
  { key: "armada",           label: "Armada",            icon: "🎯",  category: "combat" },
  { key: "armada-solo",      label: "Solo Armada",       icon: "🎯",  category: "combat" },
  { key: "pvp",              label: "PvP/Raiding",       icon: "💀",  category: "combat" },
  { key: "base-defense",     label: "Base Defense",      icon: "🏰",  category: "combat" },
  { key: "exploration",      label: "Exploration",       icon: "🔭",  category: "utility" },
  { key: "cargo-run",        label: "Cargo Run",         icon: "📦",  category: "utility" },
  { key: "events",           label: "Events",            icon: "🎪",  category: "utility" },
  { key: "voyages",          label: "Voyages",           icon: "🚀",  category: "utility" },
  { key: "away-team",        label: "Away Team",         icon: "🖖",  category: "utility" },
] as const;

/** Group intents by category for rendering intent grids. */
export const INTENT_CATEGORIES: IntentCategory[] = ["mining", "combat", "utility"];

/** Look up a single intent by key. */
export function findIntent(key: string): IntentDef | undefined {
  return INTENT_CATALOG.find((i) => i.key === key);
}

/** Render a compact intent badge: "⛏️ Ore Mining". */
export function intentLabel(key: string): string {
  const def = findIntent(key);
  return def ? `${def.icon} ${def.label}` : key;
}
