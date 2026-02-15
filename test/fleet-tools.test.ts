/**
 * fleet-tools.test.ts — Tests for Gemini function calling tools (ADR-007 Phase C)
 *
 * Covers:
 * - Tool declaration validation (names, schemas)
 * - Tool executor dispatch for each Phase 1 tool
 * - Error handling (missing stores, unknown tools, missing args)
 * - ToolContext graceful degradation
 */

import { describe, it, expect, vi } from "vitest";
import {
  FLEET_TOOL_DECLARATIONS,
  executeFleetTool,
  type ToolContext,
} from "../src/server/services/fleet-tools.js";
import type { ReferenceStore, ReferenceOfficer, ReferenceShip } from "../src/server/stores/reference-store.js";
import type { OverlayStore, OfficerOverlay, ShipOverlay } from "../src/server/stores/overlay-store.js";
import type { LoadoutStore } from "../src/server/stores/loadout-store.js";

// ─── Test Fixtures ──────────────────────────────────────────

const FIXTURE_OFFICER: ReferenceOfficer = {
  id: "officer-kirk",
  name: "James T. Kirk",
  rarity: "Epic",
  groupName: "TOS Bridge",
  captainManeuver: "Inspirational",
  officerAbility: "Leader From The Front",
  belowDeckAbility: "Command Training",
  source: "stfc-wiki",
  sourceUrl: "https://stfc.wiki/kirk",
  sourcePageId: "123",
  sourceRevisionId: "456",
  sourceRevisionTimestamp: "2024-01-01T00:00:00Z",
  license: "CC BY-SA 3.0",
  attribution: "Community contributors",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const FIXTURE_SHIP: ReferenceShip = {
  id: "ship-enterprise",
  name: "USS Enterprise",
  shipClass: "Explorer",
  grade: 3,
  rarity: "Epic",
  faction: "Federation",
  tier: 8,
  source: "stfc-wiki",
  sourceUrl: "https://stfc.wiki/enterprise",
  sourcePageId: "789",
  sourceRevisionId: "012",
  sourceRevisionTimestamp: "2024-01-01T00:00:00Z",
  license: "CC BY-SA 3.0",
  attribution: "Community contributors",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const FIXTURE_OFFICER_OVERLAY: OfficerOverlay = {
  refId: "officer-kirk",
  ownershipState: "owned",
  target: false,
  level: 50,
  rank: "Captain",
  power: 12500,
  targetNote: null,
  targetPriority: null,
  updatedAt: "2024-06-01T00:00:00Z",
};

const FIXTURE_SHIP_OVERLAY: ShipOverlay = {
  refId: "ship-enterprise",
  ownershipState: "owned",
  target: true,
  tier: 8,
  level: 45,
  power: 950000,
  targetNote: "Max tier next",
  targetPriority: 1,
  updatedAt: "2024-06-01T00:00:00Z",
};

// ─── Mock Store Factories ───────────────────────────────────

function createMockReferenceStore(overrides: Partial<ReferenceStore> = {}): ReferenceStore {
  return {
    createOfficer: vi.fn(),
    getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
    findOfficerByName: vi.fn(),
    listOfficers: vi.fn(),
    searchOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER]),
    upsertOfficer: vi.fn(),
    deleteOfficer: vi.fn(),
    createShip: vi.fn(),
    getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
    findShipByName: vi.fn(),
    listShips: vi.fn(),
    searchShips: vi.fn().mockResolvedValue([FIXTURE_SHIP]),
    upsertShip: vi.fn(),
    deleteShip: vi.fn(),
    bulkUpsertOfficers: vi.fn(),
    bulkUpsertShips: vi.fn(),
    counts: vi.fn().mockResolvedValue({ officers: 42, ships: 18 }),
    close: vi.fn(),
    ...overrides,
  } as ReferenceStore;
}

function createMockOverlayStore(overrides: Partial<OverlayStore> = {}): OverlayStore {
  return {
    getOfficerOverlay: vi.fn().mockResolvedValue(FIXTURE_OFFICER_OVERLAY),
    setOfficerOverlay: vi.fn(),
    listOfficerOverlays: vi.fn(),
    deleteOfficerOverlay: vi.fn(),
    getShipOverlay: vi.fn().mockResolvedValue(FIXTURE_SHIP_OVERLAY),
    setShipOverlay: vi.fn(),
    listShipOverlays: vi.fn(),
    deleteShipOverlay: vi.fn(),
    bulkSetOfficerOwnership: vi.fn(),
    bulkSetShipOwnership: vi.fn(),
    bulkSetOfficerTarget: vi.fn(),
    bulkSetShipTarget: vi.fn(),
    counts: vi.fn().mockResolvedValue({
      officers: { total: 15, owned: 10, unowned: 3, unknown: 2, targeted: 4 },
      ships: { total: 8, owned: 5, unowned: 2, unknown: 1, targeted: 3 },
    }),
    close: vi.fn(),
    ...overrides,
  } as OverlayStore;
}

