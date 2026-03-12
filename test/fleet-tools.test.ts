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
  type ToolEnv,
} from "../src/server/services/fleet-tools/index.js";
import type { ReferenceStore, ReferenceOfficer, ReferenceShip, ReferenceHostile, ReferenceSystem } from "../src/server/stores/reference-store.js";
import type { OverlayStore, OfficerOverlay, ShipOverlay } from "../src/server/stores/overlay-store.js";
import type { CrewStore } from "../src/server/stores/crew-store.js";
import type { TargetStore } from "../src/server/stores/target-store.js";
import type { ReceiptStore } from "../src/server/stores/receipt-store.js";
import type { ResearchStore } from "../src/server/stores/research-store.js";
import type { InventoryStore } from "../src/server/stores/inventory-store.js";

// ─── ToolEnv Helper (ADR-039 D7) ────────────────────────────

/** Wraps a flat store bag into ToolEnv shape for backward-compat test construction. */
function toolEnv(flat: Record<string, unknown> = {}): ToolEnv {
  const { userId, ...deps } = flat;
  return { userId: (userId as string) ?? "local", deps: deps as ToolEnv["deps"] };
}

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

const FIXTURE_HOSTILE: ReferenceHostile = {
  id: "cdn:hostile:9001",
  name: "Gorn Hunter",
  faction: "Gorn",
  level: 60,
  shipType: 1,
  hullType: 2,
  rarity: 4,
  strength: 3500000000,
  systems: ["1244614683", "1181687125"],
  warp: 700,
  resources: null,
  gameId: 9001,
  source: "cdn:game-data",
  license: "CC-BY-NC 4.0",
  attribution: "STFC community data",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const FIXTURE_SYSTEM: ReferenceSystem = {
  id: "cdn:system:1244614683",
  name: "Aurelia",
  estWarp: 700,
  isDeepSpace: true,
  factions: ["Gorn"],
  level: 60,
  coordsX: 0,
  coordsY: 0,
  hasMines: false,
  hasPlanets: false,
  hasMissions: false,
  mineResources: null,
  hostileCount: 1,
  nodeSizes: null,
  hazardLevel: null,
  gameId: 1244614683,
  source: "cdn:game-data",
  license: "CC-BY-NC 4.0",
  attribution: "STFC community data",
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
    getHostile: vi.fn().mockResolvedValue(FIXTURE_HOSTILE),
    searchHostiles: vi.fn().mockResolvedValue([FIXTURE_HOSTILE]),
    getSystem: vi.fn().mockImplementation(async (id: string) => {
      if (id === FIXTURE_SYSTEM.id) return FIXTURE_SYSTEM;
      if (id === "cdn:system:1181687125") return { ...FIXTURE_SYSTEM, id, name: "Krona Rift", gameId: 1181687125 };
      return null;
    }),
    searchSystems: vi.fn().mockResolvedValue([FIXTURE_SYSTEM]),
    upsertShip: vi.fn(),
    deleteShip: vi.fn(),
    bulkUpsertOfficers: vi.fn(),
    bulkUpsertShips: vi.fn(),
    listSystemsByResource: vi.fn().mockResolvedValue([]),
    searchSystemsByMining: vi.fn().mockResolvedValue([]),
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
    recordDelta: vi.fn(),
    listDeltas: vi.fn().mockResolvedValue([]),
    recordReminderFeedback: vi.fn(),
    listReminderFeedback: vi.fn().mockResolvedValue([]),
    recordGoalRestatement: vi.fn(),
    listGoalRestatements: vi.fn().mockResolvedValue([]),
    listByRef: vi.fn(),
    counts: vi.fn().mockResolvedValue({
      total: 3, active: 2, achieved: 1, abandoned: 0,
      byType: { officer: 1, ship: 1, crew: 1 },
    }),
    close: vi.fn(),
    ...overrides,
  } as unknown as TargetStore;
}

