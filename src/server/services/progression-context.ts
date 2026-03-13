/**
 * progression-context.ts — Cross-store progression snapshot (ADR-044, #212)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Assembles a read-only ProgressionContextV1 from existing stores.
 * This is a pure query function, not a new store.
 */

import type { ResolvedStores } from "./fleet-tools/declarations.js";
import type { UserSettingsStore } from "../stores/user-settings-store.js";
import type { FactionStandingRecord } from "./fleet-tools/read-tools-context-helpers.js";
import { normalizeFactionStanding } from "./fleet-tools/read-tools-context-helpers.js";
import { SEED_INTENTS } from "../types/crew-types.js";

// ─── Types ──────────────────────────────────────────────────

export interface ProgressionContextV1 {
  opsLevel: number;
  drydockCount: number;
  ownedOfficerCount: number;
  ownedShipCount: number;
  loadoutCount: number;
  activeTargetCount: number;
  factionStandings: FactionStandingRecord[];
  researchSummary: { completedNodes: number; totalNodes: number; pct: number } | null;
  nextOpsBoundary: {
    level: number;
    buildings: { name: string; maxLevel: number | null }[];
    buildingCount: number;
  } | null;
  intentCoverage: { covered: string[]; uncovered: string[] };
  dataQuality: {
    hasBuildingData: boolean;
    hasResearchData: boolean;
    hasInventoryData: boolean;
    hasFactionData: boolean;
    opsLevelIsDefault: boolean;
  };
}

// ─── Assembler ──────────────────────────────────────────────

export async function getProgressionContext(
  userId: string,
  deps: ResolvedStores,
  userSettingsStore: UserSettingsStore | null,
): Promise<ProgressionContextV1> {
  // ── Parallel reads from all available stores ────────────
  const [
    opsEntry,
    dockEntry,
    _hangarEntry,
    overlayCounts,
    loadouts,
    targetCounts,
    researchCounts,
    inventoryCounts,
    refCounts,
    factionRaw,
  ] = await Promise.all([
    userSettingsStore?.getForUser(userId, "fleet.opsLevel") ?? null,
    userSettingsStore?.getForUser(userId, "fleet.drydockCount") ?? null,
    // hangarEntry not used in v1 context but read for consistency
    userSettingsStore?.getForUser(userId, "fleet.shipHangarSlots") ?? null,
    deps.overlayStore?.counts() ?? null,
    deps.crewStore?.listLoadouts() ?? null,
    deps.targetStore?.counts() ?? null,
    deps.researchStore?.counts() ?? null,
    deps.inventoryStore?.counts() ?? null,
    deps.referenceStore?.counts() ?? null,
    readFactionSetting(userId, userSettingsStore),
  ]);

  const opsLevel = opsEntry ? Number(opsEntry.value) : 1;
  const drydockCount = dockEntry ? Number(dockEntry.value) : 0;
  const opsLevelIsDefault = opsEntry ? opsEntry.source !== "user" : true;

  // ── Owned counts ────────────────────────────────────────
  const ownedOfficerCount = overlayCounts?.officers?.owned ?? 0;
  const ownedShipCount = overlayCounts?.ships?.owned ?? 0;

  // ── Loadout counts + intent coverage ────────────────────
  const allLoadouts = loadouts ?? [];
  const loadoutCount = allLoadouts.length;

  const coveredSet = new Set<string>();
  for (const l of allLoadouts) {
    for (const k of l.intentKeys) coveredSet.add(k);
  }
  const allIntentKeys = SEED_INTENTS.map((i) => i.key);
  const covered = allIntentKeys.filter((k) => coveredSet.has(k));
  const uncovered = allIntentKeys.filter((k) => !coveredSet.has(k));

  // ── Target counts ──────────────────────────────────────
  const activeTargetCount = targetCounts?.active ?? 0;

  // ── Research summary ───────────────────────────────────
  let researchSummary: ProgressionContextV1["researchSummary"] = null;
  if (researchCounts && researchCounts.nodes > 0) {
    const pct = Math.round((researchCounts.completed / researchCounts.nodes) * 100);
    researchSummary = {
      completedNodes: researchCounts.completed,
      totalNodes: researchCounts.nodes,
      pct,
    };
  }

  // ── Next ops boundary ─────────────────────────────────
  let nextOpsBoundary: ProgressionContextV1["nextOpsBoundary"] = null;
  const hasBuildingData = (refCounts?.buildings ?? 0) > 0;
  if (hasBuildingData && deps.referenceStore) {
    const above = await deps.referenceStore.listBuildingsAtOps({ aboveLevel: opsLevel, limit: 50 });
    if (above.length > 0) {
      const nextLevel = above[0].unlockLevel!;
      const atNextLevel = above.filter((b) => b.unlockLevel === nextLevel);
      nextOpsBoundary = {
        level: nextLevel,
        buildings: atNextLevel.map((b) => ({ name: b.name, maxLevel: b.maxLevel })),
        buildingCount: atNextLevel.length,
      };
    }
  }

  // ── Faction standings ─────────────────────────────────
  const factionStandings = normalizeFactionStanding(factionRaw);

  // ── Data quality ──────────────────────────────────────
  const dataQuality: ProgressionContextV1["dataQuality"] = {
    hasBuildingData,
    hasResearchData: (researchCounts?.nodes ?? 0) > 0,
    hasInventoryData: (inventoryCounts?.items ?? 0) > 0,
    hasFactionData: factionStandings.length > 0,
    opsLevelIsDefault,
  };

  return {
    opsLevel,
    drydockCount,
    ownedOfficerCount,
    ownedShipCount,
    loadoutCount,
    activeTargetCount,
    factionStandings,
    researchSummary,
    nextOpsBoundary,
    intentCoverage: { covered, uncovered },
    dataQuality,
  };
}

// ─── Helpers ────────────────────────────────────────────────

async function readFactionSetting(
  userId: string,
  store: UserSettingsStore | null,
): Promise<unknown> {
  if (!store) return null;
  const entry = await store.getForUser(userId, "fleet.factionStandings");
  if (entry.source === "default" && entry.value === "") return null;
  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}
