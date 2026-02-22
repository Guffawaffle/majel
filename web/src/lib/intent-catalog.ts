/**
 * Finite canonical intent catalog from kit artifact.
 */
import type { IntentDef, IntentCategory } from "./types.js";
import intentVectorsV0 from "./data/intent-vectors.v0.json";

interface CanonicalIntentVector {
  intentKey: string;
  label: string;
}

interface CanonicalIntentArtifact {
  intents: CanonicalIntentVector[];
}

const CANONICAL_INTENTS = intentVectorsV0 as CanonicalIntentArtifact;

const INTENT_ICONS: Record<string, string> = {
  hostile_grinding: "⚔️",
  pvp_station_hit: "🏰",
};

export const INTENT_CATALOG: readonly IntentDef[] = CANONICAL_INTENTS.intents.map((intent) => ({
  key: intent.intentKey,
  label: intent.label,
  icon: INTENT_ICONS[intent.intentKey] ?? "🎯",
  category: "combat",
}));

/** Group intents by category for rendering intent grids. */
export const INTENT_CATEGORIES: IntentCategory[] = ["combat"];

/** Look up a single intent by key. */
export function findIntent(key: string): IntentDef | undefined {
  return INTENT_CATALOG.find((i) => i.key === key);
}

/** Render a compact intent badge: "⛏️ Ore Mining". */
export function intentLabel(key: string): string {
  const def = findIntent(key);
  return def ? `${def.icon} ${def.label}` : key;
}
