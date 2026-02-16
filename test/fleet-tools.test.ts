/**
 * fleet-tools.test.ts — Tests for Gemini function calling tools (ADR-007 Phase C, ADR-010 §6)
 *
 * Covers:
 * - Tool declaration validation (names, schemas)
 * - Tool executor dispatch for each Phase 1 tool
 * - Phase 2 drydock management tools (data gathering + analysis)
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
import type { CrewStore } from "../src/server/stores/crew-store.js";
import type { TargetStore } from "../src/server/stores/target-store.js";

// ─── Test Fixtures ──────────────────────────────────────────

const FIXTURE_OFFICER: ReferenceOfficer = {
  id: "officer-kirk",
  name: "James T. Kirk",
  rarity: "Epic",
  groupName: "TOS Bridge",
  captainManeuver: "Inspirational",
  officerAbility: "Leader From The Front",
  belowDeckAbility: "Command Training",
  abilities: null,
  tags: null,
  officerGameId: null,
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
  ability: null,
  warpRange: null,
  link: null,
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
    listOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER]),
    searchOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER]),
    upsertOfficer: vi.fn(),
    deleteOfficer: vi.fn(),
    createShip: vi.fn(),
    getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
    findShipByName: vi.fn(),
    listShips: vi.fn().mockResolvedValue([FIXTURE_SHIP]),
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
    listOfficerOverlays: vi.fn().mockResolvedValue([]),
    deleteOfficerOverlay: vi.fn(),
    getShipOverlay: vi.fn().mockResolvedValue(FIXTURE_SHIP_OVERLAY),
    setShipOverlay: vi.fn(),
    listShipOverlays: vi.fn().mockResolvedValue([]),
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

function createMockCrewStore(overrides: Partial<CrewStore> = {}): CrewStore {
  const store = {
    listBridgeCores: vi.fn().mockResolvedValue([]),
    getBridgeCore: vi.fn().mockResolvedValue(null),
    createBridgeCore: vi.fn(),
    updateBridgeCore: vi.fn(),
    deleteBridgeCore: vi.fn(),
    setBridgeCoreMembers: vi.fn(),
    listBelowDeckPolicies: vi.fn().mockResolvedValue([]),
    getBelowDeckPolicy: vi.fn().mockResolvedValue(null),
    createBelowDeckPolicy: vi.fn(),
    updateBelowDeckPolicy: vi.fn(),
    deleteBelowDeckPolicy: vi.fn(),
    listLoadouts: vi.fn().mockResolvedValue([]),
    getLoadout: vi.fn().mockResolvedValue(null),
    createLoadout: vi.fn(),
    updateLoadout: vi.fn(),
    deleteLoadout: vi.fn(),
    listDocks: vi.fn().mockResolvedValue([
      { dockNumber: 1, label: "PvP Dock", unlocked: true, notes: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      { dockNumber: 2, label: "Mining", unlocked: true, notes: "Latinum runs", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
    ]),
    getDock: vi.fn(),
    upsertDock: vi.fn(),
    deleteDock: vi.fn(),
    listFleetPresets: vi.fn().mockResolvedValue([]),
    getFleetPreset: vi.fn().mockResolvedValue(null),
    createFleetPreset: vi.fn(),
    updateFleetPreset: vi.fn(),
    deleteFleetPreset: vi.fn(),
    setFleetPresetSlots: vi.fn(),
    listPlanItems: vi.fn().mockResolvedValue([]),
    getPlanItem: vi.fn().mockResolvedValue(null),
    createPlanItem: vi.fn(),
    updatePlanItem: vi.fn(),
    deletePlanItem: vi.fn(),
    listReservations: vi.fn().mockResolvedValue([]),
    getReservation: vi.fn().mockResolvedValue(null),
    setReservation: vi.fn(),
    deleteReservation: vi.fn(),
    listVariants: vi.fn().mockResolvedValue([]),
    createVariant: vi.fn(),
    resolveVariant: vi.fn(),
    getEffectiveDockState: vi.fn().mockResolvedValue({
      docks: [
        {
          dockNumber: 1,
          loadout: {
            loadoutId: 10, shipId: "ship-enterprise", name: "Kirk Crew",
            bridge: { captain: "officer-kirk", bridge_1: "officer-spock", bridge_2: null },
            belowDeckPolicy: null, intentKeys: ["pvp"], tags: [], notes: null,
          },
          variantPatch: null,
          intentKeys: ["pvp"],
          source: "manual" as const,
        },
        {
          dockNumber: 2,
          loadout: null,
          variantPatch: null,
          intentKeys: [],
          source: "manual" as const,
        },
      ],
      awayTeams: [],
      conflicts: [
        {
          officerId: "officer-kirk",
          locations: [
            { type: "bridge", entityId: 10, entityName: "Kirk Crew", slot: "captain" },
            { type: "bridge", entityId: 20, entityName: "Hostile Crew", slot: "captain" },
          ],
        },
      ],
    }),
    counts: vi.fn().mockResolvedValue({
      bridgeCores: 2,
      loadouts: 3,
      planItems: 4,
      docks: 2,
    }),
    close: vi.fn(),
    ...overrides,
  } as unknown as CrewStore;
  // Add getLoadoutsByIds that delegates to getLoadout (auto-derives from per-item mock)
  if (!overrides.getLoadoutsByIds) {
    (store as any).getLoadoutsByIds = vi.fn().mockImplementation(async (ids: number[]) => {
      const map = new Map();
      for (const id of ids) {
        const l = await store.getLoadout(id);
        if (l) map.set(id, l);
      }
      return map;
    });
  }
  return store;
}

function createMockTargetStore(overrides: Partial<TargetStore> = {}): TargetStore {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    markAchieved: vi.fn(),
    listByRef: vi.fn(),
    counts: vi.fn().mockResolvedValue({
      total: 3, active: 2, achieved: 1, abandoned: 0,
      byType: { officer: 1, ship: 1, crew: 1 },
    }),
    close: vi.fn(),
    ...overrides,
  } as unknown as TargetStore;
}

// ─── Tool Declarations ──────────────────────────────────────

describe("FLEET_TOOL_DECLARATIONS", () => {
  it("exports an array of tool declarations", () => {
    expect(Array.isArray(FLEET_TOOL_DECLARATIONS)).toBe(true);
    expect(FLEET_TOOL_DECLARATIONS.length).toBeGreaterThanOrEqual(26);
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

  it("includes all Phase 2 drydock management tools", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    // Data gathering tools
    expect(names).toContain("list_owned_officers");
    expect(names).toContain("get_loadout_detail");
    expect(names).toContain("list_plan_items");
    expect(names).toContain("list_intents");
    expect(names).toContain("find_loadouts_for_intent");
    // Analysis tools
    expect(names).toContain("suggest_crew");
    expect(names).toContain("analyze_fleet");
    expect(names).toContain("resolve_conflict");
    expect(names).toContain("what_if_remove_officer");
    // Target tools
    expect(names).toContain("list_targets");
    expect(names).toContain("suggest_targets");
    // Conflict detection
    expect(names).toContain("detect_target_conflicts");
  });

  it("includes all ADR-025 mutation tools", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("create_bridge_core");
    expect(names).toContain("create_loadout");
    expect(names).toContain("activate_preset");
    expect(names).toContain("set_reservation");
    expect(names).toContain("create_variant");
    expect(names).toContain("get_effective_state");
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
      crewStore: createMockCrewStore(),
    };
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toEqual({ officers: 42, ships: 18 });
    expect(result.overlays).toBeDefined();
    expect(result.crew).toBeDefined();
  });

  it("omits sections for unavailable stores", async () => {
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
    const result = await executeFleetTool("get_fleet_overview", {}, ctx) as Record<string, unknown>;
    expect(result.referenceCatalog).toBeDefined();
    expect(result.overlays).toBeUndefined();
    expect(result.crew).toBeUndefined();
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
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("list_docks", {}, ctx) as Record<string, unknown>;
    const docks = result.docks as Array<Record<string, unknown>>;
    expect(docks).toHaveLength(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[0].assignment).toBeDefined();
    expect((docks[0].assignment as Record<string, unknown>).loadoutName).toBe("Kirk Crew");
    expect(docks[1].dockNumber).toBe(2);
    expect((docks[1] as Record<string, unknown>).assignment).toBeNull();
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_docks", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("get_officer_conflicts", () => {
  it("returns conflict data", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("get_officer_conflicts", {}, ctx) as Record<string, unknown>;
    expect(result.totalConflicts).toBe(1);
    const conflicts = result.conflicts as Array<Record<string, unknown>>;
    expect(conflicts[0].officerId).toBe("officer-kirk");
    expect((conflicts[0].locations as unknown[]).length).toBe(2);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("get_officer_conflicts", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("validate_plan", () => {
  it("returns structured validation report", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          { id: 5, label: "Away Mission", loadoutId: null, variantId: null, dockNumber: null, awayOfficers: ["officer-uhura"], priority: 1, isActive: true, source: "manual", notes: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        ]),
      }),
    };
    const result = await executeFleetTool("validate_plan", {}, ctx) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(result.totalConflicts).toBe(1);
    expect((result.officerConflicts as unknown[]).length).toBe(1);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("validate_plan", {}, {});
    expect(result).toHaveProperty("error");
  });
});

// ─── Phase 2: Drydock Management Tools ──────────────────────

const FIXTURE_LOADOUT_WITH_REFS = {
  id: 10,
  shipId: "ship-enterprise",
  bridgeCoreId: 1,
  belowDeckPolicyId: null,
  name: "Kirk Crew",
  priority: 1,
  isActive: true,
  intentKeys: ["pvp"],
  tags: ["main"],
  notes: "Primary PvP loadout",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-06-01T00:00:00Z",
  bridgeCore: {
    id: 1,
    name: "TOS Bridge",
    notes: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    members: [
      { id: 1, bridgeCoreId: 1, officerId: "officer-kirk", slot: "captain" as const },
      { id: 2, bridgeCoreId: 1, officerId: "officer-spock", slot: "bridge_1" as const },
      { id: 3, bridgeCoreId: 1, officerId: "officer-bones", slot: "bridge_2" as const },
    ],
  },
  belowDeckPolicy: null,
};

const FIXTURE_PLAN_ITEM = {
  id: 1,
  intentKey: "pvp",
  label: "Arena PvP",
  loadoutId: 10,
  variantId: null,
  dockNumber: 1,
  awayOfficers: null,
  priority: 1,
  isActive: true,
  source: "manual" as const,
  notes: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-06-01T00:00:00Z",
};

const FIXTURE_INTENT = {
  key: "pvp",
  label: "PvP/Raiding",
  category: "combat",
  description: "Player vs player combat and raiding",
  icon: "💀",
  isBuiltin: true,
  sortOrder: 25,
  createdAt: "2024-01-01T00:00:00Z",
};

const FIXTURE_SPOCK_OFFICER: ReferenceOfficer = {
  ...FIXTURE_OFFICER,
  id: "officer-spock",
  name: "Spock",
  groupName: "TOS Bridge",
  captainManeuver: "Logical",
  officerAbility: "Science Officer",
  belowDeckAbility: "Vulcan Mind",
};

describe("list_owned_officers", () => {
  it("returns merged reference + overlay data for owned officers", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
    };
    const result = await executeFleetTool("list_owned_officers", {}, ctx) as Record<string, unknown>;
    expect(result.totalOwned).toBe(1);
    const officers = result.officers as Array<Record<string, unknown>>;
    expect(officers[0].name).toBe("James T. Kirk");
    expect(officers[0].level).toBe(50);
    expect(officers[0].captainManeuver).toBe("Inspirational");
  });

  it("filters out officers with missing reference data", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
    };
    const result = await executeFleetTool("list_owned_officers", {}, ctx) as Record<string, unknown>;
    expect(result.totalOwned).toBe(0);
  });

  it("returns error when overlay store unavailable", async () => {
    const ctx: ToolContext = { referenceStore: createMockReferenceStore() };
    const result = await executeFleetTool("list_owned_officers", {}, ctx);
    expect(result).toHaveProperty("error");
  });

  it("returns error when reference store unavailable", async () => {
    const ctx: ToolContext = { overlayStore: createMockOverlayStore() };
    const result = await executeFleetTool("list_owned_officers", {}, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("get_loadout_detail", () => {
  it("returns full loadout with crew members", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_REFS),
      }),
    };
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 10 }, ctx) as Record<string, unknown>;
    expect(result.name).toBe("Kirk Crew");
    expect(result.shipId).toBe("ship-enterprise");
    expect(result.intentKeys).toEqual(["pvp"]);
    const bc = result.bridgeCore as Record<string, unknown>;
    expect(bc).not.toBeNull();
    const members = bc.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
    expect(members[0].officerId).toBe("officer-kirk");
    expect(members[0].slot).toBe("captain");
  });

  it("returns error for nonexistent loadout", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 999 }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 10 }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("list_plan_items", () => {
  it("returns plan items with context", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM]),
      }),
    };
    const result = await executeFleetTool("list_plan_items", {}, ctx) as Record<string, unknown>;
    expect(result.totalItems).toBe(1);
    const items = result.planItems as Array<Record<string, unknown>>;
    expect(items[0].label).toBe("Arena PvP");
    expect(items[0].dockNumber).toBe(1);
    expect(items[0].loadoutId).toBe(10);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_plan_items", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("list_intents", () => {
  it("returns intent catalog", async () => {
    // list_intents uses static SEED_INTENTS — no store needed
    const result = await executeFleetTool("list_intents", {}, {}) as Record<string, unknown>;
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
    const result = await executeFleetTool("list_intents", {}, {}) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    expect(result.totalIntents).toBeGreaterThanOrEqual(22);
  });
});

describe("find_loadouts_for_intent", () => {
  it("returns loadouts matching an intent", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{ id: 10, name: "Kirk Crew", shipId: "ship-enterprise", isActive: true, intentKeys: ["pvp"] }]),
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_REFS),
      }),
    };
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "pvp" }, ctx) as Record<string, unknown>;
    expect(result.intentKey).toBe("pvp");
    expect(result.totalLoadouts).toBe(1);
    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].name).toBe("Kirk Crew");
  });

  it("returns error for empty intent key", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("required");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "pvp" }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("suggest_crew", () => {
  it("gathers ship, intent, owned officers, and existing loadouts", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([FIXTURE_LOADOUT_WITH_REFS]),
      }),
    };
    const result = await executeFleetTool(
      "suggest_crew", { ship_id: "ship-enterprise", intent_key: "pvp" }, ctx,
    ) as Record<string, unknown>;

    const ship = result.ship as Record<string, unknown>;
    expect(ship.name).toBe("USS Enterprise");
    expect(ship.shipClass).toBe("Explorer");

    const intent = result.intent as Record<string, unknown>;
    expect(intent.key).toBe("pvp");
    expect(intent.label).toBe("PvP/Raiding");

    expect(result.totalOwnedOfficers).toBe(1);
    const officers = result.ownedOfficers as Array<Record<string, unknown>>;
    expect(officers[0].name).toBe("James T. Kirk");

    const loadouts = result.existingLoadouts as Array<Record<string, unknown>>;
    expect(loadouts).toHaveLength(1);
    expect(loadouts[0].name).toBe("Kirk Crew");
  });

  it("works without intent_key", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool(
      "suggest_crew", { ship_id: "ship-enterprise" }, ctx,
    ) as Record<string, unknown>;
    expect(result.intent).toBeNull();
    expect(result.totalOwnedOfficers).toBe(0);
  });

  it("returns error for unknown ship", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool("suggest_crew", { ship_id: "nonexistent" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when reference store unavailable", async () => {
    const result = await executeFleetTool("suggest_crew", { ship_id: "ship-enterprise" }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("analyze_fleet", () => {
  it("gathers comprehensive fleet state", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM]),
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Kirk Crew", shipId: "ship-enterprise",
          isActive: true, intentKeys: ["pvp"],
        }]),
      }),
    };
    const result = await executeFleetTool("analyze_fleet", {}, ctx) as Record<string, unknown>;
    expect(result.totalDocks).toBe(2);
    expect(result.totalLoadouts).toBe(1);
    expect(result.totalPlanItems).toBe(1);
    expect(result.totalConflicts).toBe(1);

    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].name).toBe("Kirk Crew");
    expect(loadouts[0].shipId).toBe("ship-enterprise");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("analyze_fleet", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("resolve_conflict", () => {
  it("gathers officer details, conflicts, alternatives, and cascade preview", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER, FIXTURE_SPOCK_OFFICER]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([
          FIXTURE_OFFICER_OVERLAY,
          { ...FIXTURE_OFFICER_OVERLAY, refId: "officer-spock" },
        ]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([
          { id: 10, name: "Kirk Crew", shipId: "ship-enterprise", isActive: true },
        ]),
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_REFS),
      }),
    };
    const result = await executeFleetTool(
      "resolve_conflict", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;

    const officer = result.officer as Record<string, unknown>;
    expect(officer.name).toBe("James T. Kirk");
    expect(officer.group).toBe("TOS Bridge");

    const conflict = result.conflict as Record<string, unknown>;
    expect(conflict).not.toBeNull();
    const locations = conflict.locations as Array<Record<string, unknown>>;
    expect(locations).toHaveLength(2);

    // Should find Spock as an alternative (same group)
    const alternatives = result.alternatives as Array<Record<string, unknown>>;
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0].name).toBe("Spock");
    expect(alternatives[0].owned).toBe(true);

    const affected = result.affectedLoadouts as Array<Record<string, unknown>>;
    expect(affected.length).toBeGreaterThanOrEqual(1);
    expect(affected[0].loadoutName).toBe("Kirk Crew");
  });

  it("returns null conflict when officer has no conflicts", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER]),
      }),
      overlayStore: createMockOverlayStore(),
      crewStore: createMockCrewStore({
        getEffectiveDockState: vi.fn().mockResolvedValue({
          docks: [], awayTeams: [], conflicts: [],
        }),
        listLoadouts: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool(
      "resolve_conflict", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.conflict).toBeNull();
  });

  it("returns error for unknown officer", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(null),
      }),
      crewStore: createMockCrewStore(),
    };
    const result = await executeFleetTool("resolve_conflict", { officer_id: "nonexistent" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when reference store unavailable", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("resolve_conflict", { officer_id: "officer-kirk" }, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("what_if_remove_officer", () => {
  it("returns cascade preview for officer removal", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([
          { id: 10, name: "Kirk Crew", shipId: "ship-enterprise", isActive: true },
          { id: 20, name: "Hostile Crew", shipId: "ship-defiant", isActive: true },
        ]),
        getLoadout: vi.fn()
          .mockResolvedValueOnce({ ...FIXTURE_LOADOUT_WITH_REFS })
          .mockResolvedValueOnce({
            ...FIXTURE_LOADOUT_WITH_REFS, id: 20, name: "Hostile Crew", shipId: "ship-defiant",
            bridgeCore: {
              ...FIXTURE_LOADOUT_WITH_REFS.bridgeCore,
              members: [
                { id: 4, bridgeCoreId: 2, officerId: "officer-kirk", slot: "captain" as const },
              ],
            },
          }),
        listPlanItems: vi.fn().mockResolvedValue([
          { id: 5, label: "Away Mission Alpha", awayOfficers: ["officer-kirk"], loadoutId: null, variantId: null, dockNumber: null, priority: 1, isActive: true, source: "manual", notes: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        ]),
      }),
    };
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.officerName).toBe("James T. Kirk");
    expect(result.totalAffectedLoadouts).toBe(2);
    expect(result.totalAffectedAwayTeams).toBe(1);
    expect(result.totalAffected).toBe(3);

    const loadouts = result.affectedLoadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].loadoutName).toBe("Kirk Crew");
    expect(loadouts[1].loadoutName).toBe("Hostile Crew");

    const away = result.affectedAwayTeams as Array<Record<string, unknown>>;
    expect(away[0].planItemLabel).toBe("Away Mission Alpha");
  });

  it("returns zero affected when officer has no assignments", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.totalAffected).toBe(0);
  });

  it("works without reference store (no officer name)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.officerName).toBeNull();
    expect(result.totalAffected).toBe(0);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("what_if_remove_officer", { officer_id: "officer-kirk" }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for empty officer ID", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("what_if_remove_officer", { officer_id: "" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("required");
  });
});

// ─── Target/Goal Tracking Tools (#17) ─────────────────────

describe("list_targets", () => {
  const FIXTURE_TARGET = {
    id: 1,
    targetType: "officer" as const,
    refId: "officer-kirk",
    loadoutId: null,
    targetTier: null,
    targetRank: "Commander",
    targetLevel: 40,
    reason: "Strong captain maneuver",
    priority: 1,
    status: "active" as const,
    autoSuggested: false,
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    achievedAt: null,
  };

  it("returns active targets by default", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([FIXTURE_TARGET]),
      }),
    };
    const result = await executeFleetTool("list_targets", {}, ctx) as Record<string, unknown>;
    expect(result.totalTargets).toBe(1);
    const targets = result.targets as Array<Record<string, unknown>>;
    expect(targets[0].refId).toBe("officer-kirk");
    expect(targets[0].priority).toBe(1);
    expect(targets[0].status).toBe("active");
    // Verify default status filter
    expect(ctx.targetStore!.list).toHaveBeenCalledWith({ status: "active" });
  });

  it("passes target_type filter", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    };
    await executeFleetTool("list_targets", { target_type: "ship" }, ctx);
    expect(ctx.targetStore!.list).toHaveBeenCalledWith({
      targetType: "ship",
      status: "active",
    });
  });

  it("passes explicit status filter", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    };
    await executeFleetTool("list_targets", { status: "achieved" }, ctx);
    expect(ctx.targetStore!.list).toHaveBeenCalledWith({ status: "achieved" });
  });

  it("passes both filters together", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    };
    await executeFleetTool("list_targets", { target_type: "crew", status: "abandoned" }, ctx);
    expect(ctx.targetStore!.list).toHaveBeenCalledWith({
      targetType: "crew",
      status: "abandoned",
    });
  });

  it("maps all target fields to response", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([FIXTURE_TARGET]),
      }),
    };
    const result = await executeFleetTool("list_targets", {}, ctx) as Record<string, unknown>;
    const target = (result.targets as Array<Record<string, unknown>>)[0];
    expect(target).toEqual({
      id: 1,
      targetType: "officer",
      refId: "officer-kirk",
      loadoutId: null,
      targetTier: null,
      targetRank: "Commander",
      targetLevel: 40,
      reason: "Strong captain maneuver",
      priority: 1,
      status: "active",
      autoSuggested: false,
      achievedAt: null,
    });
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("list_targets", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("suggest_targets", () => {
  it("gathers comprehensive fleet state for suggestions", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_OFFICER_OVERLAY]) // owned officers
          .mockResolvedValueOnce([FIXTURE_OFFICER_OVERLAY]), // targeted overlay officers
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY]) // owned ships
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY]), // targeted overlay ships
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Kirk Crew", shipId: "ship-enterprise",
          isActive: true, intentKeys: ["pvp"],
        }]),
      }),
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([{
          id: 1,
          targetType: "officer",
          refId: "officer-spock",
          loadoutId: null,
          reason: "Need for science team",
          priority: 2,
        }]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Catalog size
    expect(result.catalogSize).toEqual({ officers: 42, ships: 18 });

    // Owned officers
    const officers = result.ownedOfficers as Array<Record<string, unknown>>;
    expect(officers).toHaveLength(1);
    expect(officers[0].name).toBe("James T. Kirk");
    expect(officers[0].captainManeuver).toBe("Inspirational");

    // Owned ships
    const ships = result.ownedShips as Array<Record<string, unknown>>;
    expect(ships).toHaveLength(1);
    expect(ships[0].name).toBe("USS Enterprise");

    // Loadouts
    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts).toHaveLength(1);
    expect(loadouts[0].name).toBe("Kirk Crew");

    // Existing targets
    const targets = result.existingTargets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0].refId).toBe("officer-spock");

    // Officer conflicts
    const conflicts = result.officerConflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].officerId).toBe("officer-kirk");
    expect(conflicts[0].locationCount).toBe(2);

    // Overlay targets
    expect(result.overlayTargets).toEqual({ officers: 1, ships: 1 });
  });

  it("works with minimal context (no stores)", async () => {
    const result = await executeFleetTool("suggest_targets", {}, {}) as Record<string, unknown>;
    // Should return empty object, no errors
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("error");
  });

  it("works with only reference store", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
    };
    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    expect(result.catalogSize).toEqual({ officers: 42, ships: 18 });
    expect(result).not.toHaveProperty("ownedOfficers");
    expect(result).not.toHaveProperty("loadouts");
  });

  it("works with only target store", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    expect(result.existingTargets).toEqual([]);
    expect(result).not.toHaveProperty("catalogSize");
  });
});

describe("detect_target_conflicts", () => {
  it("returns conflicts with summary", async () => {
    // Mock the detection: we test the detection engine separately in target-conflicts.test.ts.
    // Here we verify that the tool wiring works and returns the expected shape.
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool("detect_target_conflicts", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("conflicts");
    expect(result).toHaveProperty("summary");
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalConflicts).toBe(0);
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("detect_target_conflicts", {}, {});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Target");
  });

  it("returns error when crew store unavailable", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore(),
    };
    const result = await executeFleetTool("detect_target_conflicts", {}, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Crew");
  });
});

// ─── ADR-025 Mutation Tools ─────────────────────────────────

describe("create_bridge_core", () => {
  it("creates a bridge core with three officers", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        createBridgeCore: vi.fn().mockResolvedValue({
          id: 1,
          name: "Alpha Bridge",
          members: [
            { officerId: "kirk", slot: "captain" },
            { officerId: "spock", slot: "bridge_1" },
            { officerId: "mccoy", slot: "bridge_2" },
          ],
        }),
      }),
    };
    const result = await executeFleetTool("create_bridge_core", {
      name: "Alpha Bridge",
      captain: "kirk",
      bridge_1: "spock",
      bridge_2: "mccoy",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const bc = result.bridgeCore as Record<string, unknown>;
    expect(bc.id).toBe(1);
    expect(bc.name).toBe("Alpha Bridge");
    expect((bc.members as unknown[]).length).toBe(3);
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("create_bridge_core", {
      name: "X", captain: "a", bridge_1: "b", bridge_2: "c",
    }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing name", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_bridge_core", {
      captain: "a", bridge_1: "b", bridge_2: "c",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });

  it("returns error for missing bridge slots", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_bridge_core", {
      name: "X", captain: "a",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("bridge slots");
  });
});

describe("create_loadout", () => {
  it("creates a loadout with ship and name", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        createLoadout: vi.fn().mockResolvedValue({
          id: 10,
          name: "Mining Alpha",
          shipId: "ship-enterprise",
        }),
      }),
    };
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-enterprise",
      name: "Mining Alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const lo = result.loadout as Record<string, unknown>;
    expect(lo.id).toBe(10);
    expect(lo.name).toBe("Mining Alpha");
    expect(lo.shipId).toBe("ship-enterprise");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("create_loadout", {
      ship_id: "x", name: "Y",
    }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing ship_id", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_loadout", { name: "Y" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Ship ID");
  });

  it("returns error for missing name", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_loadout", { ship_id: "x" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });
});

describe("activate_preset", () => {
  it("returns a guided action with preset details", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        getFleetPreset: vi.fn().mockResolvedValue({
          id: 5, name: "War Preset", isActive: false, slots: [{ dockNumber: 1, loadoutId: 10 }],
        }),
      }),
    };
    const result = await executeFleetTool("activate_preset", { preset_id: 5 }, ctx) as Record<string, unknown>;
    expect(result.guidedAction).toBe(true);
    expect(result.actionType).toBe("activate_preset");
    expect(result.presetId).toBe(5);
    expect(result.presetName).toBe("War Preset");
    expect(result.slotCount).toBe(1);
    expect(result.uiPath).toBe("/app#fleet-ops/presets");
    expect((result.message as string)).toContain("Fleet Ops");
  });

  it("returns error when preset not found", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        getFleetPreset: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool("activate_preset", { preset_id: 999 }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("activate_preset", { preset_id: 1 }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("set_reservation", () => {
  it("sets a reservation for an officer", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        setReservation: vi.fn().mockResolvedValue({
          officerId: "kirk",
          reservedFor: "PvP Crew",
          locked: true,
        }),
      }),
    };
    const result = await executeFleetTool("set_reservation", {
      officer_id: "kirk",
      reserved_for: "PvP Crew",
      locked: "true",
    }, ctx) as Record<string, unknown>;
    expect(result.set).toBe(true);
    const res = result.reservation as Record<string, unknown>;
    expect(res.officerId).toBe("kirk");
    expect(res.reservedFor).toBe("PvP Crew");
    expect(res.locked).toBe(true);
  });

  it("clears a reservation when reserved_for is empty", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        deleteReservation: vi.fn().mockResolvedValue(true),
      }),
    };
    const result = await executeFleetTool("set_reservation", {
      officer_id: "kirk",
      reserved_for: "",
    }, ctx) as Record<string, unknown>;
    expect(result.cleared).toBe(true);
    expect(result.officerId).toBe("kirk");
    expect(result.existed).toBe(true);
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("set_reservation", {
      officer_id: "kirk", reserved_for: "PvP",
    }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing officer_id", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("set_reservation", {
      reserved_for: "PvP",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Officer ID");
  });
});

describe("create_variant", () => {
  it("creates a variant with bridge overrides", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        createVariant: vi.fn().mockResolvedValue({
          id: 3,
          baseLoadoutId: 10,
          name: "PvP Swap",
          patch: { bridge: { captain: "uhura" } },
          notes: null,
          createdAt: "2024-01-01",
        }),
      }),
    };
    const result = await executeFleetTool("create_variant", {
      loadout_id: 10,
      name: "PvP Swap",
      captain: "uhura",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const v = result.variant as Record<string, unknown>;
    expect(v.id).toBe(3);
    expect(v.baseLoadoutId).toBe(10);
    expect(v.name).toBe("PvP Swap");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("create_variant", {
      loadout_id: 10, name: "X",
    }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing loadout_id", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_variant", { name: "X" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("loadout ID");
  });

  it("returns error for missing name", async () => {
    const ctx: ToolContext = { crewStore: createMockCrewStore() };
    const result = await executeFleetTool("create_variant", { loadout_id: 10 }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });
});

describe("get_effective_state", () => {
  it("returns effective dock state with conflicts", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore(),
    };
    const result = await executeFleetTool("get_effective_state", {}, ctx) as Record<string, unknown>;
    expect(result.totalDocks).toBe(2);
    expect(result.totalConflicts).toBe(1);
    expect(result.activePreset).toBeNull();
    const docks = result.docks as unknown[];
    expect(docks.length).toBe(2);
    const conflicts = result.conflicts as unknown[];
    expect(conflicts.length).toBe(1);
  });

  it("includes active preset when available", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listFleetPresets: vi.fn().mockResolvedValue([
          { id: 1, name: "War Config", isActive: true },
        ]),
      }),
    };
    const result = await executeFleetTool("get_effective_state", {}, ctx) as Record<string, unknown>;
    const preset = result.activePreset as Record<string, unknown>;
    expect(preset.id).toBe(1);
    expect(preset.name).toBe("War Config");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("get_effective_state", {}, {});
    expect(result).toHaveProperty("error");
  });
});
