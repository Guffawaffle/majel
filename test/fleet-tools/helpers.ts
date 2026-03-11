/**
 * fleet-tools/helpers.ts — Shared test infrastructure for fleet-tools domain test files
 *
 * Extracted from fleet-tools.test.ts (#193) to avoid duplication
 * across crew, targets, sync, overlay, and dock test files.
 */

import { vi } from "vitest";
import {
  executeFleetTool,
  type ToolEnv,
} from "../../src/server/services/fleet-tools/index.js";
import type { ReferenceStore, ReferenceOfficer, ReferenceShip, ReferenceHostile, ReferenceSystem } from "../../src/server/stores/reference-store.js";
import type { OverlayStore, OfficerOverlay, ShipOverlay } from "../../src/server/stores/overlay-store.js";
import type { CrewStore } from "../../src/server/stores/crew-store.js";
import type { TargetStore } from "../../src/server/stores/target-store.js";
import type { ReceiptStore } from "../../src/server/stores/receipt-store.js";
import type { ResearchStore } from "../../src/server/stores/research-store.js";
import type { InventoryStore } from "../../src/server/stores/inventory-store.js";
import type { UserSettingsStore } from "../../src/server/stores/user-settings-store.js";

// ─── Re-export for convenience ──────────────────────────────
export { executeFleetTool, type ToolEnv };

// ─── ToolEnv Helper (ADR-039 D7) ────────────────────────────

/** Wraps a flat store bag into ToolEnv shape for backward-compat test construction. */
export function toolEnv(flat: Record<string, unknown> = {}): ToolEnv {
  const { userId, ...deps } = flat;
  return { userId: (userId as string) ?? "local", deps: deps as ToolEnv["deps"] };
}

// ─── Test Fixtures ──────────────────────────────────────────

export const FIXTURE_OFFICER: ReferenceOfficer = {
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

export const FIXTURE_SHIP: ReferenceShip = {
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

export const FIXTURE_HOSTILE: ReferenceHostile = {
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

export const FIXTURE_SYSTEM: ReferenceSystem = {
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

export const FIXTURE_OFFICER_OVERLAY: OfficerOverlay = {
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

export const FIXTURE_SHIP_OVERLAY: ShipOverlay = {
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

export function createMockReferenceStore(overrides: Partial<ReferenceStore> = {}): ReferenceStore {
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

export function createMockOverlayStore(overrides: Partial<OverlayStore> = {}): OverlayStore {
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

export function createMockCrewStore(overrides: Partial<CrewStore> = {}): CrewStore {
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

export function createMockTargetStore(overrides: Partial<TargetStore> = {}): TargetStore {
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

export function createMockReceiptStore(overrides: Partial<ReceiptStore> = {}): ReceiptStore {
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

export function createMockResearchStore(overrides: Partial<ResearchStore> = {}): ResearchStore {
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

export function createMockInventoryStore(overrides: Partial<InventoryStore> = {}): InventoryStore {
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

export function createMockUserSettingsStore(overrides: Partial<UserSettingsStore> = {}): UserSettingsStore {
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
              start_time: "2026-01-01T00:00:00Z",
              end_time: "2099-01-01T00:00:00Z",
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
