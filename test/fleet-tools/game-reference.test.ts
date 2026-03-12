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