function createMockReceiptStore(overrides: Partial<ReceiptStore> = {}): ReceiptStore {
  return {
    createReceipt: vi.fn().mockResolvedValue({
      id: 1,
      sourceType: "guided_setup",
      sourceMeta: {},
      mapping: null,
      layer: "ownership",
      changeset: {},
      inverse: {},
      unresolved: null,
      createdAt: "2026-01-01T00:00:00Z",
    }),
    listReceipts: vi.fn().mockResolvedValue([]),
    getReceipt: vi.fn().mockResolvedValue(null),
    undoReceipt: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    resolveReceiptItems: vi.fn(),
    counts: vi.fn().mockResolvedValue({ total: 0 }),
    close: vi.fn(),
    ...overrides,
  } as ReceiptStore;
}

function createMockResearchStore(overrides: Partial<ResearchStore> = {}): ResearchStore {
  return {
    replaceSnapshot: vi.fn().mockResolvedValue({ nodes: 2, trees: 1 }),
    listNodes: vi.fn().mockResolvedValue([
      {
        nodeId: "combat.weapon.damage.t4",
        tree: "combat",
        name: "Weapon Damage",
        maxLevel: 10,
        dependencies: [],
        buffs: [{ kind: "combat", metric: "weapon_damage", value: 0.15, unit: "percent" }],
        level: 4,
        completed: false,
        stateUpdatedAt: null,
        source: "ripper-cc",
        capturedAt: "2026-02-18T00:00:00Z",
        updatedAt: "2026-02-18T00:00:00Z",
      },
    ]),
    listByTree: vi.fn().mockResolvedValue([
      {
        tree: "combat",
        nodes: [
          {
            nodeId: "combat.weapon.damage.t4",
            tree: "combat",
            name: "Weapon Damage",
            maxLevel: 10,
            dependencies: [],
            buffs: [{ kind: "combat", metric: "weapon_damage", value: 0.15, unit: "percent" }],
            level: 4,
            completed: false,
            stateUpdatedAt: null,
            source: "ripper-cc",
            capturedAt: "2026-02-18T00:00:00Z",
            updatedAt: "2026-02-18T00:00:00Z",
          },
        ],
        totals: { nodes: 1, completed: 0, inProgress: 1, avgCompletionPct: 40 },
      },
    ]),
    counts: vi.fn().mockResolvedValue({ nodes: 1, trees: 1, completed: 0 }),
    close: vi.fn(),
    ...overrides,
  } as ResearchStore;
}

function createMockInventoryStore(overrides: Partial<InventoryStore> = {}): InventoryStore {
  return {
    upsertItems: vi.fn().mockResolvedValue({ upserted: 2, categories: 2 }),
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
    ]),
    listByCategory: vi.fn().mockResolvedValue([
      {
        category: "ore",
        items: [
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
        ],
        totals: { itemCount: 1, totalQuantity: 280 },
      },
    ]),
    counts: vi.fn().mockResolvedValue({ items: 1, categories: 1 }),
    close: vi.fn(),
    ...overrides,
  } as unknown as InventoryStore;
}

// ─── Tool Declarations ──────────────────────────────────────

