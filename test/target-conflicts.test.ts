/**
 * target-conflicts.test.ts — Tests for resource conflict detection (#18)
 *
 * Covers:
 * - Officer contention between crew targets sharing the same officer
 * - Dock contention between crew targets on the same dock
 * - Officer cascade — officer targets affecting multiple loadouts
 * - No conflicts when targets are independent
 * - Edge cases: no targets, no loadouts, missing loadout data
 */

import { describe, it, expect, vi } from "vitest";
import { detectTargetConflicts } from "../src/server/services/target-conflicts.js";
import type { Target, TargetStore } from "../src/server/stores/target-store.js";
import type { CrewStore } from "../src/server/stores/crew-store.js";
import type { LoadoutWithRefs, BridgeSlot, EffectiveDockState } from "../src/server/types/crew-types.js";

// ─── Helpers ────────────────────────────────────────────────

function makeTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: 1,
    targetType: "officer",
    refId: "officer-kirk",
    loadoutId: null,
    targetTier: null,
    targetRank: null,
    targetLevel: null,
    reason: "Test target",
    priority: 1,
    status: "active",
    autoSuggested: false,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    achievedAt: null,
    ...overrides,
  };
}

const SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

function makeLoadout(id: number, name: string, members: Array<{ officerId: string; slot?: BridgeSlot }>): LoadoutWithRefs {
  return {
    id,
    shipId: `ship-${id}`,
    bridgeCoreId: id,
    belowDeckPolicyId: null,
    name,
    priority: 1,
    isActive: true,
    intentKeys: [],
    tags: [],
    notes: null,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    bridgeCore: members.length > 0 ? {
      id,
      name: `${name} Bridge`,
      notes: null,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
      members: members.map((m, i) => ({
        id: i + 1,
        bridgeCoreId: id,
        officerId: m.officerId,
        slot: m.slot ?? SLOTS[i] ?? "captain",
      })),
    } : null,
    belowDeckPolicy: null,
    variant: null,
  };
}

function createMockTargetStore(targets: Target[]): TargetStore {
  return {
    list: vi.fn().mockResolvedValue(targets),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    markAchieved: vi.fn(),
    listByRef: vi.fn(),
    counts: vi.fn(),
    close: vi.fn(),
  } as unknown as TargetStore;
}

function createMockCrewStore(overrides: {
  getLoadout?: (id: number) => Promise<LoadoutWithRefs | null>;
  listPlanItems?: ReturnType<typeof vi.fn>;
  getEffectiveDockState?: ReturnType<typeof vi.fn>;
} = {}): CrewStore {
  const defaultEffectiveState: EffectiveDockState = { docks: [], awayTeams: [], conflicts: [] };
  const getLoadoutFn = overrides.getLoadout ?? vi.fn().mockResolvedValue(null);
  return {
    getLoadout: getLoadoutFn,
    getLoadoutsByIds: vi.fn().mockImplementation(async (ids: number[]) => {
      const map = new Map();
      for (const id of ids) {
        const l = await getLoadoutFn(id);
        if (l) map.set(id, l);
      }
      return map;
    }),
    listPlanItems: overrides.listPlanItems ?? vi.fn().mockResolvedValue([]),
    getEffectiveDockState: overrides.getEffectiveDockState ?? vi.fn().mockResolvedValue(defaultEffectiveState),
    // Unused methods (stubbed for type compatibility)
    listLoadouts: vi.fn(), createLoadout: vi.fn(), updateLoadout: vi.fn(), deleteLoadout: vi.fn(),
    listBridgeCores: vi.fn(), getBridgeCore: vi.fn(), createBridgeCore: vi.fn(),
    updateBridgeCore: vi.fn(), deleteBridgeCore: vi.fn(), setBridgeCoreMembers: vi.fn(),
    listBelowDeckPolicies: vi.fn(), getBelowDeckPolicy: vi.fn(), createBelowDeckPolicy: vi.fn(),
    updateBelowDeckPolicy: vi.fn(), deleteBelowDeckPolicy: vi.fn(),
    listVariants: vi.fn(), getVariant: vi.fn(), createVariant: vi.fn(), updateVariant: vi.fn(), deleteVariant: vi.fn(),
    listDocks: vi.fn(), getDock: vi.fn(), upsertDock: vi.fn(), deleteDock: vi.fn(),
    getPlanItem: vi.fn(), createPlanItem: vi.fn(), updatePlanItem: vi.fn(), deletePlanItem: vi.fn(),
    listFleetPresets: vi.fn(), getFleetPreset: vi.fn(), createFleetPreset: vi.fn(),
    updateFleetPreset: vi.fn(), deleteFleetPreset: vi.fn(), setFleetPresetSlots: vi.fn(),
    listReservations: vi.fn(), getReservation: vi.fn(), setReservation: vi.fn(), deleteReservation: vi.fn(),
    resolveVariant: vi.fn(), counts: vi.fn(), close: vi.fn(),
  } as unknown as CrewStore;
}

