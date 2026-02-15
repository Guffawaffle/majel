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
import type { LoadoutStore } from "../src/server/stores/loadout-store.js";
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
    expect(FLEET_TOOL_DECLARATIONS.length).toBeGreaterThanOrEqual(19);
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

// ─── Phase 2: Drydock Management Tools ──────────────────────

const FIXTURE_LOADOUT_WITH_MEMBERS = {
  id: 10,
  shipId: "ship-enterprise",
  name: "Kirk Crew",
  priority: 1,
  isActive: true,
  intentKeys: ["pvp"],
  tags: ["main"],
  notes: "Primary PvP loadout",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-06-01T00:00:00Z",
  shipName: "USS Enterprise",
  members: [
    { id: 1, loadoutId: 10, officerId: "officer-kirk", roleType: "bridge" as const, slot: "captain", officerName: "James T. Kirk" },
    { id: 2, loadoutId: 10, officerId: "officer-spock", roleType: "bridge" as const, slot: "officer_1", officerName: "Spock" },
    { id: 3, loadoutId: 10, officerId: "officer-bones", roleType: "below_deck" as const, slot: null, officerName: "Leonard McCoy" },
  ],
};

const FIXTURE_PLAN_ITEM_WITH_CONTEXT = {
  id: 1,
  intentKey: "pvp",
  label: "Arena PvP",
  loadoutId: 10,
  dockNumber: 1,
  priority: 1,
  isActive: true,
  notes: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-06-01T00:00:00Z",
  intentLabel: "PvP/Raiding",
  loadoutName: "Kirk Crew",
  shipId: "ship-enterprise",
  shipName: "USS Enterprise",
  dockLabel: "PvP Dock",
  members: [
    { id: 1, loadoutId: 10, officerId: "officer-kirk", roleType: "bridge" as const, slot: "captain", officerName: "James T. Kirk" },
  ],
  awayMembers: [],
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
        getOfficer: vi.fn().mockResolvedValue(null),
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
      loadoutStore: createMockLoadoutStore({
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_MEMBERS),
      }),
    };
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 10 }, ctx) as Record<string, unknown>;
    expect(result.name).toBe("Kirk Crew");
    expect(result.shipName).toBe("USS Enterprise");
    expect(result.intentKeys).toEqual(["pvp"]);
    const members = result.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
    expect(members[0].officerName).toBe("James T. Kirk");
    expect(members[0].roleType).toBe("bridge");
    expect(members[0].slot).toBe("captain");
  });

  it("returns error for nonexistent loadout", async () => {
    const ctx: ToolContext = {
      loadoutStore: createMockLoadoutStore({
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
      loadoutStore: createMockLoadoutStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM_WITH_CONTEXT]),
      }),
    };
    const result = await executeFleetTool("list_plan_items", {}, ctx) as Record<string, unknown>;
    expect(result.totalItems).toBe(1);
    const items = result.planItems as Array<Record<string, unknown>>;
    expect(items[0].label).toBe("Arena PvP");
    expect(items[0].dockNumber).toBe(1);
    expect(items[0].loadoutName).toBe("Kirk Crew");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_plan_items", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("list_intents", () => {
  it("returns intent catalog", async () => {
    const ctx: ToolContext = {
      loadoutStore: createMockLoadoutStore({
        listIntents: vi.fn().mockResolvedValue([FIXTURE_INTENT]),
      }),
    };
    const result = await executeFleetTool("list_intents", {}, ctx) as Record<string, unknown>;
    expect(result.totalIntents).toBe(1);
    const intents = result.intents as Array<Record<string, unknown>>;
    expect(intents[0].key).toBe("pvp");
    expect(intents[0].label).toBe("PvP/Raiding");
    expect(intents[0].category).toBe("combat");
  });

  it("passes category filter to store", async () => {
    const listIntentsMock = vi.fn().mockResolvedValue([FIXTURE_INTENT]);
    const ctx: ToolContext = {
      loadoutStore: createMockLoadoutStore({ listIntents: listIntentsMock }),
    };
    await executeFleetTool("list_intents", { category: "combat" }, ctx);
    expect(listIntentsMock).toHaveBeenCalledWith({ category: "combat" });
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_intents", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("find_loadouts_for_intent", () => {
  it("returns loadouts matching an intent", async () => {
    const ctx: ToolContext = {
      loadoutStore: createMockLoadoutStore({
        findLoadoutsForIntent: vi.fn().mockResolvedValue([FIXTURE_LOADOUT_WITH_MEMBERS]),
      }),
    };
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "pvp" }, ctx) as Record<string, unknown>;
    expect(result.intentKey).toBe("pvp");
    expect(result.totalLoadouts).toBe(1);
    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].name).toBe("Kirk Crew");
  });

  it("returns error for empty intent key", async () => {
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
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
      loadoutStore: createMockLoadoutStore({
        getIntent: vi.fn().mockResolvedValue(FIXTURE_INTENT),
        listLoadouts: vi.fn().mockResolvedValue([FIXTURE_LOADOUT_WITH_MEMBERS]),
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
      loadoutStore: createMockLoadoutStore({
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
      loadoutStore: createMockLoadoutStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM_WITH_CONTEXT]),
        listLoadouts: vi.fn().mockResolvedValue([FIXTURE_LOADOUT_WITH_MEMBERS]),
      }),
    };
    const result = await executeFleetTool("analyze_fleet", {}, ctx) as Record<string, unknown>;
    expect(result.totalDocks).toBe(2);
    expect(result.totalLoadouts).toBe(1);
    expect(result.totalPlanItems).toBe(1);
    expect(result.totalConflicts).toBe(1);

    const validation = result.validation as Record<string, unknown>;
    expect(validation.valid).toBe(false);

    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].name).toBe("Kirk Crew");
    expect(loadouts[0].memberCount).toBe(3);
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
      overlayStore: createMockOverlayStore(),
      loadoutStore: createMockLoadoutStore({
        previewDeleteOfficer: vi.fn().mockResolvedValue({
          loadoutMemberships: [{ loadoutId: 10, loadoutName: "Kirk Crew", shipName: "USS Enterprise" }],
          awayMemberships: [],
        }),
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
    const appearances = conflict.appearances as Array<Record<string, unknown>>;
    expect(appearances).toHaveLength(2);

    // Should find Spock as an alternative (same group)
    const alternatives = result.alternatives as Array<Record<string, unknown>>;
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0].name).toBe("Spock");
    expect(alternatives[0].owned).toBe(true);

    const preview = result.cascadePreview as Record<string, unknown>;
    expect((preview.loadoutMemberships as unknown[]).length).toBe(1);
  });

  it("returns null conflict when officer has no conflicts", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER]),
      }),
      overlayStore: createMockOverlayStore(),
      loadoutStore: createMockLoadoutStore({
        getOfficerConflicts: vi.fn().mockResolvedValue([]),
        previewDeleteOfficer: vi.fn().mockResolvedValue({
          loadoutMemberships: [],
          awayMemberships: [],
        }),
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
      loadoutStore: createMockLoadoutStore(),
    };
    const result = await executeFleetTool("resolve_conflict", { officer_id: "nonexistent" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when reference store unavailable", async () => {
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
    const result = await executeFleetTool("resolve_conflict", { officer_id: "officer-kirk" }, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("what_if_remove_officer", () => {
  it("returns cascade preview for officer removal", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      loadoutStore: createMockLoadoutStore({
        previewDeleteOfficer: vi.fn().mockResolvedValue({
          loadoutMemberships: [
            { loadoutId: 10, loadoutName: "Kirk Crew", shipName: "USS Enterprise" },
            { loadoutId: 20, loadoutName: "Hostile Crew", shipName: "USS Defiant" },
          ],
          awayMemberships: [
            { planItemId: 5, planItemLabel: "Away Mission Alpha" },
          ],
        }),
      }),
    };
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.officerName).toBe("James T. Kirk");
    expect(result.totalAffectedLoadouts).toBe(2);
    expect(result.totalAffectedAwayTeams).toBe(1);
    expect(result.totalAffected).toBe(3);

    const loadouts = result.loadoutMemberships as Array<Record<string, unknown>>;
    expect(loadouts[0].loadoutName).toBe("Kirk Crew");
    expect(loadouts[1].loadoutName).toBe("Hostile Crew");

    const away = result.awayMemberships as Array<Record<string, unknown>>;
    expect(away[0].planItemLabel).toBe("Away Mission Alpha");
  });

  it("returns zero affected when officer has no assignments", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      loadoutStore: createMockLoadoutStore({
        previewDeleteOfficer: vi.fn().mockResolvedValue({
          loadoutMemberships: [],
          awayMemberships: [],
        }),
      }),
    };
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.totalAffected).toBe(0);
  });

  it("works without reference store (no officer name)", async () => {
    const ctx: ToolContext = {
      loadoutStore: createMockLoadoutStore({
        previewDeleteOfficer: vi.fn().mockResolvedValue({
          loadoutMemberships: [],
          awayMemberships: [],
        }),
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
    const ctx: ToolContext = { loadoutStore: createMockLoadoutStore() };
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
      loadoutStore: createMockLoadoutStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10,
          name: "Kirk Crew",
          shipName: "USS Enterprise",
          intentKeys: ["pvp"],
          members: [
            { officerName: "James T. Kirk", roleType: "captain" },
            { officerName: "Spock", roleType: "bridge" },
          ],
        }]),
        getOfficerConflicts: vi.fn().mockResolvedValue([{
          officerId: "officer-kirk",
          officerName: "James T. Kirk",
          appearances: [
            { loadoutId: 10, loadoutName: "Kirk Crew", roleType: "captain" },
            { loadoutId: 20, loadoutName: "Backup Crew", roleType: "bridge" },
          ],
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
    expect(loadouts[0].memberCount).toBe(2);

    // Existing targets
    const targets = result.existingTargets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0].refId).toBe("officer-spock");

    // Officer conflicts
    const conflicts = result.officerConflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].officerName).toBe("James T. Kirk");
    expect(conflicts[0].appearances).toBe(2);

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
      loadoutStore: createMockLoadoutStore({
        getOfficerConflicts: vi.fn().mockResolvedValue([]),
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

  it("returns error when loadout store unavailable", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore(),
    };
    const result = await executeFleetTool("detect_target_conflicts", {}, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Loadout");
  });
});