describe("FLEET_TOOL_DECLARATIONS", () => {
  it("exports an array of tool declarations", () => {
    expect(Array.isArray(FLEET_TOOL_DECLARATIONS)).toBe(true);
    expect(FLEET_TOOL_DECLARATIONS.length).toBeGreaterThanOrEqual(29);
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
    expect(names).toContain("list_research");
    expect(names).toContain("list_inventory");
    expect(names).toContain("list_active_events");
    expect(names).toContain("list_away_teams");
    expect(names).toContain("get_faction_standing");
    expect(names).toContain("calculate_upgrade_path");
    expect(names).toContain("estimate_acquisition_time");
    expect(names).toContain("calculate_true_power");
    expect(names).toContain("find_loadouts_for_intent");
    // Analysis tools
    expect(names).toContain("suggest_crew");
    expect(names).toContain("analyze_battle_log");
    expect(names).toContain("suggest_counter");
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

  it("includes target mutation tools (#80)", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("create_target");
    expect(names).toContain("update_target");
    expect(names).toContain("complete_target");
    expect(names).toContain("record_target_delta");
    expect(names).toContain("record_reminder_feedback");
    expect(names).toContain("record_goal_restatement");
  });

  it("includes agent experience metrics read tool", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("get_agent_experience_metrics");
  });

  it("includes overlay mutation tools", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("sync_overlay");
    expect(names).toContain("sync_research");
    expect(names).toContain("set_ship_overlay");
    expect(names).toContain("set_officer_overlay");
  });

  it("includes inventory mutation tools (#75)", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("update_inventory");
  });

  it("includes web_lookup tool with required domain/query params", () => {
    const names = FLEET_TOOL_DECLARATIONS.map((t) => t.name);
    expect(names).toContain("web_lookup");

    const lookup = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "web_lookup");
    expect(lookup?.parameters?.required).toContain("domain");
    expect(lookup?.parameters?.required).toContain("query");

    const domainEnum = (lookup?.parameters?.properties?.domain as { enum?: string[] } | undefined)?.enum ?? [];
    expect(domainEnum).toContain("stfc.space");
    expect(domainEnum).toContain("spocks.club");
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

  it("sync_overlay export parameter has nested officer/ship/dock schema", () => {
    const syncOverlay = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "sync_overlay");
    expect(syncOverlay).toBeDefined();

    const exportParam = syncOverlay!.parameters?.properties?.export as Record<string, unknown>;
    expect(exportParam).toBeDefined();

    const props = exportParam.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props.version).toBeDefined();
    expect(props.source).toBeDefined();

    // Officers array with item schema
    const officers = props.officers as Record<string, unknown>;
    expect(officers).toBeDefined();
    const officerItems = officers.items as Record<string, unknown>;
    expect(officerItems).toBeDefined();
    const officerProps = officerItems.properties as Record<string, unknown>;
    expect(officerProps.refId).toBeDefined();
    expect(officerProps.level).toBeDefined();
    expect(officerProps.rank).toBeDefined();
    expect(officerProps.owned).toBeDefined();
    expect(officerProps.power).toBeDefined();

    // Ships array with item schema
    const ships = props.ships as Record<string, unknown>;
    expect(ships).toBeDefined();
    const shipItems = ships.items as Record<string, unknown>;
    expect(shipItems).toBeDefined();
    const shipProps = shipItems.properties as Record<string, unknown>;
    expect(shipProps.refId).toBeDefined();
    expect(shipProps.tier).toBeDefined();
    expect(shipProps.level).toBeDefined();
    expect(shipProps.owned).toBeDefined();

    // Docks array with item schema
    const docksProp = props.docks as Record<string, unknown>;
    expect(docksProp).toBeDefined();
    const dockItems = docksProp.items as Record<string, unknown>;
    expect(dockItems).toBeDefined();
    const dockProps = dockItems.properties as Record<string, unknown>;
    expect(dockProps.number).toBeDefined();
    expect(dockProps.shipId).toBeDefined();
    expect(dockProps.loadoutId).toBeDefined();
  });

  it("set_officer_overlay description references sync_overlay for bulk", () => {
    const tool = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "set_officer_overlay");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("sync_overlay");
  });

  it("set_ship_overlay description references sync_overlay for bulk", () => {
    const tool = FLEET_TOOL_DECLARATIONS.find((t) => t.name === "set_ship_overlay");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("sync_overlay");
  });
});

// ─── Tool Executor ──────────────────────────────────────────

describe("executeFleetTool", () => {
  it("returns error for unknown tool", async () => {
    const result = await executeFleetTool("nonexistent_tool", {}, toolEnv());
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Unknown tool");
  });

  it("catches exceptions and returns error object", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        counts: vi.fn().mockRejectedValue(new Error("DB connection lost")),
      }),
    });
    const result = await executeFleetTool("get_fleet_overview", {}, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("DB connection lost");
  });
});


// ─── User Isolation & Thread Safety ─────────────────────────

