/**
 * fleet-tools/game-reference.test.ts — Tests for game reference read tools
 *
 * Covers: get_game_reference
 */

import { describe, it, expect } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
} from "./helpers.js";

describe("get_game_reference", () => {
  it("resolves hostile system names and preserves raw ids for tracing", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "get_game_reference",
      { category: "hostile", id: "cdn:hostile:9001" },
      ctx,
    ) as Record<string, unknown>;

    const reference = result.reference as Record<string, unknown>;
    expect(reference.name).toBe("Gorn Hunter");
    expect(reference.systems).toEqual(["Aurelia", "Krona Rift"]);
    expect(reference.systemRefs).toEqual([
      { id: "1244614683", name: "Aurelia" },
      { id: "1181687125", name: "Krona Rift" },
    ]);
  });
});

describe("search_game_reference — hostile/system filters", () => {
  it("calls filterHostiles when min_level filter is provided", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "search_game_reference",
      { category: "hostile", query: "", min_level: 25, max_level: 35, faction: "Klingon" },
      ctx,
    ) as { category: string; results: unknown[]; totalFound: number };

    expect(referenceStore.filterHostiles).toHaveBeenCalledWith(
      expect.objectContaining({ minLevel: 25, maxLevel: 35, faction: "Klingon" }),
    );
    expect(result.category).toBe("hostile");
    expect(result.results).toHaveLength(1);
  });

  it("calls filterSystems when level range filter is provided", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "search_game_reference",
      { category: "system", query: "", min_level: 30, max_level: 40, is_deep_space: true },
      ctx,
    ) as { category: string; results: unknown[] };

    expect(referenceStore.filterSystems).toHaveBeenCalledWith(
      expect.objectContaining({ minLevel: 30, maxLevel: 40, isDeepSpace: true }),
    );
    expect(result.category).toBe("system");
  });

  it("falls back to searchHostiles when no filter params (only query)", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    await executeFleetTool(
      "search_game_reference",
      { category: "hostile", query: "Gorn" },
      ctx,
    );

    expect(referenceStore.searchHostiles).toHaveBeenCalledWith("Gorn");
    expect(referenceStore.filterHostiles).not.toHaveBeenCalled();
  });

  it("passes hullType=0 when hull_type='destroyer'", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    await executeFleetTool(
      "search_game_reference",
      { category: "hostile", query: "", hull_type: "destroyer" },
      ctx,
    );

    expect(referenceStore.filterHostiles).toHaveBeenCalledWith(
      expect.objectContaining({ hullType: 0 }),
    );
  });

  it("passes hullType=0 when hull_type='interceptor' (player-term alias for destroyer)", async () => {
    const referenceStore = createMockReferenceStore();
    const ctx = toolEnv({ userId: "local", referenceStore });

    await executeFleetTool(
      "search_game_reference",
      { category: "hostile", query: "", hull_type: "interceptor" },
      ctx,
    );

    expect(referenceStore.filterHostiles).toHaveBeenCalledWith(
      expect.objectContaining({ hullType: 0 }),
    );
  });
});

describe("get_scrap_yields", () => {
  const SCRAP_SHIP = {
    id: "cdn:ship:34867572",
    name: "Mayflower",
    shipClass: "Explorer",
    grade: 3,
    rarity: "Rare",
    faction: "Federation",
    tier: null,
    ability: null,
    warpRange: null,
    link: null,
    gameId: 34867572,
    maxTier: 4,
    maxLevel: 60,
    scrapLevel: 55,
    scrap: [
      { hull_id: 34867572, scrap_time_seconds: 8100, level: 1, resources: [{ resource_id: 908921776, amount: 0 }] },
      { hull_id: 34867572, scrap_time_seconds: 8100, level: 2, resources: [{ resource_id: 908921776, amount: 100 }] },
    ],
    baseScrap: [{ resource_id: 743985951, amount: 5487 }],
    source: "cdn:game-data",
    license: "CC-BY-NC 4.0",
    attribution: "STFC community data",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    hullType: null,
    buildTimeInSeconds: null,
    officerBonus: null,
    crewSlots: null,
    buildCost: null,
    levels: null,
    tiers: null,
    buildRequirements: null,
    blueprintsRequired: null,
    sourceUrl: null,
    sourcePageId: null,
    sourceRevisionId: null,
    sourceRevisionTimestamp: null,
  };

  it("returns full scrap table when no level specified", async () => {
    const referenceStore = createMockReferenceStore();
    (referenceStore.getShip as ReturnType<typeof vi.fn>).mockResolvedValue(SCRAP_SHIP);
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "get_scrap_yields",
      { ship_id: "cdn:ship:34867572" },
      ctx,
    ) as Record<string, unknown>;

    expect(result.shipId).toBe("cdn:ship:34867572");
    expect(result.shipName).toBe("Mayflower");
    expect(result.scrapLevel).toBe(55);
    expect(result.totalLevels).toBe(2);
    expect(Array.isArray(result.scrapByLevel)).toBe(true);
    expect(Array.isArray(result.baseScrap)).toBe(true);
  });

  it("returns specific level entry when level is provided", async () => {
    const referenceStore = createMockReferenceStore();
    (referenceStore.getShip as ReturnType<typeof vi.fn>).mockResolvedValue(SCRAP_SHIP);
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "get_scrap_yields",
      { ship_id: "cdn:ship:34867572", level: 2 },
      ctx,
    ) as Record<string, unknown>;

    expect(result.requestedLevel).toBe(2);
    expect(result.scrapEntry).toBeDefined();
    const entry = result.scrapEntry as Record<string, unknown>;
    expect(entry.level).toBe(2);
  });

  it("returns error when level not found", async () => {
    const referenceStore = createMockReferenceStore();
    (referenceStore.getShip as ReturnType<typeof vi.fn>).mockResolvedValue(SCRAP_SHIP);
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "get_scrap_yields",
      { ship_id: "cdn:ship:34867572", level: 99 },
      ctx,
    ) as Record<string, unknown>;

    expect(result.error).toMatch(/No scrap entry at level 99/);
  });

  it("reports scrapAvailable:false for ship with no scrap data", async () => {
    const referenceStore = createMockReferenceStore();
    // FIXTURE_SHIP has scrap: null
    const ctx = toolEnv({ userId: "local", referenceStore });

    const result = await executeFleetTool(
      "get_scrap_yields",
      { ship_id: "ship-enterprise" },
      ctx,
    ) as Record<string, unknown>;

    expect(result.scrapAvailable).toBe(false);
  });
});

