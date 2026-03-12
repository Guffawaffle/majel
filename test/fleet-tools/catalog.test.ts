/**
 * fleet-tools/catalog.test.ts — Tests for catalog read tools
 *
 * Covers: get_fleet_overview, search_officers, search_ships,
 *         get_officer_detail, get_ship_detail
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockOverlayStore,
  createMockCrewStore,
  FIXTURE_OFFICER,
  FIXTURE_SHIP,
} from "./helpers.js";

describe("get_fleet_overview", () => {
  it("returns counts from all available stores", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
      crewStore: createMockCrewStore(),
    });
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toEqual({ officers: 42, ships: 18 });
    expect(result.overlays).toBeDefined();
    expect(result.crew).toBeDefined();
  });

  it("omits sections for unavailable stores", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toBeDefined();
    expect(result.overlays).toBeUndefined();
    expect(result.crew).toBeUndefined();
  });

  it("returns empty object when no stores available", async () => {
    const result = await executeFleetTool("get_fleet_overview", {}, toolEnv());
    expect(result).toEqual({});
  });
});

describe("search_officers", () => {
  it("returns matching officers", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("search_officers", { query: "Kirk" }, ctx) as Record<string, unknown>;
    expect(result.results).toHaveLength(1);
    expect(result.totalFound).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("returns error when reference store unavailable", async () => {
    const result = await executeFleetTool("search_officers", { query: "Kirk" }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for empty query", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("search_officers", { query: "" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("required");
  });

  it("truncates results beyond limit", async () => {
    const manyOfficers = Array.from({ length: 25 }, (_, i) => ({
      ...FIXTURE_OFFICER,
      id: `officer-${i}`,
      name: `Officer ${i}`,
    }));
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        searchOfficers: vi.fn().mockResolvedValue(manyOfficers),
      }),
    });
    const result = await executeFleetTool("search_officers", { query: "Officer" }, ctx) as Record<string, unknown>;
    expect((result.results as unknown[]).length).toBe(20);
    expect(result.totalFound).toBe(25);
    expect(result.truncated).toBe(true);
  });
});

describe("search_ships", () => {
  it("returns matching ships", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("search_ships", { query: "Enterprise" }, ctx) as Record<string, unknown>;
    expect(result.results).toHaveLength(1);
    expect(result.totalFound).toBe(1);
  });

  it("returns error when reference store unavailable", async () => {
    const result = await executeFleetTool("search_ships", { query: "Enterprise" }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("get_officer_detail", () => {
  it("returns merged reference + overlay data", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
    });
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    const ref = result.reference as Record<string, unknown>;
    expect(ref.name).toBe("James T. Kirk");
    expect(ref.rarity).toBe("Epic");
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.ownershipState).toBe("owned");
    expect(overlay.level).toBe(50);
  });

  it("returns reference only when overlay store unavailable", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.reference).toBeDefined();
    expect(result.overlay).toBeUndefined();
  });

  it("returns reference only when no overlay exists", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        getOfficerOverlay: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.reference).toBeDefined();
    expect(result.overlay).toBeUndefined();
  });

  it("returns error for unknown officer", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "nonexistent" }, ctx,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });
});

describe("get_ship_detail", () => {
  it("returns merged reference + overlay data", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
    });
    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "ship-enterprise" }, ctx,
    ) as Record<string, unknown>;
    const ref = result.reference as Record<string, unknown>;
    expect(ref.name).toBe("USS Enterprise");
    expect(ref.shipClass).toBe("Explorer");
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.ownershipState).toBe("owned");
    expect(overlay.tier).toBe(8);
  });

  it("resolves nested build-cost resource names in ship detail", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({
          ...FIXTURE_SHIP,
          buildRequirements: [
            { build_cost: [{ resource_id: 2964093937, amount: 1200 }] },
          ],
          tiers: [
            { tier: 2, components: [{ build_cost: [{ resource_id: 2964093937, amount: 800 }] }] },
          ],
        }),
      }),
      resourceDefs: new Map([[2964093937, {
        gameId: 2964093937,
        resourceKey: "Resource_G4_Ore_Raw",
        name: "4★ Raw Ore",
        grade: 4,
        rarity: 1,
        category: "ore",
        locaId: 1,
      }]]),
    });

    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "ship-enterprise" }, ctx,
    ) as Record<string, unknown>;

    const ref = result.reference as Record<string, unknown>;
    const buildRequirements = ref.buildRequirements as Array<Record<string, unknown>>;
    const buildCost = buildRequirements[0].build_cost as Array<Record<string, unknown>>;
    expect(buildCost[0].name).toBe("4★ Raw Ore");
    expect(buildCost[0].resourceName).toBe("4★ Raw Ore");

    const tiers = ref.tiers as Array<Record<string, unknown>>;
    const tierBuildCost = ((tiers[0].components as Array<Record<string, unknown>>)[0].build_cost as Array<Record<string, unknown>>);
    expect(tierBuildCost[0].name).toBe("4★ Raw Ore");
  });

  it("does not trust unverified nested resource names when catalog resolution is missing", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({
          ...FIXTURE_SHIP,
          buildRequirements: [
            { build_cost: [{ resource_id: 999999, amount: 50, name: "<script>alert(1)</script>" }] },
          ],
        }),
      }),
      resourceDefs: new Map(),
    });

    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "ship-enterprise" }, ctx,
    ) as Record<string, unknown>;

    const ref = result.reference as Record<string, unknown>;
    const buildRequirements = ref.buildRequirements as Array<Record<string, unknown>>;
    const buildCost = buildRequirements[0].build_cost as Array<Record<string, unknown>>;
    expect(buildCost[0].name).toBe("Unknown resource (999999)");
    expect(buildCost[0].resourceNameVerified).toBe(false);
    expect(buildCost[0].unverifiedSourceNamePresent).toBe(true);
  });

  it("skips special object keys while annotating nested build-cost resources", async () => {
    const maliciousRequirement = JSON.parse('{"__proto__":{"polluted":true},"build_cost":[{"resource_id":2964093937,"amount":1}]}') as Record<string, unknown>;
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({
          ...FIXTURE_SHIP,
          buildRequirements: [maliciousRequirement],
        }),
      }),
      resourceDefs: new Map([[2964093937, {
        gameId: 2964093937,
        resourceKey: "Resource_G4_Ore_Raw",
        name: "4★ Raw Ore",
        grade: 4,
        rarity: 1,
        category: "ore",
        locaId: 1,
      }]]),
    });

    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "ship-enterprise" }, ctx,
    ) as Record<string, unknown>;

    const ref = result.reference as Record<string, unknown>;
    const buildRequirements = ref.buildRequirements as Array<Record<string, unknown>>;
    expect("polluted" in buildRequirements[0]).toBe(false);
  });

  it("returns error for unknown ship", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "nonexistent" }, ctx,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });
});

