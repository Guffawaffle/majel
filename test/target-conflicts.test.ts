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
import { detectTargetConflicts, type ResourceConflict } from "../src/server/services/target-conflicts.js";
import type { Target, TargetStore } from "../src/server/stores/target-store.js";
import type { LoadoutStore } from "../src/server/stores/loadout-store.js";
import type { LoadoutWithMembers } from "../src/server/types/loadout-types.js";

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

function makeLoadout(id: number, name: string, members: Array<{ officerId: string; officerName: string; roleType: "bridge" | "below_deck" }>): LoadoutWithMembers {
  return {
    id,
    shipId: `ship-${id}`,
    name,
    priority: 1,
    isActive: true,
    intentKeys: [],
    tags: [],
    notes: null,
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    shipName: `Ship ${id}`,
    members: members.map((m, i) => ({
      id: i + 1,
      loadoutId: id,
      officerId: m.officerId,
      officerName: m.officerName,
      roleType: m.roleType,
      slot: null,
    })),
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

function createMockLoadoutStore(overrides: {
  getLoadout?: (id: number) => Promise<LoadoutWithMembers | null>;
  listPlanItems?: ReturnType<typeof vi.fn>;
  getOfficerConflicts?: ReturnType<typeof vi.fn>;
} = {}): LoadoutStore {
  return {
    getLoadout: overrides.getLoadout ?? vi.fn().mockResolvedValue(null),
    listPlanItems: overrides.listPlanItems ?? vi.fn().mockResolvedValue([]),
    getOfficerConflicts: overrides.getOfficerConflicts ?? vi.fn().mockResolvedValue([]),
    // Unused methods
    listIntents: vi.fn(), getIntent: vi.fn(), createIntent: vi.fn(), deleteIntent: vi.fn(),
    listLoadouts: vi.fn(), createLoadout: vi.fn(), updateLoadout: vi.fn(), deleteLoadout: vi.fn(),
    setLoadoutMembers: vi.fn(), listDocks: vi.fn(), getDock: vi.fn(), upsertDock: vi.fn(),
    deleteDock: vi.fn(), getPlanItem: vi.fn(), createPlanItem: vi.fn(), updatePlanItem: vi.fn(),
    deletePlanItem: vi.fn(), setPlanAwayMembers: vi.fn(), validatePlan: vi.fn(),
    findLoadoutsForIntent: vi.fn(), previewDeleteLoadout: vi.fn(), previewDeleteDock: vi.fn(),
    previewDeleteOfficer: vi.fn(), counts: vi.fn(), close: vi.fn(),
  } as unknown as LoadoutStore;
}

// ─── Tests ──────────────────────────────────────────────────

describe("detectTargetConflicts", () => {
  describe("no conflicts", () => {
    it("returns empty array when no active targets exist", async () => {
      const ts = createMockTargetStore([]);
      const ls = createMockLoadoutStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("returns empty array when crew targets have different officers", async () => {
      const loadoutA = makeLoadout(10, "Crew Alpha", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutB = makeLoadout(20, "Crew Beta", [
        { officerId: "officer-spock", officerName: "Spock", roleType: "bridge" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10, reason: "Crew A" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20, reason: "Crew B" }),
      ]);
      const ls = createMockLoadoutStore({
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
      const ls = createMockLoadoutStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });
  });

  describe("officer contention", () => {
    it("detects when two crew targets share the same officer", async () => {
      const loadoutA = makeLoadout(10, "PvP Crew", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
        { officerId: "officer-spock", officerName: "Spock", roleType: "below_deck" },
      ]);
      const loadoutB = makeLoadout(20, "Armada Crew", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
        { officerId: "officer-uhura", officerName: "Uhura", roleType: "below_deck" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20, reason: "Armada" }),
      ]);
      const ls = createMockLoadoutStore({
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
      expect(conflict.description).toContain("Kirk");
      expect(conflict.description).toContain("PvP Crew");
      expect(conflict.description).toContain("Armada Crew");
      expect(conflict.targetA.id).toBe(1);
      expect(conflict.targetB?.id).toBe(2);
    });

    it("marks bridge+below_deck overlap as competing (not blocking)", async () => {
      const loadoutA = makeLoadout(10, "Crew A", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "below_deck" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockLoadoutStore({
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
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
        { officerId: "officer-spock", officerName: "Spock", roleType: "below_deck" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
        { officerId: "officer-spock", officerName: "Spock", roleType: "below_deck" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockLoadoutStore({
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
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutB = makeLoadout(20, "Crew B", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutC = makeLoadout(30, "Crew C", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "below_deck" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
        makeTarget({ id: 3, targetType: "crew", refId: null, loadoutId: 30 }),
      ]);
      const ls = createMockLoadoutStore({
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
      const ls = createMockLoadoutStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, intentKey: "mining", label: "Mine Lat", loadoutId: 10,
            dockNumber: 3, priority: 1, isActive: true, notes: null,
            intentLabel: null, loadoutName: "Crew A", shipId: null, shipName: null,
            dockLabel: null, members: [], awayMembers: [],
          },
          {
            id: 200, intentKey: "pvp", label: "Arena", loadoutId: 20,
            dockNumber: 3, priority: 1, isActive: true, notes: null,
            intentLabel: null, loadoutName: "Crew B", shipId: null, shipName: null,
            dockLabel: null, members: [], awayMembers: [],
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
      const ls = createMockLoadoutStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, loadoutId: 10, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: null, notes: null, intentLabel: null,
            loadoutName: null, shipId: null, shipName: null, dockLabel: null,
            members: [], awayMembers: [],
          },
          {
            id: 200, loadoutId: 20, dockNumber: 2, priority: 1, isActive: true,
            intentKey: null, label: null, notes: null, intentLabel: null,
            loadoutName: null, shipId: null, shipName: null, dockLabel: null,
            members: [], awayMembers: [],
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
      const ls = createMockLoadoutStore({
        getOfficerConflicts: vi.fn().mockResolvedValue([
          {
            officerId: "officer-kirk",
            officerName: "Kirk",
            appearances: [
              { planItemId: 1, planItemLabel: "PvP", intentKey: "pvp", dockNumber: 1, source: "loadout", loadoutName: "PvP Crew" },
              { planItemId: 2, planItemLabel: "Mining", intentKey: "mining", dockNumber: 2, source: "loadout", loadoutName: "Mining Crew" },
            ],
          },
        ]),
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
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk", reason: "Promote Kirk" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP Goal" }),
      ]);
      const ls = createMockLoadoutStore({
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
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "officer", refId: "officer-kirk", reason: "Promote Kirk" }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 10, reason: "PvP Goal" }),
      ]);
      const ls = createMockLoadoutStore({
        getLoadout: vi.fn().mockResolvedValue(loadout),
        getOfficerConflicts: vi.fn().mockResolvedValue([
          {
            officerId: "officer-kirk",
            officerName: "Kirk",
            appearances: [
              { planItemId: 1, planItemLabel: "PvP", intentKey: null, dockNumber: 1, source: "loadout", loadoutName: "PvP Crew" },
              { planItemId: 2, planItemLabel: "Mining", intentKey: null, dockNumber: 2, source: "loadout", loadoutName: "Mining Crew" },
            ],
          },
        ]),
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
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutB = makeLoadout(20, "Armada Crew", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockLoadoutStore({
        getLoadout: vi.fn().mockImplementation(async (id: number) => {
          if (id === 10) return loadoutA;
          if (id === 20) return loadoutB;
          return null;
        }),
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 100, loadoutId: 10, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: "PvP Plan", notes: null, intentLabel: null,
            loadoutName: "PvP Crew", shipId: null, shipName: null, dockLabel: null,
            members: [], awayMembers: [],
          },
          {
            id: 200, loadoutId: 20, dockNumber: 1, priority: 1, isActive: true,
            intentKey: null, label: "Armada Plan", notes: null, intentLabel: null,
            loadoutName: "Armada Crew", shipId: null, shipName: null, dockLabel: null,
            members: [], awayMembers: [],
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
      const ls = createMockLoadoutStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("ignores ship targets (no conflict detection for ships yet)", async () => {
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "ship", refId: "ship-enterprise" }),
        makeTarget({ id: 2, targetType: "ship", refId: "ship-voyager" }),
      ]);
      const ls = createMockLoadoutStore();
      const result = await detectTargetConflicts(ts, ls);
      expect(result).toEqual([]);
    });

    it("returns correct structure for each conflict", async () => {
      const loadoutA = makeLoadout(10, "A", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const loadoutB = makeLoadout(20, "B", [
        { officerId: "officer-kirk", officerName: "Kirk", roleType: "bridge" },
      ]);
      const ts = createMockTargetStore([
        makeTarget({ id: 1, targetType: "crew", refId: null, loadoutId: 10 }),
        makeTarget({ id: 2, targetType: "crew", refId: null, loadoutId: 20 }),
      ]);
      const ls = createMockLoadoutStore({
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
