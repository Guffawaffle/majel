/**
 * fleet-tools/overlay.test.ts — Overlay & inventory mutation tests
 *
 * Tests for: update_inventory, set_ship_overlay, set_officer_overlay.
 *
 * Extracted from fleet-tools.test.ts (#193).
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockOverlayStore,
  createMockInventoryStore,
} from "./helpers.js";

// ─── update_inventory ───────────────────────────────────────

describe("update_inventory", () => {
  it("records items via upsertItems and returns confirmation", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 2, categories: 2 });
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ upsertItems }),
    });
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
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ upsertItems }),
    });
    await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "Tritanium", quantity: 100 }],
      source: "translator",
    }, ctx);

    const call = upsertItems.mock.calls[0][0];
    expect(call.source).toBe("translator");
  });

  it("trims category/name/grade before persistence", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ upsertItems }),
    });

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
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ upsertItems }),
    });
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
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
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
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("update_inventory", {
      items: [],
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("items array is required");
  });

  it("returns error when items is not an array", async () => {
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("update_inventory", {
      items: "not-an-array",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("items array is required");
  });

  it("returns error when inventory store unavailable", async () => {
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: 280 }],
    }, toolEnv()) as Record<string, unknown>;

    expect(result.tool).toBe("update_inventory");
    expect(result.error).toContain("Inventory store not available");
  });

  it("rejects negative quantity", async () => {
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore(),
    });
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: -5 }],
    }, ctx) as Record<string, unknown>;

    expect(result.error).toBe("No valid items to record.");
    const errors = result.validationErrors as string[];
    expect(errors[0]).toContain("non-negative");
  });

  it("accepts zero quantity (clear inventory entry)", async () => {
    const upsertItems = vi.fn().mockResolvedValue({ upserted: 1, categories: 1 });
    const ctx = toolEnv({
      inventoryStore: createMockInventoryStore({ upsertItems }),
    });
    const result = await executeFleetTool("update_inventory", {
      items: [{ category: "ore", name: "3★ Ore", quantity: 0 }],
    }, ctx) as Record<string, unknown>;

    expect(result.recorded).toBe(true);
  });
});

// ─── set_ship_overlay ───────────────────────────────────────

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
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        setShipOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    });
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
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        setShipOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    });
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
    const ctx = toolEnv({ overlayStore: createMockOverlayStore() });
    const result = await executeFleetTool("set_ship_overlay", {
      tier: 9,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("ship_id");
  });

  it("returns error for invalid ownership_state", async () => {
    const ctx = toolEnv({ overlayStore: createMockOverlayStore() });
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

// ─── set_officer_overlay ────────────────────────────────────

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
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        setOfficerOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    });
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
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        setOfficerOverlay: vi.fn().mockResolvedValue(mockOverlay),
      }),
    });
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
    const ctx = toolEnv({ overlayStore: createMockOverlayStore() });
    const result = await executeFleetTool("set_officer_overlay", {
      level: 50,
    }, ctx) as Record<string, unknown>;
    expect(result).toHaveProperty("error");
    expect((result.error as string)).toContain("officer_id");
  });

  it("returns error for invalid ownership_state", async () => {
    const ctx = toolEnv({ overlayStore: createMockOverlayStore() });
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
