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

