/**
 * progression-context.test.ts — Tests for ADR-044 Phase 1
 *
 * Covers: getProgressionContext assembler, listBuildingsAtOps store query,
 *         opsLevelIsDefault provenance, nextOpsBoundary edge cases,
 *         graceful degradation with missing stores.
 */

import { describe, it, expect, vi } from "vitest";
import { getProgressionContext, type ProgressionContextV1 } from "../../src/server/services/progression-context.js";
import type { ResolvedStores } from "../../src/server/services/fleet-tools/declarations.js";
import type { ReferenceBuilding } from "../../src/server/stores/reference-store.js";
import {
  createMockReferenceStore,
  createMockOverlayStore,
  createMockCrewStore,
  createMockTargetStore,
  createMockResearchStore,
  createMockInventoryStore,
  createMockUserSettingsStore,
} from "./helpers.js";

// ─── Building Fixtures ──────────────────────────────────────

function makeBuilding(name: string, unlockLevel: number, maxLevel: number | null = 45): ReferenceBuilding {
  return {
    id: `cdn:building:${name.toLowerCase().replace(/\s/g, "-")}`,
    name,
    maxLevel,
    unlockLevel,
    buffs: null,
    requirements: null,
    gameId: null,
    source: "cdn:game-data",
    license: "CC-BY-NC 4.0",
    attribution: "STFC community data",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const BUILDINGS_AT_31 = [
  makeBuilding("Armory", 31),
  makeBuilding("War Room", 31, 30),
];

const BUILDINGS_AT_35 = [
  makeBuilding("Advanced Refinery", 35),
];

// ─── Full-store context ─────────────────────────────────────

function fullDeps(): ResolvedStores {
  const refStore = createMockReferenceStore({
    counts: vi.fn().mockResolvedValue({
      officers: 278, ships: 120, research: 350, buildings: 106,
      hostiles: 500, consumables: 80, systems: 2400,
    }),
    listBuildingsAtOps: vi.fn().mockResolvedValue(BUILDINGS_AT_31),
  });

  const crewStore = createMockCrewStore({
    listLoadouts: vi.fn().mockResolvedValue([
      { id: 1, shipId: "s1", name: "Mining", intentKeys: ["mining-gas", "mining-ore"], tags: [], isActive: true, priority: 1, bridgeCoreId: null, belowDeckPolicyId: null, notes: null, createdAt: "", updatedAt: "" },
      { id: 2, shipId: "s2", name: "PvP", intentKeys: ["pvp"], tags: [], isActive: true, priority: 2, bridgeCoreId: null, belowDeckPolicyId: null, notes: null, createdAt: "", updatedAt: "" },
      { id: 3, shipId: "s3", name: "Armada", intentKeys: ["armada"], tags: [], isActive: false, priority: 3, bridgeCoreId: null, belowDeckPolicyId: null, notes: null, createdAt: "", updatedAt: "" },
    ]),
  });

  return {
    referenceStore: refStore,
    overlayStore: createMockOverlayStore(),
    crewStore,
    targetStore: createMockTargetStore(),
    researchStore: createMockResearchStore({
      counts: vi.fn().mockResolvedValue({ nodes: 350, trees: 8, completed: 120 }),
    }),
    inventoryStore: createMockInventoryStore(),
    userSettingsStore: createMockUserSettingsStore(),
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("getProgressionContext", () => {
  it("assembles a full snapshot from all stores", async () => {
    const deps = fullDeps();
    const settingsStore = deps.userSettingsStore!;
    const ctx = await getProgressionContext("user-1", deps, settingsStore);

    expect(ctx.opsLevel).toBe(30);
    expect(ctx.drydockCount).toBe(4);
    expect(ctx.ownedOfficerCount).toBe(10);
    expect(ctx.ownedShipCount).toBe(5);
    expect(ctx.loadoutCount).toBe(3);
    expect(ctx.activeTargetCount).toBe(2);
    expect(ctx.factionStandings).toHaveLength(4);
    expect(ctx.factionStandings[0].faction).toBe("Federation");
  });

  it("computes research summary from store counts", async () => {
    const deps = fullDeps();
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.researchSummary).toEqual({
      completedNodes: 120,
      totalNodes: 350,
      pct: 34,
    });
  });

  it("returns null researchSummary when no research data", async () => {
    const deps = fullDeps();
    deps.researchStore = createMockResearchStore({
      counts: vi.fn().mockResolvedValue({ nodes: 0, trees: 0, completed: 0 }),
    });
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.researchSummary).toBeNull();
    expect(ctx.dataQuality.hasResearchData).toBe(false);
  });

  it("computes nextOpsBoundary from buildings above current level", async () => {
    const deps = fullDeps();
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.nextOpsBoundary).toEqual({
      level: 31,
      buildings: [
        { name: "Armory", maxLevel: 45 },
        { name: "War Room", maxLevel: 30 },
      ],
      buildingCount: 2,
    });
  });

  it("returns null nextOpsBoundary when no buildings above current level", async () => {
    const deps = fullDeps();
    (deps.referenceStore!.listBuildingsAtOps as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.nextOpsBoundary).toBeNull();
  });

  it("returns null nextOpsBoundary when no building data exists", async () => {
    const deps = fullDeps();
    (deps.referenceStore!.counts as ReturnType<typeof vi.fn>).mockResolvedValue({
      officers: 278, ships: 120, research: 350, buildings: 0,
      hostiles: 500, consumables: 80, systems: 2400,
    });
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.nextOpsBoundary).toBeNull();
    expect(ctx.dataQuality.hasBuildingData).toBe(false);
  });

  it("computes intent coverage from loadout intentKeys", async () => {
    const deps = fullDeps();
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.intentCoverage.covered).toContain("mining-gas");
    expect(ctx.intentCoverage.covered).toContain("mining-ore");
    expect(ctx.intentCoverage.covered).toContain("pvp");
    expect(ctx.intentCoverage.covered).toContain("armada");
    expect(ctx.intentCoverage.uncovered).toContain("grinding");
    expect(ctx.intentCoverage.uncovered).toContain("base-defense");
  });

  // ── opsLevelIsDefault provenance ────────────────────────

  it("sets opsLevelIsDefault=false when user has set ops level", async () => {
    const deps = fullDeps();
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.dataQuality.opsLevelIsDefault).toBe(false);
  });

  it("sets opsLevelIsDefault=true when ops level is schema default", async () => {
    const deps = fullDeps();
    const settingsStore = createMockUserSettingsStore({
      getForUser: vi.fn().mockImplementation(async (_userId: string, key: string) => {
        if (key === "fleet.opsLevel") return { key, value: "1", source: "default" as const };
        if (key === "fleet.drydockCount") return { key, value: "2", source: "default" as const };
        if (key === "fleet.shipHangarSlots") return { key, value: "10", source: "default" as const };
        if (key === "fleet.factionStandings") return { key, value: "{}", source: "default" as const };
        return { key, value: "[]", source: "default" as const };
      }),
    });
    deps.userSettingsStore = settingsStore;
    const ctx = await getProgressionContext("user-1", deps, settingsStore);

    expect(ctx.dataQuality.opsLevelIsDefault).toBe(true);
    expect(ctx.opsLevel).toBe(1);
  });

  // ── dataQuality flags ─────────────────────────────────

  it("sets all dataQuality flags correctly for populated stores", async () => {
    const deps = fullDeps();
    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    expect(ctx.dataQuality.hasBuildingData).toBe(true);
    expect(ctx.dataQuality.hasResearchData).toBe(true);
    expect(ctx.dataQuality.hasInventoryData).toBe(true);
    expect(ctx.dataQuality.hasFactionData).toBe(true);
    expect(ctx.dataQuality.opsLevelIsDefault).toBe(false);
  });

  // ── Graceful degradation ──────────────────────────────

  it("returns safe defaults when all stores are null", async () => {
    const deps: ResolvedStores = {};
    const ctx = await getProgressionContext("user-1", deps, null);

    expect(ctx.opsLevel).toBe(1);
    expect(ctx.drydockCount).toBe(0);
    expect(ctx.ownedOfficerCount).toBe(0);
    expect(ctx.ownedShipCount).toBe(0);
    expect(ctx.loadoutCount).toBe(0);
    expect(ctx.activeTargetCount).toBe(0);
    expect(ctx.factionStandings).toEqual([]);
    expect(ctx.researchSummary).toBeNull();
    expect(ctx.nextOpsBoundary).toBeNull();
    expect(ctx.intentCoverage.covered).toEqual([]);
    expect(ctx.intentCoverage.uncovered.length).toBeGreaterThan(0);
    expect(ctx.dataQuality.opsLevelIsDefault).toBe(true);
  });

  it("degrades per-field when some stores are missing", async () => {
    const deps: ResolvedStores = {
      overlayStore: createMockOverlayStore(),
      // no crewStore, no targetStore, no researchStore, no inventoryStore
    };
    const ctx = await getProgressionContext("user-1", deps, null);

    // overlay present → counts work
    expect(ctx.ownedOfficerCount).toBe(10);
    expect(ctx.ownedShipCount).toBe(5);
    // missing stores → safe defaults
    expect(ctx.loadoutCount).toBe(0);
    expect(ctx.activeTargetCount).toBe(0);
    expect(ctx.researchSummary).toBeNull();
  });

  // ── nextOpsBoundary groups by lowest unlock level ─────

  it("groups buildings at the same next unlock level", async () => {
    const mixed = [...BUILDINGS_AT_31, ...BUILDINGS_AT_35];
    const deps = fullDeps();
    (deps.referenceStore!.listBuildingsAtOps as ReturnType<typeof vi.fn>).mockResolvedValue(mixed);

    const ctx = await getProgressionContext("user-1", deps, deps.userSettingsStore!);

    // Should only include buildings at level 31 (the lowest above current 30)
    expect(ctx.nextOpsBoundary?.level).toBe(31);
    expect(ctx.nextOpsBoundary?.buildingCount).toBe(2);
    expect(ctx.nextOpsBoundary?.buildings.map((b) => b.name)).toEqual(["Armory", "War Room"]);
  });
});