describe("user isolation — scoped stores", () => {
  const USER_A = "user-alpha";
  const USER_B = "user-bravo";

  it("sync_overlay passes userId through to receipt store metadata", async () => {
    const createReceipt = vi.fn().mockResolvedValue({
      id: 42,
      sourceType: "guided_setup",
      sourceMeta: {},
      mapping: null,
      layer: "ownership",
      changeset: {},
      inverse: {},
      unresolved: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1",
      ownershipState: "owned",
      target: false,
      tier: 5,
      level: 20,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx = toolEnv({
      userId: USER_A,
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP, id: "cdn:ship:1", name: "Enterprise" }),
      }),
      receiptStore: createMockReceiptStore({ createReceipt }),
    });

    await executeFleetTool("sync_overlay", {
      export: { version: "1.0", ships: [{ refId: "cdn:ship:1", tier: 5, owned: true }] },
      dry_run: false,
    }, ctx);

    expect(createReceipt).toHaveBeenCalledTimes(1);
    const receiptInput = createReceipt.mock.calls[0][0];
    expect(receiptInput.sourceMeta.userId).toBe(USER_A);
  });

  it("two user contexts get independent overlay reads", async () => {
    // getFleetOverview calls overlayStore.counts() — override that to differ per user
    const overlayA = createMockOverlayStore({
      counts: vi.fn().mockResolvedValue({
        officers: { total: 10, owned: 5, unowned: 3, unknown: 2, targeted: 1 },
        ships: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
      }),
    });

    const overlayB = createMockOverlayStore({
      counts: vi.fn().mockResolvedValue({
        officers: { total: 0, owned: 0, unowned: 0, unknown: 0, targeted: 0 },
        ships: { total: 8, owned: 4, unowned: 2, unknown: 2, targeted: 3 },
      }),
    });

    const ctxA = toolEnv({
      userId: USER_A,
      overlayStore: overlayA,
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore(),
      targetStore: createMockTargetStore(),
      receiptStore: createMockReceiptStore(),
      researchStore: createMockResearchStore(),
      inventoryStore: createMockInventoryStore(),
    });

    const ctxB = toolEnv({
      userId: USER_B,
      overlayStore: overlayB,
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore(),
      targetStore: createMockTargetStore(),
      receiptStore: createMockReceiptStore(),
      researchStore: createMockResearchStore(),
      inventoryStore: createMockInventoryStore(),
    });

    const resultA = await executeFleetTool("get_fleet_overview", {}, ctxA) as Record<string, unknown>;
    const resultB = await executeFleetTool("get_fleet_overview", {}, ctxB) as Record<string, unknown>;

    // User A has officer overlays, no ship overlays
    const overlaysA = resultA.overlays as Record<string, unknown>;
    expect((overlaysA.officers as Record<string, unknown>).total).toBe(10);
    expect((overlaysA.ships as Record<string, unknown>).total).toBe(0);

    // User B has ship overlays, no officer overlays
    const overlaysB = resultB.overlays as Record<string, unknown>;
    expect((overlaysB.officers as Record<string, unknown>).total).toBe(0);
    expect((overlaysB.ships as Record<string, unknown>).total).toBe(8);
  });

  it("two user contexts write to independent overlay stores", async () => {
    const setShipA = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1", ownershipState: "owned", target: false,
      tier: 5, level: 20, power: null, targetNote: null, targetPriority: null,
      updatedAt: "2026-01-01",
    });
    const setShipB = vi.fn().mockResolvedValue({
      refId: "cdn:ship:2", ownershipState: "owned", target: false,
      tier: 3, level: 10, power: null, targetNote: null, targetPriority: null,
      updatedAt: "2026-01-01",
    });

    const ctxA = toolEnv({
      userId: USER_A,
      overlayStore: createMockOverlayStore({ setShipOverlay: setShipA }),
      referenceStore: createMockReferenceStore(),
    });
    const ctxB = toolEnv({
      userId: USER_B,
      overlayStore: createMockOverlayStore({ setShipOverlay: setShipB }),
      referenceStore: createMockReferenceStore(),
    });

    await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:1", tier: 5,
    }, ctxA);
    await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:2", tier: 3,
    }, ctxB);

    // Each store was called independently; no cross-contamination
    expect(setShipA).toHaveBeenCalledTimes(1);
    expect(setShipB).toHaveBeenCalledTimes(1);
    expect((setShipA.mock.calls[0][0] as Record<string, unknown>).refId).toBe("cdn:ship:1");
    expect((setShipB.mock.calls[0][0] as Record<string, unknown>).refId).toBe("cdn:ship:2");
  });

  it("two user contexts write to independent target stores", async () => {
    const createA = vi.fn().mockResolvedValue({
      id: 1, refId: "officer-kirk", targetType: "officer", status: "active",
      ownershipGoal: "acquire", priority: 2, reason: "need Kirk",
      isActive: true, source: "manual", notes: null,
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });
    const createB = vi.fn().mockResolvedValue({
      id: 2, refId: "ship-enterprise", targetType: "ship", status: "active",
      ownershipGoal: "acquire", priority: 1, reason: "need ship",
      isActive: true, source: "manual", notes: null,
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    });

    const ctxA = toolEnv({
      userId: USER_A,
      targetStore: createMockTargetStore({
        create: createA,
        listByRef: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore(),
    });
    const ctxB = toolEnv({
      userId: USER_B,
      targetStore: createMockTargetStore({
        create: createB,
        listByRef: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore(),
    });

    await executeFleetTool("create_target", {
      ref_id: "officer-kirk", target_type: "officer",
      ownership_goal: "acquire", reason: "need Kirk",
    }, ctxA);
    await executeFleetTool("create_target", {
      ref_id: "ship-enterprise", target_type: "ship",
      ownership_goal: "acquire", reason: "need ship",
    }, ctxB);

    expect(createA).toHaveBeenCalledTimes(1);
    expect(createB).toHaveBeenCalledTimes(1);
    // User A's target store never sees User B's data and vice versa
    expect(createA.mock.calls[0][0].refId).toBe("officer-kirk");
    expect(createB.mock.calls[0][0].refId).toBe("ship-enterprise");
  });

  it("two user contexts read independent research stores", async () => {
    // listResearch calls researchStore.listByTree() — override that per user
    const researchA = createMockResearchStore({
      listByTree: vi.fn().mockResolvedValue([
        {
          tree: "combat",
          nodes: [{ nodeId: "c1", tree: "combat", name: "Weapons", maxLevel: 10, dependencies: [], buffs: [], level: 5, completed: false, stateUpdatedAt: null, source: "manual", capturedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
          totals: { nodes: 1, completed: 0, inProgress: 1, avgCompletionPct: 50 },
        },
      ]),
      counts: vi.fn().mockResolvedValue({ nodes: 1, trees: 1, completed: 0 }),
    });
    const researchB = createMockResearchStore({
      listByTree: vi.fn().mockResolvedValue([
        {
          tree: "galaxy",
          nodes: [{ nodeId: "g1", tree: "galaxy", name: "Warp Speed", maxLevel: 8, dependencies: [], buffs: [], level: 3, completed: false, stateUpdatedAt: null, source: "manual", capturedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
          totals: { nodes: 1, completed: 0, inProgress: 1, avgCompletionPct: 37.5 },
        },
      ]),
      counts: vi.fn().mockResolvedValue({ nodes: 1, trees: 1, completed: 0 }),
    });

    const ctxA = toolEnv({ userId: USER_A, researchStore: researchA });
    const ctxB = toolEnv({ userId: USER_B, researchStore: researchB });

    const resultA = await executeFleetTool("list_research", {}, ctxA) as Record<string, unknown>;
    const resultB = await executeFleetTool("list_research", {}, ctxB) as Record<string, unknown>;

    const treesA = (resultA as any).trees;
    const treesB = (resultB as any).trees;
    expect(treesA[0].tree).toBe("combat");
    expect(treesB[0].tree).toBe("galaxy");
  });

  it("two user contexts read independent inventory stores", async () => {
    // listInventory calls inventoryStore.listByCategory() — override that per user
    const inventoryA = createMockInventoryStore({
      listByCategory: vi.fn().mockResolvedValue([
        {
          category: "ore",
          items: [{ id: 1, category: "ore", name: "3★ Ore", grade: "3-star", quantity: 500, unit: null, source: "manual", capturedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
          totals: { itemCount: 1, totalQuantity: 500 },
        },
      ]),
      counts: vi.fn().mockResolvedValue({ items: 1, categories: 1 }),
    });
    const inventoryB = createMockInventoryStore({
      listByCategory: vi.fn().mockResolvedValue([
        {
          category: "gas",
          items: [{ id: 2, category: "gas", name: "3★ Gas", grade: "3-star", quantity: 200, unit: null, source: "manual", capturedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
          totals: { itemCount: 1, totalQuantity: 200 },
        },
      ]),
      counts: vi.fn().mockResolvedValue({ items: 1, categories: 1 }),
    });

    const ctxA = toolEnv({ userId: USER_A, inventoryStore: inventoryA });
    const ctxB = toolEnv({ userId: USER_B, inventoryStore: inventoryB });

    const resultA = await executeFleetTool("list_inventory", {}, ctxA) as Record<string, unknown>;
    const resultB = await executeFleetTool("list_inventory", {}, ctxB) as Record<string, unknown>;

    const categoriesA = (resultA as any).categories;
    const categoriesB = (resultB as any).categories;
    expect(categoriesA).toHaveLength(1);
    expect(categoriesA[0].category).toBe("ore");
    expect(categoriesB).toHaveLength(1);
    expect(categoriesB[0].category).toBe("gas");
  });
});

describe("user isolation — crew store & receipt store (resolved: #94)", () => {
  // #94 landed user-scoped CrewStore + ReceiptStore with RLS + factory pattern.
  // Each user context now gets an independent scoped store via forUser().
  // These tests verify that separate contexts use separate store instances.

  it("crew store: separate users get independent scoped instances", async () => {
    const crewStoreA = createMockCrewStore();
    const crewStoreB = createMockCrewStore();

    const ctxA = toolEnv({ userId: "user-alpha", crewStore: crewStoreA });
    const ctxB = toolEnv({ userId: "user-bravo", crewStore: crewStoreB });

    await executeFleetTool("list_docks", {}, ctxA);
    await executeFleetTool("list_docks", {}, ctxB);

    // Each user's store is called independently — isolation enforced by factory + RLS
    expect(crewStoreA.getEffectiveDockState).toHaveBeenCalledTimes(1);
    expect(crewStoreB.getEffectiveDockState).toHaveBeenCalledTimes(1);
  });

  it("receipt store: separate users get independent scoped instances", async () => {
    const receiptStoreA = createMockReceiptStore();
    const receiptStoreB = createMockReceiptStore();

    const setShipOverlayA = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1", ownershipState: "owned", target: false,
      tier: 5, level: 20, power: null, targetNote: null, targetPriority: null,
      updatedAt: "2026-01-01",
    });

    const ctxA = toolEnv({
      userId: "user-alpha",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay: setShipOverlayA,
      }),
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP, id: "cdn:ship:1" }),
      }),
      receiptStore: receiptStoreA,
    });
    const ctxB = toolEnv({
      userId: "user-bravo",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay: vi.fn().mockResolvedValue({
          refId: "cdn:ship:2", ownershipState: "owned", target: false,
          tier: 3, level: 10, power: null, targetNote: null, targetPriority: null,
          updatedAt: "2026-01-01",
        }),
      }),
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP, id: "cdn:ship:2" }),
      }),
      receiptStore: receiptStoreB,
    });

    await executeFleetTool("sync_overlay", {
      export: { version: "1.0", ships: [{ refId: "cdn:ship:1", tier: 5, owned: true }] },
      dry_run: false,
    }, ctxA);
    await executeFleetTool("sync_overlay", {
      export: { version: "1.0", ships: [{ refId: "cdn:ship:2", tier: 3, owned: true }] },
      dry_run: false,
    }, ctxB);

    // Each user's receipt store receives exactly one receipt — isolation enforced
    expect(receiptStoreA.createReceipt).toHaveBeenCalledTimes(1);
    expect(receiptStoreB.createReceipt).toHaveBeenCalledTimes(1);

    // userId embedded in receipt metadata for traceability
    const callA = (receiptStoreA.createReceipt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const callB = (receiptStoreB.createReceipt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callA.sourceMeta.userId).toBe("user-alpha");
    expect(callB.sourceMeta.userId).toBe("user-bravo");
  });
});
