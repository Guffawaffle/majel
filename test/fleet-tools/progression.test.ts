/**
 * fleet-tools/progression.test.ts — Tests for progression read tools
 *
 * Covers: list_research, list_inventory, calculate_upgrade_path,
 *         estimate_acquisition_time, calculate_true_power
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockOverlayStore,
  createMockResearchStore,
  createMockInventoryStore,
  FIXTURE_SHIP,
  FIXTURE_SHIP_OVERLAY,
} from "./helpers.js";

describe("list_research", () => {
  it("returns grouped research state from store", async () => {
    const ctx = toolEnv({
      researchStore: createMockResearchStore(),
    });
    const result = await executeFleetTool("list_research", {}, ctx) as Record<string, unknown>;

    expect(result.summary).toBeDefined();
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalTrees).toBe(1);
    const trees = result.trees as Array<Record<string, unknown>>;
    expect(trees).toHaveLength(1);
    expect(trees[0].tree).toBe("combat");
  });

  it("passes filters to store", async () => {
    const listByTree = vi.fn().mockResolvedValue([]);
    const ctx = toolEnv({
      researchStore: createMockResearchStore({ listByTree }),
    });
    await executeFleetTool("list_research", { tree: "combat", include_completed: false }, ctx);

    expect(listByTree).toHaveBeenCalledWith({ tree: "combat", includeCompleted: false });
  });

  it("trims tree filter and defaults includeCompleted=true", async () => {
    const listByTree = vi.fn().mockResolvedValue([]);
    const ctx = toolEnv({
      researchStore: createMockResearchStore({ listByTree }),
    });

    await executeFleetTool("list_research", { tree: "  combat  " }, ctx);

    expect(listByTree).toHaveBeenCalledWith({ tree: "combat", includeCompleted: true });
  });

  it("returns error when research store unavailable", async () => {
    const result = await executeFleetTool("list_research", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

describe("list_inventory", () => {
  it("returns grouped inventory state from store", async () => {
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("list_inventory", {}, ctx) as Record<string, unknown>;

    expect(result.summary).toBeDefined();
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalItems).toBe(1);
    const categories = result.categories as Array<Record<string, unknown>>;
    expect(categories).toHaveLength(1);
    expect(categories[0].category).toBe("ore");
  });

  it("passes filters to store", async () => {
    const listByCategory = vi.fn().mockResolvedValue([]);
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ listByCategory }),
    });

    await executeFleetTool("list_inventory", { category: "ore", query: "3★" }, ctx);
    expect(listByCategory).toHaveBeenCalledWith({ category: "ore", q: "3★" });
  });

  it("normalizes category casing and trims query", async () => {
    const listByCategory = vi.fn().mockResolvedValue([]);
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ listByCategory }),
    });

    await executeFleetTool("list_inventory", { category: "  ORE  ", query: "  tritanium  " }, ctx);

    expect(listByCategory).toHaveBeenCalledWith({ category: "ore", q: "tritanium" });
  });

  it("returns error when inventory store unavailable", async () => {
    const result = await executeFleetTool("list_inventory", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid category", async () => {
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("list_inventory", { category: "invalid" }, ctx);
    expect(result).toHaveProperty("error");
  });
});


describe("calculate_upgrade_path", () => {
  it("computes requirement gaps against inventory", async () => {
    const shipWithTiers = {
      ...FIXTURE_SHIP,
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 300, name: "3★ Ore" }] },
            { build_cost: [{ resource_id: 102, amount: 120, name: "3★ Crystal" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(shipWithTiers) }),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP_OVERLAY, tier: 5 }) }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          {
            id: 1,
            category: "ore",
            name: "3★ Ore",
            grade: "3-star",
            quantity: 280,
            unit: null,
            source: "manual",
            capturedAt: "2026-02-18T00:00:00Z",
            updatedAt: "2026-02-18T00:00:00Z",
          },
          {
            id: 2,
            category: "crystal",
            name: "3★ Crystal",
            grade: "3-star",
            quantity: 150,
            unit: null,
            source: "manual",
            capturedAt: "2026-02-18T00:00:00Z",
            updatedAt: "2026-02-18T00:00:00Z",
          },
        ]),
      }),
    });

    const result = await executeFleetTool(
      "calculate_upgrade_path",
      { ship_id: "ship-enterprise", target_tier: 6 },
      ctx,
    ) as Record<string, unknown>;

    const summary = result.summary as Record<string, unknown>;
    expect(summary.requirementCount).toBe(2);
    expect(summary.totalGap).toBe(20);

    const requirements = result.requirements as Array<Record<string, unknown>>;
    const ore = requirements.find((entry) => entry.name === "3★ Ore") as Record<string, unknown>;
    expect(ore.gap).toBe(20);
  });

  it("returns error when inventory store unavailable", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("calculate_upgrade_path", { ship_id: "ship-enterprise" }, ctx);
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid target tier", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP_OVERLAY, tier: 8 }) }),
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("calculate_upgrade_path", { ship_id: "ship-enterprise", target_tier: 7 }, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("estimate_acquisition_time", () => {
  it("estimates days to cover resource gaps", async () => {
    const shipWithTiers = {
      ...FIXTURE_SHIP,
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 300, name: "3★ Ore" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(shipWithTiers) }),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP_OVERLAY, tier: 5 }) }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          {
            id: 1,
            category: "ore",
            name: "3★ Ore",
            grade: "3-star",
            quantity: 50,
            unit: null,
            source: "manual",
            capturedAt: "2026-02-18T00:00:00Z",
            updatedAt: "2026-02-18T00:00:00Z",
          },
        ]),
      }),
    });

    const result = await executeFleetTool(
      "estimate_acquisition_time",
      { ship_id: "ship-enterprise", target_tier: 6, daily_income: { ore: 25 } },
      ctx,
    ) as Record<string, unknown>;

    const summary = result.summary as Record<string, unknown>;
    expect(summary.feasible).toBe(true);
    expect(summary.estimatedDays).toBe(10);
    expect(summary.etaMode).toBe("numeric");
    expect(summary.confidenceThreshold).toBe(0.75);
    expect(Number(summary.confidenceScore)).toBeGreaterThanOrEqual(0.75);

    const perResource = result.perResource as Array<Record<string, unknown>>;
    expect(perResource[0]).toMatchObject({ name: "3★ Ore", gap: 250, dailyRate: 25, days: 10 });
  });

  it("falls back to qualitative ETA when confidence is below threshold", async () => {
    const shipWithTiers = {
      ...FIXTURE_SHIP,
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 300, name: "3★ Ore" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(shipWithTiers) }),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP_OVERLAY, tier: 5 }) }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([{ id: 1, category: "ore", name: "3★ Ore", grade: null, quantity: 50, unit: null, source: "manual", capturedAt: "2026-02-18T00:00:00Z", updatedAt: "2026-02-18T00:00:00Z" }]),
      }),
    });

    const result = await executeFleetTool(
      "estimate_acquisition_time",
      { ship_id: "ship-enterprise", target_tier: 6, daily_income: { ore: 0 } },
      ctx,
    ) as Record<string, unknown>;

    const summary = result.summary as Record<string, unknown>;
    expect(summary.etaMode).toBe("qualitative");
    expect(summary.estimatedDays).toBeNull();
    expect(summary.qualitativeGuidance).toBeTruthy();
  });

  it("returns ship-not-found error from upgrade path", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(null) }),
      overlayStore: createMockOverlayStore(),
      inventoryStore: createMockInventoryStore(),
    });

    const result = await executeFleetTool("estimate_acquisition_time", { ship_id: "missing-ship" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Ship not found");
  });
});


describe("calculate_true_power", () => {
  it("calculates effective power using research multipliers", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
      researchStore: createMockResearchStore(),
    });

    const result = await executeFleetTool(
      "calculate_true_power",
      { ship_id: "ship-enterprise", intent_key: "pvp" },
      ctx,
    ) as Record<string, unknown>;

    expect(result.basePower).toBe(950000);
    expect(result.calculatedPower).toBe(1092500);
    const researchAdvisory = result.researchAdvisory as Record<string, unknown>;
    expect(researchAdvisory.priority).toBe("low");
  });

  it("returns null calculated power when ship overlay power is unavailable", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue(null) }),
      researchStore: createMockResearchStore(),
    });

    const result = await executeFleetTool("calculate_true_power", { ship_id: "ship-enterprise" }, ctx) as Record<string, unknown>;
    expect(result.basePower).toBeNull();
    expect(result.calculatedPower).toBeNull();
    expect(result.assumptions).toContain("ship_overlay_power_missing");
  });

  it("returns error for unknown ship", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(null) }),
      overlayStore: createMockOverlayStore(),
    });

    const result = await executeFleetTool("calculate_true_power", { ship_id: "unknown" }, ctx);
    expect(result).toHaveProperty("error");
  });
});

