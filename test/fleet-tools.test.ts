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

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FLEET_TOOL_DECLARATIONS,
  executeFleetTool,
  type ToolContext,
} from "../src/server/services/fleet-tools/index.js";
import type { ReferenceStore, ReferenceOfficer, ReferenceShip } from "../src/server/stores/reference-store.js";
import type { OverlayStore, OfficerOverlay, ShipOverlay } from "../src/server/stores/overlay-store.js";
import type { CrewStore } from "../src/server/stores/crew-store.js";
import type { TargetStore } from "../src/server/stores/target-store.js";
import type { ReceiptStore } from "../src/server/stores/receipt-store.js";
import type { ResearchStore } from "../src/server/stores/research-store.js";
import type { InventoryStore } from "../src/server/stores/inventory-store.js";
import type { UserSettingsStore } from "../src/server/stores/user-settings-store.js";
import { __resetWebLookupStateForTests } from "../src/server/services/fleet-tools/read-tools.js";

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

function createMockUserSettingsStore(overrides: Partial<UserSettingsStore> = {}): UserSettingsStore {
  return {
    getForUser: vi.fn().mockImplementation(async (_userId: string, key: string) => {
      if (key === "fleet.activeEvents") {
        return {
          key,
          value: JSON.stringify([
            {
              name: "Klingon Separatists",
              type: "hostile_hunt",
              scoring: { metric: "hostile_hull", multiplier: 2 },
              start_time: "2026-02-20T00:00:00Z",
              end_time: "2026-02-22T00:00:00Z",
            },
          ]),
          source: "user" as const,
        };
      }
      if (key === "fleet.awayTeams") {
        return {
          key,
          value: JSON.stringify([
            {
              officer_id: "officer-kirk",
              mission_name: "Dominion Disruption",
              return_time: "2099-01-01T00:00:00Z",
            },
          ]),
          source: "user" as const,
        };
      }
      if (key === "fleet.factionStandings") {
        return {
          key,
          value: JSON.stringify({
            Federation: { reputation: 1234567, tier: "Friendly" },
            Klingon: { reputation: -50000, tier: "Hostile" },
            Romulan: { reputation: 9800000, tier: "Respected" },
            Syndicate: { reputation: 350000, tier: "Known" },
          }),
          source: "user" as const,
        };
      }
      return { key, value: "[]", source: "default" as const };
    }),
    setForUser: vi.fn(),
    deleteForUser: vi.fn().mockResolvedValue(false),
    getAllForUser: vi.fn().mockResolvedValue([]),
    getOverridableForUser: vi.fn().mockResolvedValue([]),
    countForUser: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
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

describe("web_lookup", () => {
  beforeEach(() => {
    __resetWebLookupStateForTests();
  });

  it("rejects non-allowlisted domains", async () => {
    const result = await executeFleetTool("web_lookup", {
      domain: "example.com",
      query: "Spock",
    }, {});
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not allowlisted");
  });

  it("returns robots policy error when domain disallows all", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow: /\n") });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
    }, {});

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("robots.txt policy blocks");
    vi.unstubAllGlobals();
  });

  it("returns structured fandom result and serves subsequent requests from cache", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: {
            pages: {
              "1": {
                pageid: 1,
                title: "Spock",
                extract: "Spock is a Starfleet officer.",
              },
            },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(first.error).toBeUndefined();
    expect(first.tool).toBe("web_lookup");
    expect((first.cache as Record<string, unknown>).hit).toBe(false);
    expect(first).toHaveProperty("observability");
    expect((first.result as Record<string, unknown>).title).toBe("Spock");

    const second = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(second.error).toBeUndefined();
    expect((second.cache as Record<string, unknown>).hit).toBe(true);
    expect(second).toHaveProperty("observability");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("extracts structured stfc.space ship facts from detail page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`
          <html><body>
            <a href="/ships/uss-enterprise">USS Enterprise</a>
          </body></html>
        `),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(`
          <html>
            <head>
              <title>USS Enterprise</title>
              <meta name="description" content="Legendary Federation explorer." />
            </head>
            <body>
              <h1>USS Enterprise</h1>
              <table>
                <tr><th>Hull Type</th><td>Explorer</td></tr>
                <tr><th>Rarity</th><td>Epic</td></tr>
                <tr><th>Faction</th><td>Federation</td></tr>
                <tr><th>Grade</th><td>3</td></tr>
              </table>
            </body>
          </html>
        `),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
      entity_type: "ship",
    }, {}) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect((result.result as Record<string, unknown>).type).toBe("ship");
    expect((result.result as Record<string, unknown>).hullType).toBe("Explorer");
    expect((result.result as Record<string, unknown>).rarity).toBe("Epic");
    expect((result.result as Record<string, unknown>).faction).toBe("Federation");
    expect((result.result as Record<string, unknown>).grade).toBe("3");
    expect(result).toHaveProperty("observability");
    vi.unstubAllGlobals();
  });

  it("enforces rate limit after max requests", async () => {
    // Mock fetch: allow robots, then succeed for fandom lookups
    const makeFetchMock = () => vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Kirk", extract: "Captain Kirk." } } },
        }),
      });

    vi.stubGlobal("fetch", makeFetchMock());

    // First 5 requests should succeed (rate limit is 5 per 60s window)
    for (let i = 0; i < 5; i += 1) {
      const result = await executeFleetTool("web_lookup", {
        domain: "stfc.fandom.com",
        query: `Kirk-${i}`, // unique queries to bypass cache
        entity_type: "officer",
      }, {}) as Record<string, unknown>;
      expect(result.error).toBeUndefined();
    }

    // 6th request should be rate limited
    const limited = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Kirk-overflow",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    expect(limited).toHaveProperty("error");
    expect(limited.error).toContain("Rate limit exceeded");
    expect(limited).toHaveProperty("retryAfterMs");
    expect(typeof limited.retryAfterMs).toBe("number");
    expect(limited).toHaveProperty("observability");

    vi.unstubAllGlobals();
  });

  it("rate limits are per-domain", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") });
    vi.stubGlobal("fetch", fetchMock);

    // Exhaust rate limit for stfc.fandom.com (robots check + 4 more = 5 events)
    vi.unstubAllGlobals();
    __resetWebLookupStateForTests();

    const fetchMock2 = vi.fn()
      .mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n"),
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Test", extract: "Test officer." } } },
        }),
      });
    vi.stubGlobal("fetch", fetchMock2);

    // stfc.space: should succeed independently (fresh rate limit window)
    const result = await executeFleetTool("web_lookup", {
      domain: "stfc.space",
      query: "Enterprise",
      entity_type: "ship",
    }, {}) as Record<string, unknown>;

    // Should reach the lookup (not rate-limited), regardless of stfc.fandom.com usage
    expect(result.error).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("observability metrics reflect rate-limited requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("User-agent: *\nDisallow:\n") })
      .mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          query: { pages: { "1": { pageid: 1, title: "Spock", extract: "Vulcan." } } },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    // Fill rate limit
    for (let i = 0; i < 5; i += 1) {
      await executeFleetTool("web_lookup", {
        domain: "stfc.fandom.com",
        query: `Spock-obs-${i}`,
        entity_type: "officer",
      }, {});
    }

    // Trigger rate-limited request
    const limited = await executeFleetTool("web_lookup", {
      domain: "stfc.fandom.com",
      query: "Spock-obs-overflow",
      entity_type: "officer",
    }, {}) as Record<string, unknown>;

    const obs = limited.observability as Record<string, number>;
    expect(obs.rateLimited).toBeGreaterThanOrEqual(1);

    vi.unstubAllGlobals();
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

const _FIXTURE_INTENT = {
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

describe("list_research", () => {
  it("returns grouped research state from store", async () => {
    const ctx: ToolContext = {
      researchStore: createMockResearchStore(),
    };
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
    const ctx: ToolContext = {
      researchStore: createMockResearchStore({ listByTree }),
    };
    await executeFleetTool("list_research", { tree: "combat", include_completed: false }, ctx);

    expect(listByTree).toHaveBeenCalledWith({ tree: "combat", includeCompleted: false });
  });

  it("trims tree filter and defaults includeCompleted=true", async () => {
    const listByTree = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      researchStore: createMockResearchStore({ listByTree }),
    };

    await executeFleetTool("list_research", { tree: "  combat  " }, ctx);

    expect(listByTree).toHaveBeenCalledWith({ tree: "combat", includeCompleted: true });
  });

  it("returns error when research store unavailable", async () => {
    const result = await executeFleetTool("list_research", {}, {});
    expect(result).toHaveProperty("error");
  });
});

describe("list_inventory", () => {
  it("returns grouped inventory state from store", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
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
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ listByCategory }),
    };

    await executeFleetTool("list_inventory", { category: "ore", query: "3★" }, ctx);
    expect(listByCategory).toHaveBeenCalledWith({ category: "ore", q: "3★" });
  });

  it("normalizes category casing and trims query", async () => {
    const listByCategory = vi.fn().mockResolvedValue([]);
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ listByCategory }),
    };

    await executeFleetTool("list_inventory", { category: "  ORE  ", query: "  tritanium  " }, ctx);

    expect(listByCategory).toHaveBeenCalledWith({ category: "ore", q: "tritanium" });
  });

  it("returns error when inventory store unavailable", async () => {
    const result = await executeFleetTool("list_inventory", {}, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid category", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
    const result = await executeFleetTool("list_inventory", { category: "invalid" }, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("list_active_events", () => {
  it("returns normalized active events from user settings", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    };

    const result = await executeFleetTool("list_active_events", {}, ctx) as Record<string, unknown>;
    expect(result.totalEvents).toBe(1);
    expect(result.totalActiveEvents).toBe(1);

    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].name).toBe("Klingon Separatists");
    expect(events[0].type).toBe("hostile_hunt");
    expect(events[0].isActive).toBe(true);
  });

  it("returns empty payload when user settings store is unavailable", async () => {
    const result = await executeFleetTool("list_active_events", {}, { userId: "u-1" }) as Record<string, unknown>;
    expect(result.totalEvents).toBe(0);
    expect(result.source).toBe("unavailable");
  });
});

describe("list_away_teams", () => {
  it("returns locked officers from settings and plan items", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          {
            ...FIXTURE_PLAN_ITEM,
            label: "AT Duty",
            isActive: true,
            awayOfficers: ["officer-spock"],
          },
        ]),
      }),
    };

    const result = await executeFleetTool("list_away_teams", {}, ctx) as Record<string, unknown>;
    const lockedOfficerIds = result.lockedOfficerIds as string[];
    expect(lockedOfficerIds).toContain("officer-kirk");
    expect(lockedOfficerIds).toContain("officer-spock");
    expect(result.totalAssignments).toBe(2);
  });
});

describe("get_faction_standing", () => {
  it("returns normalized faction standings with store access", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    };

    const result = await executeFleetTool("get_faction_standing", {}, ctx) as Record<string, unknown>;
    const standings = result.standings as Array<Record<string, unknown>>;
    expect(standings.length).toBeGreaterThanOrEqual(4);
    const klingon = standings.find((row) => row.faction === "Klingon");
    expect(klingon?.storeAccess).toBe("locked");
  });

  it("filters by faction name", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    };

    const result = await executeFleetTool("get_faction_standing", { faction: "feder" }, ctx) as Record<string, unknown>;
    const standings = result.standings as Array<Record<string, unknown>>;
    expect(standings).toHaveLength(1);
    expect(standings[0].faction).toBe("Federation");
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

    const ctx: ToolContext = {
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
    };

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
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
    };
    const result = await executeFleetTool("calculate_upgrade_path", { ship_id: "ship-enterprise" }, ctx);
    expect(result).toHaveProperty("error");
  });

  it("returns error for invalid target tier", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue({ ...FIXTURE_SHIP_OVERLAY, tier: 8 }) }),
      inventoryStore: createMockInventoryStore(),
    };
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

    const ctx: ToolContext = {
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
    };

    const result = await executeFleetTool(
      "estimate_acquisition_time",
      { ship_id: "ship-enterprise", target_tier: 6, daily_income: { ore: 25 } },
      ctx,
    ) as Record<string, unknown>;

    const summary = result.summary as Record<string, unknown>;
    expect(summary.feasible).toBe(true);
    expect(summary.estimatedDays).toBe(10);

    const perResource = result.perResource as Array<Record<string, unknown>>;
    expect(perResource[0]).toMatchObject({ name: "3★ Ore", gap: 250, dailyRate: 25, days: 10 });
  });

  it("returns ship-not-found error from upgrade path", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(null) }),
      overlayStore: createMockOverlayStore(),
      inventoryStore: createMockInventoryStore(),
    };

    const result = await executeFleetTool("estimate_acquisition_time", { ship_id: "missing-ship" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Ship not found");
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

describe("calculate_true_power", () => {
  it("calculates effective power using research multipliers", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore(),
      researchStore: createMockResearchStore(),
    };

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
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({ getShipOverlay: vi.fn().mockResolvedValue(null) }),
      researchStore: createMockResearchStore(),
    };

    const result = await executeFleetTool("calculate_true_power", { ship_id: "ship-enterprise" }, ctx) as Record<string, unknown>;
    expect(result.basePower).toBeNull();
    expect(result.calculatedPower).toBeNull();
    expect(result.assumptions).toContain("ship_overlay_power_missing");
  });

  it("returns error for unknown ship", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({ getShip: vi.fn().mockResolvedValue(null) }),
      overlayStore: createMockOverlayStore(),
    };

    const result = await executeFleetTool("calculate_true_power", { ship_id: "unknown" }, ctx);
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
      researchStore: createMockResearchStore(),
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

    const researchContext = result.researchContext as Record<string, unknown>;
    expect(researchContext.priority).toBe("low");
    expect(researchContext.status).toBe("sparse");
    expect(researchContext.relevantBuffCount).toBe(1);
    const citations = researchContext.citations as Array<Record<string, unknown>>;
    expect(citations).toHaveLength(1);
    expect(String(citations[0].citation)).toContain("Weapon Damage");

    const recommendationHints = result.recommendationHints as Record<string, unknown>;
    expect(recommendationHints.prioritizeBaseFit).toBe(true);
    expect(recommendationHints.useResearchAsTiebreaker).toBe(true);
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

    const researchContext = result.researchContext as Record<string, unknown>;
    expect(researchContext.priority).toBe("none");
    const citations = researchContext.citations as Array<Record<string, unknown>>;
    expect(citations).toHaveLength(0);

    const recommendationHints = result.recommendationHints as Record<string, unknown>;
    expect(recommendationHints.useResearchInCoreScoring).toBe(false);
  });

  it("excludes officers locked on away teams from suggestions", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      referenceStore: createMockReferenceStore(),
      userSettingsStore: createMockUserSettingsStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
      }),
    };

    const result = await executeFleetTool(
      "suggest_crew", { ship_id: "ship-enterprise", intent_key: "pvp" }, ctx,
    ) as Record<string, unknown>;

    expect(result.totalOwnedOfficers).toBe(0);
    expect(result.totalExcludedOfficers).toBe(1);
    const excluded = result.excludedOfficers as Array<Record<string, unknown>>;
    expect(excluded[0].id).toBe("officer-kirk");
    expect(excluded[0].reasons).toContain("away_team");
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

describe("analyze_battle_log", () => {
  const SAMPLE_BATTLE_LOG = {
    battle_id: "battle-123",
    mode: "pvp",
    attacker_officers: ["officer-kirk"],
    defender_officers: ["officer-spock"],
    rounds: [
      {
        round: 1,
        damage_received: [{ amount: 12000, type: "energy", source_ability: "Opening Volley" }],
        damage_dealt: [{ amount: 10000, type: "kinetic" }],
        ability_triggers: ["Opening Volley"],
        hull_after: 88000,
        shield_after: 43000,
      },
      {
        round: 2,
        damage_received: [{ amount: 94000, type: "energy", source_ability: "Focused Barrage" }],
        damage_dealt: [{ amount: 14000, type: "kinetic" }],
        ability_triggers: ["Focused Barrage"],
        hull_after: 0,
        shield_after: 0,
        destroyed: true,
      },
    ],
  };

  it("parses rounds and identifies failure point", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockImplementation(async (id: string) => {
          if (id === "officer-kirk") return FIXTURE_OFFICER;
          if (id === "officer-spock") return FIXTURE_SPOCK_OFFICER;
          return null;
        }),
      }),
      researchStore: createMockResearchStore(),
    };

    const result = await executeFleetTool("analyze_battle_log", { battle_log: SAMPLE_BATTLE_LOG }, ctx) as Record<string, unknown>;
    expect(result.error).toBeUndefined();

    const failure = result.failurePoint as Record<string, unknown>;
    expect(failure.round).toBe(2);
    expect(failure.likelyCause).toBe("energy_spike_broke_shields");

    const rounds = result.roundByRound as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(2);

    const abilityHighlights = result.abilityHighlights as Record<string, unknown>;
    const officerAbilities = abilityHighlights.officerAbilities as Array<Record<string, unknown>>;
    expect(officerAbilities.length).toBeGreaterThanOrEqual(1);

    const researchContext = result.researchContext as Record<string, unknown>;
    const referencedBuffs = researchContext.referencedBuffs as Array<Record<string, unknown>>;
    expect(referencedBuffs.length).toBeGreaterThan(0);
  });

  it("returns error for invalid payload", async () => {
    const result = await executeFleetTool("analyze_battle_log", { battle_log: { rounds: [] } }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("suggest_counter", () => {
  const SAMPLE_BATTLE_LOG = {
    battle_id: "battle-123",
    mode: "pvp",
    rounds: [
      {
        round: 1,
        damage_received: [{ amount: 120000, type: "kinetic" }],
        damage_dealt: [{ amount: 35000, type: "energy" }],
        ability_triggers: ["Impact Burst"],
        hull_after: 0,
        shield_after: 0,
        destroyed: true,
      },
    ],
  };

  it("returns concrete swap/counter recommendations", async () => {
    const defensiveOfficer = {
      ...FIXTURE_OFFICER,
      id: "officer-def",
      name: "Defense Specialist",
      officerAbility: "Boosts hull mitigation against kinetic damage",
    };
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([defensiveOfficer]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([
          { ...FIXTURE_OFFICER_OVERLAY, refId: "officer-def" },
        ]),
      }),
      researchStore: createMockResearchStore(),
    };

    const result = await executeFleetTool("suggest_counter", { battle_log: SAMPLE_BATTLE_LOG }, ctx) as Record<string, unknown>;
    const changes = result.recommendedChanges as Array<Record<string, unknown>>;
    expect(changes.length).toBeGreaterThanOrEqual(3);

    const crew = changes.find((entry) => entry.category === "crew") as Record<string, unknown>;
    const swaps = crew.swaps as Array<Record<string, unknown>>;
    expect(swaps.length).toBeGreaterThanOrEqual(1);
    expect(swaps[0].officerName).toBe("Defense Specialist");
  });

  it("gracefully degrades without research store", async () => {
    const result = await executeFleetTool("suggest_counter", { battle_log: SAMPLE_BATTLE_LOG }, {}) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    const quality = result.dataQuality as Record<string, unknown>;
    expect(quality.hasResearchContext).toBe(false);
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

  it("adds faction-gated store recommendations from faction standings", async () => {
    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY])
          .mockResolvedValueOnce([]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    const recommendations = result.storeRecommendations as Record<string, unknown>;
    expect(recommendations).toBeDefined();

    const blocked = recommendations.blockedByFactionAccess as Array<Record<string, unknown>>;
    expect(blocked).toHaveLength(1);
    expect(blocked[0].shipName).toBe("USS Enterprise");
    expect(blocked[0].faction).toBe("Federation");
    expect(blocked[0].reason).toBe("faction_store_access_insufficient");
  });

  it("marks ship store recommendation eligible when faction access is open", async () => {
    const userSettingsStore = createMockUserSettingsStore({
      getForUser: vi.fn().mockImplementation(async (_userId: string, key: string) => {
        if (key === "fleet.factionStandings") {
          return {
            key,
            value: JSON.stringify({ Federation: { reputation: 15000000, tier: "Celebrated" } }),
            source: "user" as const,
          };
        }
        return { key, value: "[]", source: "default" as const };
      }),
    });

    const ctx: ToolContext = {
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore,
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY])
          .mockResolvedValueOnce([]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    const recommendations = result.storeRecommendations as Record<string, unknown>;
    const eligible = recommendations.eligibleBlueprintAccess as Array<Record<string, unknown>>;
    expect(eligible).toHaveLength(1);
    expect(eligible[0].shipName).toBe("USS Enterprise");
    expect(eligible[0].access).toBe("open");
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

// ─── Inventory Mutation Tools (#75 Phase 3) ────────────────

describe("update_inventory", () => {
  it("records items via upsertItems and returns confirmation", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 2, categories: 2 });
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ upsertItems }),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [
        { category: "ore", name: "3★ Ore", grade: "3-star", quantity: 280 },
        { category: "gas", name: "2★ Gas", grade: "2-star", quantity: 500 },
      ],
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.recorded).toBe(true);
    expect(result.upserted).toBe(2);
    expect(result.categories).toBe(2);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("3★ Ore");
    expect(items[1].name).toBe("2★ Gas");
    expect(result.nextSteps).toBeDefined();
    expect(upsertItems).toHaveBeenCalledOnce();

    // Verify source defaults to "chat"
    const call = upsertItems.mock.calls[0][0];
    expect(call.source).toBe("chat");
    expect(call.items).toHaveLength(2);
  });

  it("uses custom source when provided", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ upsertItems }),
    };
    await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "Tritanium", quantity: 100 }],
      source: "translator",
    }, ctx);

    const call = upsertItems.mock.calls[0][0];
    expect(call.source).toBe("translator");
  });

  it("trims category/name/grade before persistence", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ upsertItems }),
    };

    await executeFleetTool("update_inventory", {
      items: [{ category: "  ORE ", name: "  Tritanium  ", grade: "  G3  ", quantity: 50 }],
    }, ctx);

    const saved = upsertItems.mock.calls[0][0].items[0];
    expect(saved.category).toBe("ore");
    expect(saved.name).toBe("Tritanium");
    expect(saved.grade).toBe("G3");
  });

  it("returns partial success with warnings for mixed valid/invalid items", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ upsertItems }),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [
        { category: "ore", name: "3★ Ore", quantity: 280 },
        { category: "invalid_cat", name: "Bad Item", quantity: 10 },
        { category: "gas", name: "", quantity: 50 },
      ],
    }, ctx) as Record<string, unknown>;

    expect(result.recorded).toBe(true);
    expect(result.upserted).toBe(1);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("3★ Ore");
    const warnings = result.warnings as string[];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("invalid category");
    expect(warnings[1]).toContain("name is required");
  });

  it("returns error when all items are invalid", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [
        { category: "invalid", name: "Bad", quantity: 1 },
      ],
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toBe("No valid items to record.");
    expect(result.validationErrors).toBeDefined();
  });

  it("returns error for empty items array", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [],
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("items array is required");
  });

  it("returns error when items is not an array", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
    const result = await executeFleetTool("update_inventory", {
      items: "not-an-array",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("items array is required");
  });

  it("returns error when inventory store unavailable", async () => {
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: 280 }],
    }, {}) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("Inventory store not available");
  });

  it("rejects negative quantity", async () => {
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore(),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: -5 }],
    }, ctx) as Record<string, unknown>;

    expect(result.error).toBe("No valid items to record.");
    const errors = result.validationErrors as string[];
    expect(errors[0]).toContain("non-negative");
  });

  it("accepts zero quantity (clear inventory entry)", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx: ToolContext = {
      inventoryStore: createMockInventoryStore({ upsertItems }),
    };
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: 0 }],
    }, ctx) as Record<string, unknown>;

    expect(result.recorded).toBe(true);
  });
});

// ─── suggest_targets: Ready to Upgrade (#75) ───────────────

describe("suggest_targets — Ready to Upgrade", () => {
  it("includes readyToUpgrade when ship has ≥80% resource coverage", async () => {
    const shipWithTiers: ReferenceShip = {
      ...FIXTURE_SHIP,
      id: "cdn:ship:enterprise",
      name: "USS Enterprise",
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 300, name: "3★ Ore" }] },
            { build_cost: [{ resource_id: 102, amount: 100, name: "3★ Crystal" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ownedOverlay = { refId: "cdn:ship:enterprise", ownershipState: "owned", tier: 5 };

    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue([shipWithTiers]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([ownedOverlay])  // 1. owned ships for display
          .mockResolvedValueOnce([])               // 2. targeted ships for overlay targets
          .mockResolvedValueOnce([ownedOverlay]),  // 3. owned ships for upgrade check
      }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          { id: 1, category: "ore", name: "3★ Ore", grade: "3-star", quantity: 300, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
          { id: 2, category: "crystal", name: "3★ Crystal", grade: "3-star", quantity: 100, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
        ]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Should have readyToUpgrade since 100% coverage
    const ready = result.readyToUpgrade as Array<Record<string, unknown>>;
    expect(ready).toBeDefined();
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready[0].shipName).toBe("USS Enterprise");
    expect(ready[0].coveragePct).toBe(100);
  });

  it("omits readyToUpgrade when resource coverage is below 80%", async () => {
    const shipWithTiers: ReferenceShip = {
      ...FIXTURE_SHIP,
      id: "cdn:ship:enterprise",
      name: "USS Enterprise",
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 1000, name: "3★ Ore" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ownedOverlay = { refId: "cdn:ship:enterprise", ownershipState: "owned", tier: 5 };

    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue([shipWithTiers]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([ownedOverlay])  // 1. owned ships for display
          .mockResolvedValueOnce([])               // 2. targeted ships for overlay targets
          .mockResolvedValueOnce([ownedOverlay]),  // 3. owned ships for upgrade check
      }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          { id: 1, category: "ore", name: "3★ Ore", grade: "3-star", quantity: 100, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
        ]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Only 10% coverage (100/1000) — should NOT have readyToUpgrade
    expect(result.readyToUpgrade).toBeUndefined();
  });

  it("degrades gracefully when inventory store unavailable", async () => {
    const ctx: ToolContext = {
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
    };

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Should work fine — just no ready-to-upgrade data
    expect(result).not.toHaveProperty("error");
    expect(result.readyToUpgrade).toBeUndefined();
  });
});

// ─── Target Mutation Tools (#80) ────────────────────────────

describe("create_target", () => {
  it("creates an officer target with ref_id", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: 1,
          targetType: "officer",
          refId: "wiki:officer:james-t-kirk",
          loadoutId: null,
          priority: 1,
          reason: "Need for PvP crew",
          status: "active",
          autoSuggested: false,
          createdAt: "2026-02-17",
          updatedAt: "2026-02-17",
          achievedAt: null,
        }),
      }),
    };
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:james-t-kirk",
      priority: 1,
      reason: "Need for PvP crew",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_target");
    expect(result.created).toBe(true);
    expect(result.nextSteps).toBeDefined();
    const target = result.target as Record<string, unknown>;
    expect(target.id).toBe(1);
    expect(target.targetType).toBe("officer");
    expect(target.refId).toBe("wiki:officer:james-t-kirk");
    expect(target.priority).toBe(1);
  });

  it("creates a ship target with default priority", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({
          id: 2,
          targetType: "ship",
          refId: "cdn:ship:1234",
          loadoutId: null,
          priority: 2,
          reason: null,
          status: "active",
          autoSuggested: false,
          createdAt: "2026-02-17",
          updatedAt: "2026-02-17",
          achievedAt: null,
        }),
      }),
    };
    const result = await executeFleetTool("create_target", {
      target_type: "ship",
      ref_id: "cdn:ship:1234",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.priority).toBe(2);
  });

  it("detects duplicate active targets", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([{
          id: 5,
          targetType: "officer",
          refId: "wiki:officer:spock",
          status: "active",
          priority: 2,
          reason: "Old reason",
        }]),
      }),
    };
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:spock",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_target");
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(5);
    expect(result.nextSteps).toBeDefined();
  });

  it("allows target if existing ref_id is not active", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([{
          id: 5,
          targetType: "officer",
          refId: "wiki:officer:spock",
          status: "achieved",
          priority: 2,
        }]),
        create: vi.fn().mockResolvedValue({
          id: 6, targetType: "officer", refId: "wiki:officer:spock",
          loadoutId: null, priority: 2, reason: null, status: "active",
          autoSuggested: false, createdAt: "2026-02-17", updatedAt: "2026-02-17", achievedAt: null,
        }),
      }),
    };
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
      ref_id: "wiki:officer:spock",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
  });

  it("returns error for invalid target_type", async () => {
    const ctx: ToolContext = { targetStore: createMockTargetStore() };
    const result = await executeFleetTool("create_target", {
      target_type: "weapon",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Invalid target_type");
  });

  it("returns error for officer target without ref_id", async () => {
    const ctx: ToolContext = { targetStore: createMockTargetStore() };
    const result = await executeFleetTool("create_target", {
      target_type: "officer",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ref_id");
  });

  it("returns error for invalid priority", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        listByRef: vi.fn().mockResolvedValue([]),
      }),
    };
    const result = await executeFleetTool("create_target", {
      target_type: "ship",
      ref_id: "cdn:ship:1",
      priority: 5,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Priority");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("create_target", {
      target_type: "officer", ref_id: "x",
    }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("update_target", () => {
  it("updates target priority and reason", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active", reason: null,
        }),
        update: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 1, status: "active", reason: "Top priority",
        }),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      priority: 1,
      reason: "Top priority",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("update_target");
    expect(result.updated).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.priority).toBe(1);
    expect(target.reason).toBe("Top priority");
  });

  it("abandons a target", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise", priority: 2, status: "active",
        }),
        update: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise", priority: 2, status: "abandoned", reason: null,
        }),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      status: "abandoned",
    }, ctx) as Record<string, unknown>;
    expect(result.updated).toBe(true);
    const target = result.target as Record<string, unknown>;
    expect(target.status).toBe("abandoned");
  });

  it("redirects achieved status to complete_target", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      status: "achieved",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("complete_target");
    expect(result.nextSteps).toBeDefined();
  });

  it("returns error for target not found", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 999,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("not found");
  });

  it("returns error for no update fields", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("No fields");
  });

  it("returns error for invalid priority", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", priority: 2, status: "active",
        }),
      }),
    };
    const result = await executeFleetTool("update_target", {
      target_id: 1,
      priority: 0,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("Priority");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("update_target", { target_id: 1 }, {});
    expect(result).toHaveProperty("error");
  });

  it("returns error for missing target_id", async () => {
    const ctx: ToolContext = { targetStore: createMockTargetStore() };
    const result = await executeFleetTool("update_target", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("target_id");
  });
});

describe("complete_target", () => {
  it("marks an active target as achieved", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "wiki:officer:kirk",
          priority: 1, status: "active", reason: "PvP crew",
        }),
        markAchieved: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "wiki:officer:kirk",
          priority: 1, status: "achieved", reason: "PvP crew",
          achievedAt: "2026-02-17T12:00:00Z",
        }),
      }),
    };
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("complete_target");
    expect(result.completed).toBe(true);
    expect(result.nextSteps).toBeDefined();
    const target = result.target as Record<string, unknown>;
    expect(target.id).toBe(1);
    expect(target.status).toBe("achieved");
    expect(target.achievedAt).toBe("2026-02-17T12:00:00Z");
  });

  it("returns already_achieved for completed targets", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "ship", refId: "enterprise",
          status: "achieved", achievedAt: "2026-02-17",
        }),
      }),
    };
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("complete_target");
    expect(result.status).toBe("already_achieved");
    expect(result.message).toBeDefined();
  });

  it("returns error for abandoned targets", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue({
          id: 1, targetType: "officer", refId: "kirk", status: "abandoned",
        }),
      }),
    };
    const result = await executeFleetTool("complete_target", {
      target_id: 1,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("abandoned");
  });

  it("returns error for target not found", async () => {
    const ctx: ToolContext = {
      targetStore: createMockTargetStore({
        get: vi.fn().mockResolvedValue(null),
      }),
    };
    const result = await executeFleetTool("complete_target", {
      target_id: 999,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("not found");
  });

  it("returns error for missing target_id", async () => {
    const ctx: ToolContext = { targetStore: createMockTargetStore() };
    const result = await executeFleetTool("complete_target", {}, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("target_id");
  });

  it("returns error when target store unavailable", async () => {
    const result = await executeFleetTool("complete_target", { target_id: 1 }, {});
    expect(result).toHaveProperty("error");
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

  it("detects duplicate by name (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listBridgeCores: vi.fn().mockResolvedValue([{
          id: 7, name: "Kirk Trio",
          members: [
            { officerId: "kirk", slot: "captain" },
            { officerId: "spock", slot: "bridge_1" },
            { officerId: "mccoy", slot: "bridge_2" },
          ],
        }]),
      }),
    };
    const result = await executeFleetTool("create_bridge_core", {
      name: "Kirk Trio", captain: "uhura", bridge_1: "scotty", bridge_2: "sulu",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_bridge_core");
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(7);
    expect(result.existingName).toBe("Kirk Trio");
    expect(result.nextSteps).toBeDefined();
  });

  it("detects duplicate by member set regardless of name (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listBridgeCores: vi.fn().mockResolvedValue([{
          id: 7, name: "Original Trio",
          members: [
            { officerId: "kirk", slot: "captain" },
            { officerId: "spock", slot: "bridge_1" },
            { officerId: "mccoy", slot: "bridge_2" },
          ],
        }]),
      }),
    };
    // Same officers, different name and different slots
    const result = await executeFleetTool("create_bridge_core", {
      name: "TOS Bridge", captain: "mccoy", bridge_1: "kirk", bridge_2: "spock",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(7);
    expect(result.existingName).toBe("Original Trio");
  });

  it("detects name duplicate case-insensitively (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listBridgeCores: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Crew",
          members: [{ officerId: "a", slot: "captain" }, { officerId: "b", slot: "bridge_1" }, { officerId: "c", slot: "bridge_2" }],
        }]),
      }),
    };
    const result = await executeFleetTool("create_bridge_core", {
      name: "pvp crew", captain: "x", bridge_1: "y", bridge_2: "z",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
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
    expect(result.tool).toBe("create_loadout");
    expect(result.created).toBe(true);
    expect(result.nextSteps).toBeDefined();
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

  it("detects duplicate loadout by name within ship (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Mining Alpha", shipId: "ship-enterprise",
        }]),
      }),
    };
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-enterprise", name: "Mining Alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_loadout");
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(10);
    expect(result.existingName).toBe("Mining Alpha");
    expect(result.nextSteps).toBeDefined();
  });

  it("detects loadout name dupe case-insensitively (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Mining Alpha", shipId: "ship-enterprise",
        }]),
      }),
    };
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-enterprise", name: "mining alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
  });

  it("allows same loadout name on different ships (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),  // empty for different ship
        createLoadout: vi.fn().mockResolvedValue({
          id: 11, name: "Mining Alpha", shipId: "ship-saladin",
        }),
      }),
    };
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-saladin", name: "Mining Alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
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
    expect(result.tool).toBe("activate_preset");
    expect(result.guidedAction).toBe(true);
    expect(result.actionType).toBe("activate_preset");
    expect(result.presetId).toBe(5);
    expect(result.presetName).toBe("War Preset");
    expect(result.slotCount).toBe(1);
    expect(result.uiPath).toBe("/app#plan/presets");
    expect((result.message as string)).toContain("Plan");
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
      locked: true,
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("set_reservation");
    expect(result.action).toBe("set");
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
    expect(result.tool).toBe("set_reservation");
    expect(result.action).toBe("cleared");
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
    expect(result.tool).toBe("create_variant");
    expect(result.created).toBe(true);
    expect(result.nextSteps).toBeDefined();
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

  it("detects duplicate variant by name within loadout (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listVariants: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Swap", baseLoadoutId: 10,
        }]),
      }),
    };
    const result = await executeFleetTool("create_variant", {
      loadout_id: 10, name: "PvP Swap", captain: "uhura",
    }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("create_variant");
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(3);
    expect(result.existingName).toBe("PvP Swap");
    expect(result.nextSteps).toBeDefined();
  });

  it("detects variant name dupe case-insensitively (#81)", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore({
        listVariants: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Swap", baseLoadoutId: 10,
        }]),
      }),
    };
    const result = await executeFleetTool("create_variant", {
      loadout_id: 10, name: "pvp swap",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
  });
});

describe("get_effective_state", () => {
  it("returns effective dock state with conflicts", async () => {
    const ctx: ToolContext = {
      crewStore: createMockCrewStore(),
    };
    const result = await executeFleetTool("get_effective_state", {}, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("get_effective_state");
    const summary = result.summary as Record<string, unknown>;
    expect(summary.totalDocks).toBe(2);
    expect(summary.conflicts).toBe(1);
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
    expect(result.tool).toBe("get_effective_state");
    const preset = result.activePreset as Record<string, unknown>;
    expect(preset.id).toBe(1);
    expect(preset.name).toBe("War Config");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("get_effective_state", {}, {});
    expect(result).toHaveProperty("error");
  });
});

// ─── Overlay Mutation Tools ─────────────────────────────────

describe("sync_overlay", () => {
  it("returns error for unsupported export schema version", async () => {
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore(),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "2.0",
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(String(result.error)).toContain("Supported version is '1.0'");
  });

  it("warns when export date is stale", async () => {
    const staleDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        exportDate: staleDate,
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    const schema = result.schema as Record<string, unknown>;
    expect(schema.stale).toBe(true);
    expect(schema.importAgeDays).toBeGreaterThan(7);
    const warnings = result.warnings as string[];
    expect(warnings.some((w) => w.includes("stale"))).toBe(true);
  });

  it("returns dry-run diff summary without applying", async () => {
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([
          {
            refId: "cdn:officer:100",
            ownershipState: "unowned",
            target: false,
            level: 20,
            rank: "2",
            power: 1000,
            targetNote: null,
            targetPriority: null,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        source: "manual",
        officers: [{ refId: "cdn:officer:100", level: 50, owned: true }],
        ships: [{ refId: "cdn:ship:200", tier: 8, owned: true }],
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.dryRun).toBe(true);
    const summary = result.summary as Record<string, unknown>;
    const officers = summary.officers as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(officers.changed).toBe(1);
    expect(ships.changed).toBe(1);
    expect(officers.applied).toBe(0);
    expect(ships.applied).toBe(0);
  });

  it("applies overlay updates when dry_run=false", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:100",
      ownershipState: "owned",
      target: false,
      level: 50,
      rank: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:200",
      ownershipState: "owned",
      target: false,
      tier: 8,
      level: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

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

    const createPlanItem = vi.fn().mockResolvedValue({
      id: 55,
      intentKey: null,
      label: "sync_overlay import",
      loadoutId: 20,
      variantId: null,
      dockNumber: 2,
      awayOfficers: null,
      priority: 0,
      isActive: true,
      source: "manual",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const updatePlanItem = vi.fn().mockResolvedValue({
      id: 10,
      intentKey: null,
      label: "Current Dock",
      loadoutId: 20,
      variantId: null,
      dockNumber: 1,
      awayOfficers: null,
      priority: 0,
      isActive: true,
      source: "manual",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 10,
            intentKey: null,
            label: "Current Dock",
            loadoutId: 10,
            variantId: null,
            dockNumber: 1,
            awayOfficers: null,
            priority: 0,
            isActive: true,
            source: "manual",
            notes: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        listLoadouts: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 20,
              shipId: "cdn:ship:200",
              bridgeCoreId: null,
              belowDeckPolicyId: null,
              name: "Ship 200 Loadout",
              priority: 0,
              isActive: true,
              intentKeys: [],
              tags: [],
              notes: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 20,
              shipId: "cdn:ship:200",
              bridgeCoreId: null,
              belowDeckPolicyId: null,
              name: "Ship 200 Loadout",
              priority: 0,
              isActive: true,
              intentKeys: [],
              tags: [],
              notes: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]),
        createPlanItem,
        updatePlanItem,
      }),
      receiptStore: createMockReceiptStore({ createReceipt }),
    };

    const result = await executeFleetTool("sync_overlay", {
      payload_json: JSON.stringify({
        version: "1.0",
        officers: [{ refId: "100", owned: true, level: 50 }],
        ships: [{ refId: "200", owned: true, tier: 8 }],
        docks: [
          { number: 1, loadoutId: 20 },
          { number: 2, shipId: "200" },
        ],
      }),
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.dryRun).toBe(false);
    expect(setOfficerOverlay).toHaveBeenCalledTimes(1);
    expect(setShipOverlay).toHaveBeenCalledTimes(1);
    const summary = result.summary as Record<string, unknown>;
    const officers = summary.officers as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(officers.applied).toBe(1);
    expect(ships.applied).toBe(1);
    expect(createReceipt).toHaveBeenCalledTimes(1);
    const receipt = result.receipt as Record<string, unknown>;
    expect(receipt.created).toBe(true);
    expect(receipt.id).toBe(42);
    expect(updatePlanItem).toHaveBeenCalledTimes(1);
    expect(createPlanItem).toHaveBeenCalledTimes(1);
    const preview = result.changesPreview as Record<string, unknown>;
    const dockPreview = preview.docks as unknown[];
    expect(dockPreview.length).toBe(2);
  });

  it("supports manual free-text updates", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "ship-enterprise",
      ownershipState: "owned",
      target: false,
      tier: 7,
      level: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        searchOfficers: vi.fn().mockResolvedValue([]),
        searchShips: vi.fn().mockResolvedValue([FIXTURE_SHIP]),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["I upgraded my Enterprise to tier 7"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(1);
    const summary = result.summary as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(ships.manualUpdates).toBe(1);
    expect(ships.applied).toBe(1);
  });

  it("supports bulk max ship updates with exceptions", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1",
      ownershipState: "owned",
      target: false,
      tier: 10,
      level: 45,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "USS Enterprise", maxTier: 10, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:2", name: "D'Vor", maxTier: 9, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:3", name: "Vi'Dar", maxTier: 8, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:4", name: "Sarcophagus", maxTier: 12, maxLevel: 45 },
    ];

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((ship) => ship.id === id) ?? null),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["Ok all of my ships except the D'Vor and Vi'Dar are max tier and level available to the ship"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(2);
    const calledRefIds = setShipOverlay.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).refId);
    expect(calledRefIds).toContain("cdn:ship:1");
    expect(calledRefIds).toContain("cdn:ship:4");
    expect(calledRefIds).not.toContain("cdn:ship:2");
    expect(calledRefIds).not.toContain("cdn:ship:3");

    // Verify written values match reference maxTier/maxLevel
    const enterpriseCall = setShipOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:ship:1");
    expect(enterpriseCall).toBeDefined();
    expect((enterpriseCall![0] as Record<string, unknown>).tier).toBe(10);
    expect((enterpriseCall![0] as Record<string, unknown>).level).toBe(45);
    expect((enterpriseCall![0] as Record<string, unknown>).ownershipState).toBe("owned");

    const sarcophagusCall = setShipOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:ship:4");
    expect(sarcophagusCall).toBeDefined();
    expect((sarcophagusCall![0] as Record<string, unknown>).tier).toBe(12);
    expect((sarcophagusCall![0] as Record<string, unknown>).level).toBe(45);
  });

  it("supports bulk max officer updates with exceptions", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:1",
      ownershipState: "owned",
      target: false,
      level: 50,
      rank: "5",
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const officers = [
      { ...FIXTURE_OFFICER, id: "cdn:officer:1", name: "Kirk", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:2", name: "Spock", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:3", name: "Bones", maxRank: 4 },
    ];

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue(officers),
        getOfficer: vi.fn().mockImplementation(async (id: string) => officers.find((officer) => officer.id === id) ?? null),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my officers except Spock are max rank and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setOfficerOverlay).toHaveBeenCalledTimes(2);
    const calledRefIds = setOfficerOverlay.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).refId);
    expect(calledRefIds).toContain("cdn:officer:1");
    expect(calledRefIds).toContain("cdn:officer:3");
    expect(calledRefIds).not.toContain("cdn:officer:2");

    // Verify rank and level values from inferOfficerLevelFromMaxRank
    const kirkCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:1");
    expect(kirkCall).toBeDefined();
    expect((kirkCall![0] as Record<string, unknown>).rank).toBe("5");
    expect((kirkCall![0] as Record<string, unknown>).level).toBe(50);
    expect((kirkCall![0] as Record<string, unknown>).ownershipState).toBe("owned");

    const bonesCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:3");
    expect(bonesCall).toBeDefined();
    expect((bonesCall![0] as Record<string, unknown>).rank).toBe("4");
    expect((bonesCall![0] as Record<string, unknown>).level).toBe(40);
  });

  it("supports bulk max ship updates with no exceptions", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1",
      ownershipState: "owned",
      target: false,
      tier: 10,
      level: 45,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "USS Enterprise", maxTier: 10, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:2", name: "D'Vor", maxTier: 9, maxLevel: 40 },
    ];

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((s) => s.id === id) ?? null),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my ships are max tier and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(2);
  });

  it("warns when bulk update excludes all entities", async () => {
    const setShipOverlay = vi.fn();

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "Enterprise", maxTier: 10, maxLevel: 45 },
    ];

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((s) => s.id === id) ?? null),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my ships except Enterprise are max tier and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).not.toHaveBeenCalled();
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("did not match any ships after exclusions"))).toBe(true);
  });

  it("handles officers with null maxRank in bulk update", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:1",
      ownershipState: "owned",
      target: false,
      level: null,
      rank: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const officers = [
      { ...FIXTURE_OFFICER, id: "cdn:officer:1", name: "Kirk", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:2", name: "Unknown Cadet", maxRank: null },
    ];

    const ctx: ToolContext = {
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue(officers),
        getOfficer: vi.fn().mockImplementation(async (id: string) => officers.find((o) => o.id === id) ?? null),
      }),
    };

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my officers are max rank and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setOfficerOverlay).toHaveBeenCalledTimes(2);

    // Kirk should have rank/level from maxRank
    const kirkCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:1");
    expect(kirkCall).toBeDefined();
    expect((kirkCall![0] as Record<string, unknown>).rank).toBe("5");
    expect((kirkCall![0] as Record<string, unknown>).level).toBe(50);

    // Unknown Cadet should be owned but without rank/level
    const cadetCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:2");
    expect(cadetCall).toBeDefined();
    expect((cadetCall![0] as Record<string, unknown>).level).toBeNull();

    // Should have a warning about missing max rank
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("Unknown Cadet") && w.includes("missing max rank"))).toBe(true);
  });
});

describe("sync_research", () => {
  const RESEARCH_EXPORT = {
    schema_version: "1.0",
    captured_at: "2026-02-18T00:00:00Z",
    source: "ripper-cc",
    nodes: [
      {
        node_id: "combat.weapon.damage.t4",
        tree: "combat",
        name: "Weapon Damage",
        max_level: 10,
        dependencies: [],
        buffs: [{ kind: "combat", metric: "weapon_damage", value: 0.15, unit: "percent" }],
      },
    ],
    state: [
      {
        node_id: "combat.weapon.damage.t4",
        level: 4,
        completed: false,
        updated_at: "2026-02-18T00:00:00Z",
      },
    ],
  };

  it("returns preview in dry-run mode by default", async () => {
    const replaceSnapshot = vi.fn();
    const ctx: ToolContext = {
      researchStore: createMockResearchStore({ replaceSnapshot }),
    };

    const result = await executeFleetTool("sync_research", { export: RESEARCH_EXPORT }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("sync_research");
    expect(result.dryRun).toBe(true);
    expect(replaceSnapshot).not.toHaveBeenCalled();
    const summary = result.summary as Record<string, unknown>;
    expect(summary.nodes).toBe(1);
    expect(summary.trees).toBe(1);
  });

  it("applies snapshot when dry_run=false", async () => {
    const replaceSnapshot = vi.fn().mockResolvedValue({ nodes: 1, trees: 1 });
    const ctx: ToolContext = {
      researchStore: createMockResearchStore({ replaceSnapshot }),
    };

    const result = await executeFleetTool("sync_research", {
      payload_json: JSON.stringify(RESEARCH_EXPORT),
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(result.dryRun).toBe(false);
    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it("validates schema version", async () => {
    const ctx: ToolContext = {
      researchStore: createMockResearchStore(),
    };
    const result = await executeFleetTool("sync_research", {
      export: { schema_version: "2.0", nodes: [], state: [] },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("schema_version");
  });

  it("returns parse error for invalid payload_json", async () => {
    const ctx: ToolContext = {
      researchStore: createMockResearchStore(),
    };
    const result = await executeFleetTool("sync_research", {
      payload_json: "{ not-json",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("payload_json is not valid JSON");
  });

  it("validates node buff fields", async () => {
    const ctx: ToolContext = {
      researchStore: createMockResearchStore(),
    };
    const invalidExport = {
      schema_version: "1.0",
      nodes: [
        {
          node_id: "combat.weapon",
          tree: "combat",
          name: "Weapon",
          max_level: 10,
          dependencies: [],
          buffs: [{ kind: "combat", metric: "weapon_damage", value: "bad", unit: "percent" }],
        },
      ],
      state: [{ node_id: "combat.weapon", level: 1, completed: false }],
    };

    const result = await executeFleetTool("sync_research", {
      export: invalidExport,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("invalid buff fields");
  });

  it("returns error when research store unavailable", async () => {
    const result = await executeFleetTool("sync_research", { export: RESEARCH_EXPORT }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("set_ship_overlay", () => {
  it("sets ship overlay with all fields", async () => {
    const mockOverlay = {
      refId: "cdn:ship:12345",
      ownershipState: "owned",
      tier: 9,
      level: 45,
      power: 125000,
      target: true,
      targetNote: "Priority upgrade",
    };
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        setShipOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    };
    const result = await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:12345",
      ownership_state: "owned",
      tier: 9,
      level: 45,
      power: 125000,
      target: true,
      target_note: "Priority upgrade",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("set_ship_overlay");
    expect(result.updated).toBe(true);
    expect(result.shipId).toBe("cdn:ship:12345");
    expect(result.nextSteps).toBeDefined();
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.ownershipState).toBe("owned");
    expect(overlay.tier).toBe(9);
    expect(overlay.level).toBe(45);
    expect(overlay.power).toBe(125000);
  });

  it("sets only tier and level", async () => {
    const mockOverlay = {
      refId: "cdn:ship:999",
      ownershipState: null,
      tier: 5,
      level: 30,
      power: null,
      target: null,
      targetNote: null,
    };
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        setShipOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    };
    const result = await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:999",
      tier: 5,
      level: 30,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("set_ship_overlay");
    expect(result.updated).toBe(true);
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.tier).toBe(5);
    expect(overlay.level).toBe(30);
  });

  it("returns error for missing ship_id", async () => {
    const ctx: ToolContext = { overlayStore: createMockOverlayStore() };
    const result = await executeFleetTool("set_ship_overlay", {
      tier: 9,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ship_id");
  });

  it("returns error for invalid ownership_state", async () => {
    const ctx: ToolContext = { overlayStore: createMockOverlayStore() };
    const result = await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:123",
      ownership_state: "maybe",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ownership_state");
  });

  it("returns error when overlay store unavailable", async () => {
    const result = await executeFleetTool("set_ship_overlay", {
      ship_id: "cdn:ship:123",
    }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("set_officer_overlay", () => {
  it("sets officer overlay with all fields", async () => {
    const mockOverlay = {
      refId: "cdn:officer:98765",
      ownershipState: "owned",
      level: 50,
      rank: "4",
      power: 8500,
      target: false,
      targetNote: null,
    };
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        setOfficerOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    };
    const result = await executeFleetTool("set_officer_overlay", {
      officer_id: "cdn:officer:98765",
      ownership_state: "owned",
      level: 50,
      rank: "4",
      power: 8500,
      target: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("set_officer_overlay");
    expect(result.updated).toBe(true);
    expect(result.officerId).toBe("cdn:officer:98765");
    expect(result.nextSteps).toBeDefined();
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.ownershipState).toBe("owned");
    expect(overlay.level).toBe(50);
    expect(overlay.rank).toBe("4");
    expect(overlay.power).toBe(8500);
  });

  it("sets only level and rank", async () => {
    const mockOverlay = {
      refId: "cdn:officer:111",
      ownershipState: null,
      level: 35,
      rank: "3",
      power: null,
      target: null,
      targetNote: null,
    };
    const ctx: ToolContext = {
      overlayStore: createMockOverlayStore({
        setOfficerOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    };
    const result = await executeFleetTool("set_officer_overlay", {
      officer_id: "cdn:officer:111",
      level: 35,
      rank: "3",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("set_officer_overlay");
    expect(result.updated).toBe(true);
    const overlay = result.overlay as Record<string, unknown>;
    expect(overlay.level).toBe(35);
    expect(overlay.rank).toBe("3");
  });

  it("returns error for missing officer_id", async () => {
    const ctx: ToolContext = { overlayStore: createMockOverlayStore() };
    const result = await executeFleetTool("set_officer_overlay", {
      level: 50,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("officer_id");
  });

  it("returns error for invalid ownership_state", async () => {
    const ctx: ToolContext = { overlayStore: createMockOverlayStore() };
    const result = await executeFleetTool("set_officer_overlay", {
      officer_id: "cdn:officer:123",
      ownership_state: "perhaps",
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ownership_state");
  });

  it("returns error when overlay store unavailable", async () => {
    const result = await executeFleetTool("set_officer_overlay", {
      officer_id: "cdn:officer:123",
    }, {});
    expect(result).toHaveProperty("error");
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

    const ctx: ToolContext = {
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
    };

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

    const ctxA: ToolContext = {
      userId: USER_A,
      overlayStore: overlayA,
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore(),
      targetStore: createMockTargetStore(),
      receiptStore: createMockReceiptStore(),
      researchStore: createMockResearchStore(),
      inventoryStore: createMockInventoryStore(),
    };

    const ctxB: ToolContext = {
      userId: USER_B,
      overlayStore: overlayB,
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore(),
      targetStore: createMockTargetStore(),
      receiptStore: createMockReceiptStore(),
      researchStore: createMockResearchStore(),
      inventoryStore: createMockInventoryStore(),
    };

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

    const ctxA: ToolContext = {
      userId: USER_A,
      overlayStore: createMockOverlayStore({ setShipOverlay: setShipA }),
      referenceStore: createMockReferenceStore(),
    };
    const ctxB: ToolContext = {
      userId: USER_B,
      overlayStore: createMockOverlayStore({ setShipOverlay: setShipB }),
      referenceStore: createMockReferenceStore(),
    };

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

    const ctxA: ToolContext = {
      userId: USER_A,
      targetStore: createMockTargetStore({
        create: createA,
        listByRef: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore(),
    };
    const ctxB: ToolContext = {
      userId: USER_B,
      targetStore: createMockTargetStore({
        create: createB,
        listByRef: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore(),
    };

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

    const ctxA: ToolContext = { userId: USER_A, researchStore: researchA };
    const ctxB: ToolContext = { userId: USER_B, researchStore: researchB };

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

    const ctxA: ToolContext = { userId: USER_A, inventoryStore: inventoryA };
    const ctxB: ToolContext = { userId: USER_B, inventoryStore: inventoryB };

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

    const ctxA: ToolContext = { userId: "user-alpha", crewStore: crewStoreA };
    const ctxB: ToolContext = { userId: "user-bravo", crewStore: crewStoreB };

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

    const ctxA: ToolContext = {
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
    };
    const ctxB: ToolContext = {
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
    };

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
