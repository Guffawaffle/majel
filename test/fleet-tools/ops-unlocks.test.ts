/**
 * ops-unlocks.test.ts — Tests for check_ops_unlocks tool (ADR-044 Phase 3, #214)
 *
 * Five test cases matching the agreed three-way distinction contract:
 * 1. Exact level with results
 * 2. Next boundary from user's ops level
 * 3. No unlocks at queried level (data exists, nothing at that level)
 * 4. Building data unavailable (reference store empty)
 * 5. At max level (no further boundary)
 */

import { describe, it, expect, vi } from "vitest";
import { checkOpsUnlocks } from "../../src/server/services/fleet-tools/read-tools-ops-unlocks.js";
import type { ReferenceBuilding } from "../../src/server/stores/reference-store.js";
import {
  toolEnv,
  createMockReferenceStore,
  createMockUserSettingsStore,
} from "./helpers.js";

function building(name: string, unlockLevel: number): ReferenceBuilding {
  return {
    id: `bld-${name.toLowerCase().replace(/\s/g, "-")}`,
    name,
    maxLevel: 80,
    unlockLevel,
    buffs: null,
    requirements: null,
    gameId: null,
    source: "cdn",
    license: "test",
    attribution: "test",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("check_ops_unlocks", () => {
  it("returns buildings at an exact ops level", async () => {
    const refStore = createMockReferenceStore({
      counts: vi.fn().mockResolvedValue({ officers: 42, ships: 18, buildings: 106 }),
      listBuildingsAtOps: vi.fn().mockResolvedValue([
        building("Academy", 15),
        building("Armory", 15),
      ]),
    });
    const ctx = toolEnv({ referenceStore: refStore });

    const result = await checkOpsUnlocks(15, ctx) as Record<string, unknown>; 
    expect(result.queryType).toBe("exact_level");
    expect(result.opsLevel).toBe(15);
    expect(result.buildings).toHaveLength(2);
    expect(result.buildingCount).toBe(2);
    expect(result).not.toHaveProperty("note");
    expect(result).not.toHaveProperty("currentOpsLevel");
  });

  it("finds next boundary above user's current ops level", async () => {
    const refStore = createMockReferenceStore({
      counts: vi.fn().mockResolvedValue({ officers: 42, ships: 18, buildings: 106 }),
      listBuildingsAtOps: vi.fn().mockResolvedValue([
        building("Refinery", 32),
        building("Lab", 32),
        building("Shield Gen", 35),
      ]),
    });
    const settingsStore = createMockUserSettingsStore();
    const ctx = toolEnv({
      referenceStore: refStore,
      userSettingsStore: settingsStore,
      userId: "user-1",
    });

    const result = await checkOpsUnlocks(undefined, ctx) as Record<string, unknown>;
    expect(result.queryType).toBe("next_boundary");
    expect(result.currentOpsLevel).toBe(30); // default mock ops level
    expect(result.opsLevel).toBe(32); // lowest boundary above 30
    expect(result.buildings).toHaveLength(2); // only level 32 buildings (grouped)
    expect(result.buildingCount).toBe(2);
    expect(result).not.toHaveProperty("note");
  });

  it("returns empty buildings with no note when nothing unlocks at queried level", async () => {
    const refStore = createMockReferenceStore({
      counts: vi.fn().mockResolvedValue({ officers: 42, ships: 18, buildings: 106 }),
      listBuildingsAtOps: vi.fn().mockResolvedValue([]),
    });
    const ctx = toolEnv({ referenceStore: refStore });

    const result = await checkOpsUnlocks(999, ctx) as Record<string, unknown>;
    expect(result.queryType).toBe("exact_level");
    expect(result.opsLevel).toBe(999);
    expect(result.buildings).toHaveLength(0);
    expect(result.buildingCount).toBe(0);
    expect(result).not.toHaveProperty("note");
  });

  it("returns note when building data is unavailable", async () => {
    // Default mock has no buildings key → buildings count = 0
    const refStore = createMockReferenceStore();
    const ctx = toolEnv({ referenceStore: refStore });

    const result = await checkOpsUnlocks(15, ctx) as Record<string, unknown>;
    expect(result.queryType).toBe("exact_level");
    expect(result.buildingCount).toBe(0);
    expect(result.note).toBe("Building reference data not loaded.");
  });

  it("returns note when at max level with no further boundaries", async () => {
    const refStore = createMockReferenceStore({
      counts: vi.fn().mockResolvedValue({ officers: 42, ships: 18, buildings: 106 }),
      listBuildingsAtOps: vi.fn().mockResolvedValue([]),
    });
    const settingsStore = createMockUserSettingsStore();
    const ctx = toolEnv({
      referenceStore: refStore,
      userSettingsStore: settingsStore,
      userId: "user-1",
    });

    const result = await checkOpsUnlocks(undefined, ctx) as Record<string, unknown>;
    expect(result.queryType).toBe("next_boundary");
    expect(result.currentOpsLevel).toBe(30);
    expect(result.buildingCount).toBe(0);
    expect(result.note).toBe("No further unlock boundaries found above Ops 30.");
  });
});
