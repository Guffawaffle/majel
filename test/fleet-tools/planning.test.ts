/**
 * fleet-tools/planning.test.ts — Tests for planning read tools
 *
 * Covers: validate_plan, list_plan_items, list_intents
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockCrewStore,
  FIXTURE_PLAN_ITEM,
} from "./helpers.js";

describe("validate_plan", () => {
  it("returns structured validation report", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          { id: 5, label: "Away Mission", loadoutId: null, variantId: null, dockNumber: null, awayOfficers: ["officer-uhura"], priority: 1, isActive: true, source: "manual", notes: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        ]),
      }),
    });
    const result = await executeFleetTool("validate_plan", {}, ctx) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(result.totalConflicts).toBe(1);
    expect((result.officerConflicts as unknown[]).length).toBe(1);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("validate_plan", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

describe("list_plan_items", () => {
  it("returns plan items with context", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM]),
      }),
    });
    const result = await executeFleetTool("list_plan_items", {}, ctx) as Record<string, unknown>;
    expect(result.totalItems).toBe(1);
    const items = result.planItems as Array<Record<string, unknown>>;
    expect(items[0].label).toBe("Arena PvP");
    expect(items[0].dockNumber).toBe(1);
    expect(items[0].loadoutId).toBe(10);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_plan_items", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

describe("list_intents", () => {
  it("returns intent catalog", async () => {
    // list_intents uses static SEED_INTENTS — no store needed
    const result = await executeFleetTool("list_intents", {}, toolEnv()) as Record<string, unknown>;
    expect(result.totalIntents).toBeGreaterThanOrEqual(22);
    const intents = result.intents as Array<Record<string, unknown>>;
    const pvp = intents.find((i) => i.key === "pvp");
    expect(pvp).toBeDefined();
    expect(pvp!.label).toBe("PvP/Raiding");
    expect(pvp!.category).toBe("combat");
  });

  it("filters by category", async () => {
    const result = await executeFleetTool("list_intents", { category: "combat" }, {}) as Record<string, unknown>;
    const intents = result.intents as Array<Record<string, unknown>>;
    expect(intents.length).toBeGreaterThan(0);
    for (const i of intents) {
      expect(i.category).toBe("combat");
    }
  });

  it("returns all intents without store (static data)", async () => {
    const result = await executeFleetTool("list_intents", {}, toolEnv()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.totalIntents).toBeGreaterThanOrEqual(22);
  });
});

