/**
 * fleet-tools/dock-mutations.test.ts — Tests for dock mutation tools
 *
 * Covers: assign_dock, update_dock, remove_dock_assignment
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockCrewStore,
  FIXTURE_PLAN_ITEM,
} from "./helpers.js";

// ─── assign_dock ────────────────────────────────────────────

describe("assign_dock", () => {
  it("creates a plan item and deactivates existing ones", async () => {
    const existingItem = { ...FIXTURE_PLAN_ITEM, id: 99 };
    const newItem = { ...FIXTURE_PLAN_ITEM, id: 100, loadoutId: 42 };
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue([existingItem]),
      createPlanItem: vi.fn().mockResolvedValue(newItem),
      updatePlanItem: vi.fn().mockResolvedValue({ ...existingItem, isActive: false }),
      upsertDock: vi.fn(),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("assign_dock", {
      dock_number: 1,
      loadout_id: 42,
      label: "Battle Dock",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("assign_dock");
    expect(result.created).toBe(true);
    expect((result.planItem as Record<string, unknown>).id).toBe(100);
    expect((result.planItem as Record<string, unknown>).loadoutId).toBe(42);

    // Verify the dock was upserted
    expect(crewStore.upsertDock).toHaveBeenCalledWith(1, {
      label: "Battle Dock",
      unlocked: true,
    });

    // Verify existing plan item was deactivated
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(99, { isActive: false });

    // Verify new plan item was created
    expect(crewStore.createPlanItem).toHaveBeenCalledWith(
      expect.objectContaining({
        dockNumber: 1,
        loadoutId: 42,
        label: "Battle Dock",
        isActive: true,
        source: "manual",
      }),
    );
  });

  it("assigns with variant_id instead of loadout_id", async () => {
    const newItem = { ...FIXTURE_PLAN_ITEM, id: 101, variantId: 7 };
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue([]),
      createPlanItem: vi.fn().mockResolvedValue(newItem),
      upsertDock: vi.fn(),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("assign_dock", {
      dock_number: 3,
      variant_id: 7,
    }, ctx) as Record<string, unknown>;

    expect(result.created).toBe(true);
    expect(crewStore.createPlanItem).toHaveBeenCalledWith(
      expect.objectContaining({
        dockNumber: 3,
        variantId: 7,
        label: "Dock 3 assignment",
      }),
    );
  });

  it("uses default label when none provided", async () => {
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue([]),
      createPlanItem: vi.fn().mockResolvedValue({ ...FIXTURE_PLAN_ITEM, id: 102 }),
      upsertDock: vi.fn(),
    });
    const ctx = toolEnv({ crewStore });

    await executeFleetTool("assign_dock", { dock_number: 5, loadout_id: 1 }, ctx);

    expect(crewStore.upsertDock).toHaveBeenCalledWith(5, {
      label: "Dock 5",
      unlocked: true,
    });
    expect(crewStore.createPlanItem).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Dock 5 assignment" }),
    );
  });

  it("returns error when crewStore is unavailable", async () => {
    const result = await executeFleetTool("assign_dock", { dock_number: 1, loadout_id: 10 }, toolEnv());
    expect(result).toHaveProperty("error");
    expect((result as Record<string, unknown>).tool).toBe("assign_dock");
  });

  it("rejects non-integer dock_number", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("assign_dock", {
      dock_number: "abc",
      loadout_id: 10,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("rejects dock_number < 1", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("assign_dock", {
      dock_number: 0,
      loadout_id: 10,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("rejects negative dock_number", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("assign_dock", {
      dock_number: -1,
      loadout_id: 10,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("rejects missing dock_number", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("assign_dock", {
      loadout_id: 10,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("returns error when neither loadout_id nor variant_id provided", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("assign_dock", {
      dock_number: 1,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/At least one of loadout_id or variant_id/);
  });

  it("deactivates multiple existing plan items before creating new one", async () => {
    const existing = [
      { ...FIXTURE_PLAN_ITEM, id: 10 },
      { ...FIXTURE_PLAN_ITEM, id: 11 },
      { ...FIXTURE_PLAN_ITEM, id: 12 },
    ];
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue(existing),
      createPlanItem: vi.fn().mockResolvedValue({ ...FIXTURE_PLAN_ITEM, id: 200 }),
      updatePlanItem: vi.fn().mockResolvedValue({ isActive: false }),
      upsertDock: vi.fn(),
    });
    const ctx = toolEnv({ crewStore });

    await executeFleetTool("assign_dock", { dock_number: 1, loadout_id: 5 }, ctx);

    // All 3 existing items should be deactivated
    expect(crewStore.updatePlanItem).toHaveBeenCalledTimes(3);
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(10, { isActive: false });
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(11, { isActive: false });
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(12, { isActive: false });
  });
});

// ─── update_dock ────────────────────────────────────────────

describe("update_dock", () => {
  it("updates an existing plan item with new fields", async () => {
    const existing = { ...FIXTURE_PLAN_ITEM, id: 50 };
    const updated = { ...existing, label: "Renamed Dock", loadoutId: 99 };
    const crewStore = createMockCrewStore({
      getPlanItem: vi.fn().mockResolvedValue(existing),
      updatePlanItem: vi.fn().mockResolvedValue(updated),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("update_dock", {
      plan_item_id: 50,
      label: "Renamed Dock",
      loadout_id: 99,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_dock");
    expect(result.updated).toBe(true);
    expect((result.planItem as Record<string, unknown>).label).toBe("Renamed Dock");

    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(50,
      expect.objectContaining({
        label: "Renamed Dock",
        loadoutId: 99,
      }),
    );
  });

  it("updates dock_number field", async () => {
    const existing = { ...FIXTURE_PLAN_ITEM, id: 50 };
    const updated = { ...existing, dockNumber: 3 };
    const crewStore = createMockCrewStore({
      getPlanItem: vi.fn().mockResolvedValue(existing),
      updatePlanItem: vi.fn().mockResolvedValue(updated),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("update_dock", {
      plan_item_id: 50,
      dock_number: 3,
    }, ctx) as Record<string, unknown>;

    expect(result.updated).toBe(true);
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(50,
      expect.objectContaining({ dockNumber: 3 }),
    );
  });

  it("updates is_active field", async () => {
    const existing = { ...FIXTURE_PLAN_ITEM, id: 50 };
    const updated = { ...existing, isActive: false };
    const crewStore = createMockCrewStore({
      getPlanItem: vi.fn().mockResolvedValue(existing),
      updatePlanItem: vi.fn().mockResolvedValue(updated),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("update_dock", {
      plan_item_id: 50,
      is_active: false,
    }, ctx) as Record<string, unknown>;

    expect(result.updated).toBe(true);
    expect((result.planItem as Record<string, unknown>).isActive).toBe(false);
  });

  it("returns error when crewStore is unavailable", async () => {
    const result = await executeFleetTool("update_dock", { plan_item_id: 1 }, toolEnv());
    expect(result).toHaveProperty("error");
    expect((result as Record<string, unknown>).tool).toBe("update_dock");
  });

  it("rejects non-integer plan_item_id", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("update_dock", {
      plan_item_id: "abc",
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/plan_item_id is required/);
  });

  it("rejects plan_item_id < 1", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("update_dock", {
      plan_item_id: 0,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/plan_item_id is required/);
  });

  it("rejects missing plan_item_id", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("update_dock", {}, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/plan_item_id is required/);
  });

  it("returns error when plan item not found", async () => {
    const crewStore = createMockCrewStore({
      getPlanItem: vi.fn().mockResolvedValue(null),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("update_dock", {
      plan_item_id: 999,
      label: "Ghost",
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/Plan item 999 not found/);
  });

  it("returns error when updatePlanItem returns null", async () => {
    const crewStore = createMockCrewStore({
      getPlanItem: vi.fn().mockResolvedValue(FIXTURE_PLAN_ITEM),
      updatePlanItem: vi.fn().mockResolvedValue(null),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("update_dock", {
      plan_item_id: 1,
      label: "Will Fail",
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/Failed to update plan item/);
  });
});

// ─── remove_dock_assignment ─────────────────────────────────

describe("remove_dock_assignment", () => {
  it("deactivates all active plan items for a dock", async () => {
    const items = [
      { ...FIXTURE_PLAN_ITEM, id: 30 },
      { ...FIXTURE_PLAN_ITEM, id: 31 },
    ];
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue(items),
      updatePlanItem: vi.fn().mockResolvedValue({ isActive: false }),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("remove_dock_assignment", {
      dock_number: 1,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("remove_dock_assignment");
    expect(result.removed).toBe(true);

    expect(crewStore.updatePlanItem).toHaveBeenCalledTimes(2);
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(30, { isActive: false });
    expect(crewStore.updatePlanItem).toHaveBeenCalledWith(31, { isActive: false });
  });

  it("returns removed: false when dock has no active assignments", async () => {
    const crewStore = createMockCrewStore({
      listPlanItems: vi.fn().mockResolvedValue([]),
    });
    const ctx = toolEnv({ crewStore });

    const result = await executeFleetTool("remove_dock_assignment", {
      dock_number: 5,
    }, ctx) as Record<string, unknown>;

    expect(result.removed).toBe(false);
    expect(result.message).toMatch(/no active assignments/);
  });

  it("returns error when crewStore is unavailable", async () => {
    const result = await executeFleetTool("remove_dock_assignment", { dock_number: 1 }, toolEnv());
    expect(result).toHaveProperty("error");
    expect((result as Record<string, unknown>).tool).toBe("remove_dock_assignment");
  });

  it("rejects non-integer dock_number", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("remove_dock_assignment", {
      dock_number: "bad",
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("rejects dock_number < 1", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("remove_dock_assignment", {
      dock_number: 0,
    }, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });

  it("rejects missing dock_number", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("remove_dock_assignment", {}, ctx) as Record<string, unknown>;

    expect(result.error).toMatch(/dock_number must be a positive integer/);
  });
});