function createMockLoadoutStore(overrides: Partial<LoadoutStore> = {}): LoadoutStore {
  return {
    listIntents: vi.fn(),
    getIntent: vi.fn(),
    createIntent: vi.fn(),
    deleteIntent: vi.fn(),
    listLoadouts: vi.fn(),
    getLoadout: vi.fn(),
    createLoadout: vi.fn(),
    updateLoadout: vi.fn(),
    deleteLoadout: vi.fn(),
    setLoadoutMembers: vi.fn(),
    listDocks: vi.fn().mockResolvedValue([
      {
        dockNumber: 1, label: "PvP Dock", notes: null,
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
        assignment: {
          id: 1, intentKey: "pvp", label: "Arena PvP",
          loadoutId: 10, loadoutName: "Kirk Crew", shipName: "USS Enterprise",
          isActive: true,
        },
      },
      {
        dockNumber: 2, label: "Mining", notes: "Latinum runs",
        createdAt: "2024-01-01", updatedAt: "2024-01-01",
        assignment: null,
      },
    ]),
    getDock: vi.fn(),
    upsertDock: vi.fn(),
    deleteDock: vi.fn(),
    listPlanItems: vi.fn(),
    getPlanItem: vi.fn(),
    createPlanItem: vi.fn(),
    updatePlanItem: vi.fn(),
    deletePlanItem: vi.fn(),
    setPlanAwayMembers: vi.fn(),
    getOfficerConflicts: vi.fn().mockResolvedValue([
      {
        officerId: "officer-kirk",
        officerName: "James T. Kirk",
        appearances: [
          {
            planItemId: 1, planItemLabel: "Arena PvP", intentKey: "pvp",
            dockNumber: 1, source: "loadout", loadoutName: "Kirk Crew",
          },
          {
            planItemId: 3, planItemLabel: "Hostile Grind", intentKey: "hostiles",
            dockNumber: 3, source: "loadout", loadoutName: "Hostile Crew",
          },
        ],
      },
    ]),
    validatePlan: vi.fn().mockResolvedValue({
      valid: false,
      dockConflicts: [],
      officerConflicts: [
        {
          officerId: "officer-kirk",
          officerName: "James T. Kirk",
          appearances: [
            { planItemId: 1, planItemLabel: "Arena PvP", intentKey: "pvp", dockNumber: 1, source: "loadout", loadoutName: "Kirk Crew" },
            { planItemId: 3, planItemLabel: "Hostile Grind", intentKey: "hostiles", dockNumber: 3, source: "loadout", loadoutName: "Hostile Crew" },
          ],
        },
      ],
      unassignedLoadouts: [],
      unassignedDocks: [{ planItemId: 5, label: "Away Mission" }],
      warnings: ["Kirk is double-booked"],
    }),
    findLoadoutsForIntent: vi.fn(),
    previewDeleteLoadout: vi.fn(),
    previewDeleteDock: vi.fn(),
    previewDeleteOfficer: vi.fn(),
    counts: vi.fn().mockResolvedValue({
      intents: 5,
      loadouts: 3,
      loadoutMembers: 9,
      docks: 2,
      planItems: 4,
      awayMembers: 2,
    }),
    close: vi.fn(),
    ...overrides,
  } as unknown as LoadoutStore;
}

// ─── Tool Declarations ──────────────────────────────────────

describe("FLEET_TOOL_DECLARATIONS", () => {
  it("exports an array of tool declarations", () => {
    expect(Array.isArray(FLEET_TOOL_DECLARATIONS)).toBe(true);
    expect(FLEET_TOOL_DECLARATIONS.length).toBeGreaterThanOrEqual(8);
  });

  it("each declaration has name and description", () => {
    for (const tool of FLEET_TOOL_DECLARATIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      // Names must be snake_case, a-z/0-9/underscores, max 64 chars
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });

  it("includes all Phase 1 tools", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("get_fleet_overview");
    expect(names).toContain("search_officers");
    expect(names).toContain("search_ships");
    expect(names).toContain("get_officer_detail");
    expect(names).toContain("get_ship_detail");
    expect(names).toContain("list_docks");
    expect(names).toContain("get_officer_conflicts");
    expect(names).toContain("validate_plan");
  });

  it("search tools have required query parameter", () => {
    const searchOfficers = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "search_officers");
    expect(searchOfficers?.parameters?.required).toContain("query");

    const searchShips = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "search_ships");
    expect(searchShips?.parameters?.required).toContain("query");
  });

  it("detail tools have required ID parameter", () => {
    const officerDetail = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "get_officer_detail");
    expect(officerDetail?.parameters?.required).toContain("officer_id");

    const shipDetail = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "get_ship_detail");
    expect(shipDetail?.parameters?.required).toContain("ship_id");
  });

  it("parameterless tools have no parameters field", () => {
    const overview = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "get_fleet_overview");
    expect(overview?.parameters).toBeUndefined();

    const docks = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "list_docks");
    expect(docks?.parameters).toBeUndefined();
  });
});