// ─── Tests ──────────────────────────────────────────────────

describe("detectTargetConflicts", () => {
  describe("no conflicts", () => {
    it("returns empty array when no active targets exist", async () => {
      const ts = createMockTargetStore([]);
      const ls = createMockCrewStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("returns empty array when crew targets have different officers", async () => {
      const loadoutA = makeLoadout(10, "Crew Alpha", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutB = makeLoadout(20, "Crew Beta", [
        { officerId: "officer-spock" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10, reason: "Crew A" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20, reason: "Crew B" }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
      });
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("returns empty array for officer-only targets with no conflicts", async () => {
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk" }),
        makeTarget({ id: 2, targetType: "officer", refId: "officer-spock" }),
      ]);
      const ls = createMockCrewStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });
  });

  describe("officer contention", () => {
    it("detects when two crew targets share the same officer", async () => {
      const loadoutA = makeLoadout(10, "PvP Crew", [
        { officerId: "officer-kirk" },
        { officerId: "officer-spock", slot: "bridge_1" },
      ]);
      const loadoutB = makeLoadout(20, "Armada Crew", [
        { officerId: "officer-kirk" },
        { officerId: "officer-uhura", slot: "bridge_1" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20, reason: "Armada" }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      expect(result.length).toBe(1);

      const conflict = result[0];
      expect(conflict.conflictType).toBe("officer");
      expect(conflict.resource).toBe("officer-kirk");
      expect(conflict.severity).toBe("blocking"); // both bridge
      expect(conflict.description).toContain("officer-kirk");
      expect(conflict.description).toContain("PvP Crew");
      expect(conflict.description).toContain("Armada Crew");
      expect(conflict.targetA.id).toBe(1);
      expect(conflict.targetB?.id).toBe(2);
    });

    it("marks captain+non-captain overlap as competing (not blocking)", async () => {
      const loadoutA = makeLoadout(10, "Crew A", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk", slot: "bridge_1" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      expect(result.length).toBe(1);
      expect(result[0].severity).toBe("competing");
    });

    it("detects multiple officers shared between same targets", async () => {
      const loadoutA = makeLoadout(10, "Crew A", [
        { officerId: "officer-kirk" },
        { officerId: "officer-spock", slot: "bridge_1" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk" },
        { officerId: "officer-spock", slot: "bridge_1" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      expect(result.length).toBe(2); // one for Kirk, one for Spock
      const resources = result.map((c) => c.resource).sort();
      expect(resources).toEqual(["officer-kirk", "officer-spock"]);
    });

    it("handles three-way officer contention across three targets", async () => {
      const loadoutA = makeLoadout(10, "Crew A", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutC = makeLoadout(30, "Crew C", [
        { officerId: "officer-kirk", slot: "bridge_1" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
        makeTarget({ id: 3, targetType: "crew", refId: null, loadoutId: 30 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          if (id === 30) return loadoutC;
          return null;
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      // 3 pairs: A-B (blocking), A-C (competing), B-C (competing)
      expect(result.length).toBe(3);
      const blocking = result.filter((c) => c.severity === "blocking");
      const competing = result.filter((c) => c.severity === "competing");
      expect(blocking.length).toBe(1);
      expect(competing.length).toBe(2);
    });
  });

  describe("dock contention", () => {
    it("detects when two crew targets use the same dock", async () => {
      const loadoutA = makeLoadout(10, "Crew A", []);
      const loadoutB = makeLoadout(20, "Crew B", []);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10, reason: "Mining" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20, reason: "PvP" }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, intentKey: "mining", label: "Mine Lat", loadoutId: 10,
            dockNumber: 3, priority: 1, isActive: true, notes: null,
            variantId: null, awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: 200, intentKey: "pvp", label: "Arena", loadoutId: 20,
            dockNumber: 3, priority: 1, isActive: true, notes: null,
            variantId: null, awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ]),
      });

      const result = await detectTargetConflicts(ts, ls);
      const dockConflicts = result.filter((c) => c.conflictType === "slot");
      expect(dockConflicts.length).toBe(1);
      expect(dockConflicts[0].resource).toBe("dock:3");
      expect(dockConflicts[0].severity).toBe("blocking");
      expect(dockConflicts[0].description).toContain("Dock 3");
    });

    it("no dock conflict when targets use different docks", async () => {
      const loadoutA = makeLoadout(10, "Crew A", []);
      const loadoutB = makeLoadout(20, "Crew B", []);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, loadoutId: 10, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: null, notes: null, variantId: null,
            awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: 200, loadoutId: 20, dockNumber: 2, priority: 1, isActive: true,
            intentKey: null, label: null, notes: null, variantId: null,
            awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ]),
      });

      const result = await detectTargetConflicts(ts, ls);
      const dockConflicts = result.filter((c) => c.conflictType === "slot");
      expect(dockConflicts.length).toBe(0);
    });
  });

  describe("officer cascade", () => {
    it("detects when an officer target is already conflicted in active loadouts", async () => {
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk", reason: "Promote Kirk" }),
      ]);
      const ls = createMockCrewStore({
        getEffectiveDockState: vi.fn().mockResolvedValue({
          docks: [],
          awayTeams: [],
          conflicts: [
            {
              officerId: "officer-kirk",
              officerName: "Kirk",
              locations: [
                { type: "bridge", entityId: 1, entityName: "PvP Crew" },
                { type: "bridge", entityId: 2, entityName: "Mining Crew" },
              ],
            },
          ],
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      const cascades = result.filter((c) => c.conflictType === "cascade");
      expect(cascades.length).toBe(1);
      expect(cascades[0].resource).toBe("officer-kirk");
      expect(cascades[0].severity).toBe("informational");
      expect(cascades[0].description).toContain("2 active assignments");
      expect(cascades[0].description).toContain("PvP Crew");
      expect(cascades[0].description).toContain("Mining Crew");
      expect(cascades[0].targetB).toBeNull(); // no second target, just fleet state
    });

    it("detects when officer target is used in a crew target", async () => {
      const loadout = makeLoadout(10, "PvP Crew", [
        { officerId: "officer-kirk" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk", reason: "Promote Kirk" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP Goal" }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(loadout),
      });

      const result = await detectTargetConflicts(ts, ls);
      const cascades = result.filter((c) => c.conflictType === "cascade");
      expect(cascades.length).toBe(1);
      expect(cascades[0].targetA.id).toBe(1); // officer target
      expect(cascades[0].targetB?.id).toBe(2); // crew target
      expect(cascades[0].description).toContain("PvP Crew");
      expect(cascades[0].description).toContain("benefits both targets");
    });

    it("detects both cascade types for the same officer", async () => {
      const loadout = makeLoadout(10, "PvP Crew", [
        { officerId: "officer-kirk" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk", reason: "Promote Kirk" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP Goal" }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(loadout),
        getEffectiveDockState: vi.fn().mockResolvedValue({
          docks: [],
          awayTeams: [],
          conflicts: [
            {
              officerId: "officer-kirk",
              officerName: "Kirk",
              locations: [
                { type: "bridge", entityId: 1, entityName: "PvP Crew" },
                { type: "bridge", entityId: 2, entityName: "Mining Crew" },
              ],
            },
          ],
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      const cascades = result.filter((c) => c.conflictType === "cascade");
      // One for existing conflict, one for crew target overlap
      expect(cascades.length).toBe(2);
    });
  });

  describe("mixed conflict types", () => {
    it("detects officer + dock conflicts in the same analysis", async () => {
      const loadoutA = makeLoadout(10, "PvP Crew", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutB = makeLoadout(20, "Armada Crew", [
        { officerId: "officer-kirk" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, loadoutId: 10, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: "PvP Plan", notes: null, variantId: null,
            awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
          {
            id: 200, loadoutId: 20, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: "Armada Plan", notes: null, variantId: null,
            awayOfficers: null, source: "manual",
            createdAt: "2024-01-01", updatedAt: "2024-01-01",
          },
        ]),
      });

      const result = await detectTargetConflicts(ts, ls);
      const types = new Set(result.map((c) => c.conflictType));
      expect(types.has("officer")).toBe(true);
      expect(types.has("slot")).toBe(true);
      expect(result.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("skips crew targets with missing loadout data", async () => {
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 999, reason: "Missing" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 888, reason: "Also missing" }),
      ]);
      const ls = createMockCrewStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("ignores ship targets (no conflict detection for ships yet)", async () => {
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "ship", refId: "ship-enterprise" }),
        makeTarget({ id: 2, targetType: "ship", refId: "ship-voyager" }),
      ]);
      const ls = createMockCrewStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("returns correct structure for each conflict", async () => {
      const loadoutA = makeLoadout(10, "A", [
        { officerId: "officer-kirk" },
      ]);
      const loadoutB = makeLoadout(20, "B", [
        { officerId: "officer-kirk" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockCrewStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
      });

      const result = await detectTargetConflicts(ts, ls);
      expect(result.length).toBe(1);
      const c = result[0];

      // Verify full structure
      expect(c).toHaveProperty("conflictType");
      expect(c).toHaveProperty("targetA");
      expect(c).toHaveProperty("targetB");
      expect(c).toHaveProperty("resource");
      expect(c).toHaveProperty("severity");
      expect(c).toHaveProperty("description");
      expect(c).toHaveProperty("suggestion");

      // Verify target refs
      expect(c.targetA).toHaveProperty("id");
      expect(c.targetA).toHaveProperty("targetType");
      expect(c.targetA).toHaveProperty("refId");
      expect(c.targetA).toHaveProperty("loadoutId");
      expect(c.targetA).toHaveProperty("reason");
      expect(c.targetA).toHaveProperty("priority");
    });
  });
});