// ─── Tool Executor ──────────────────────────────────────────

describe("executeFleetTool", () => {
  it("returns error for unknown tool", async () => {
    const result = await executeFleetTool("nonexistent_tool", {}, {});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Unknown tool");
  });

  it("catches exceptions and returns error object", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        counts: vi.fn().mockRejectedValue(new Error("DB connection lost")),
      }),
    };
    const result = await executeFleetTool("get_fleet_overview", {}, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("DB connection lost");
  });
});

// ─── Individual Tools ───────────────────────────────────────

describe("get_fleet_overview", () => {
  it("returns counts from all available stores", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
      loadoutStore: createMockLoadoutStore(),
    };
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toEqual({ officers: 42, ships: 18 });
    expect(result.overlays).toBeDefined();
    expect(result.loadouts).toBeDefined();
  });

  it("omits sections for unavailable stores", async () => {
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toBeDefined();
    expect(result.overlays).toBeUndefined();
    expect(result.loadouts).toBeUndefined();
  });

  it("returns empty object when no stores available", async () => {
    const result = await executeFleetTool("get_fleet_overview", {}, {});
    expect(result).toEqual({});
  });
});

describe("search_officers", () => {
  it("returns matching officers", async () => {
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
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
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
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
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        searchOfficers: vi.fn().mockResolvedValue(manyOfficers),
      }),
    };
    const result = await executeFleetTool("search_officers", { query: "Officer" }, ctx) as Record<string, unknown>;
    expect((result.results as unknown[]).length).toBe(20);
    expect(result.totalFound).toBe(25);
    expect(result.truncated).toBe(true);
  });
});

describe("search_ships", () => {
  it("returns matching ships", async () => {
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
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
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
    };
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
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.reference).toBeDefined();
    expect(result.overlay).toBeUndefined();
  });

  it("returns reference only when no overlay exists", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        getOfficerOverlay: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.reference).toBeDefined();
    expect(result.overlay).toBeUndefined();
  });

  it("returns error for unknown officer", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool(
      "get_officer_detail", { officer_id: "nonexistent" }, ctx,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });
});

describe("get_ship_detail", () => {
  it("returns merged reference + overlay data", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
    };
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

  it("returns error for unknown ship", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool(
      "get_ship_detail", { ship_id: "nonexistent" }, ctx,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });
});

describe("list_docks", () => {
  it("returns dock assignments", async () => {
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
    const result = await executeFleetTool("list_docks", {}, ctx) as Record<string, unknown>;
    const docks = result.docks as Array<Record<string, unknown>>;
    expect(docks).toHaveLength(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[0].assignment).toBeDefined();
    expect((docks[0].assignment as Record<string, unknown>).loadoutName).toBe("Kirk Crew");
    expect(docks[1].dockNumber).toBe(2);
    expect(docks[1].assignment).toBeNull();
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_docks", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("get_officer_conflicts", () => {
  it("returns conflict data", async () => {
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
    const result = await executeFleetTool("get_officer_conflicts", {}, ctx) as Record<string, unknown>;
    expect(result.totalConflicts).toBe(1);
    const conflicts = result.conflicts as Array<Record<string, unknown>>;
    expect(conflicts[0].officerName).toBe("James T. Kirk");
    expect((conflicts[0].appearances as unknown[]).length).toBe(2);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("get_officer_conflicts", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("validate_plan", () => {
  it("returns structured validation report", async () => {
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
    const result = await executeFleetTool("validate_plan", {}, ctx) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("Kirk is double-booked");
    expect((result.officerConflicts as unknown[]).length).toBe(1);
    expect((result.unassignedDocks as unknown[]).length).toBe(1);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("validate_plan", {}, {});
    expect(result).toHaveProperty("error");
  });
});
