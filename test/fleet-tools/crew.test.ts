/**
 * fleet-tools/crew.test.ts — Crew composition mutation tests
 *
 * Tests for: create_bridge_core, create_loadout, activate_preset,
 * set_reservation, create_variant, get_effective_state.
 *
 * Extracted from fleet-tools.test.ts (#193).
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockCrewStore,
} from "./helpers.js";

// ─── ADR-025 Mutation Tools ─────────────────────────────────

describe("create_bridge_core", () => {
  it("creates a bridge core with three officers", async () => {
    const ctx = toolEnv({
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
    });
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
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_bridge_core", {
      captain: "a", bridge_1: "b", bridge_2: "c",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });

  it("returns error for missing bridge slots", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_bridge_core", {
      name: "X", captain: "a",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("bridge slots");
  });

  it("detects duplicate by name (#81)", async () => {
    const ctx = toolEnv({
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
    });
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
    const ctx = toolEnv({
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
    });
    // Same officers, different name and different slots
    const result = await executeFleetTool("create_bridge_core", {
      name: "TOS Bridge", captain: "mccoy", bridge_1: "kirk", bridge_2: "spock",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
    expect(result.existingId).toBe(7);
    expect(result.existingName).toBe("Original Trio");
  });

  it("detects name duplicate case-insensitively (#81)", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listBridgeCores: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Crew",
          members: [{ officerId: "a", slot: "captain" }, { officerId: "b", slot: "bridge_1" }, { officerId: "c", slot: "bridge_2" }],
        }]),
      }),
    });
    const result = await executeFleetTool("create_bridge_core", {
      name: "pvp crew", captain: "x", bridge_1: "y", bridge_2: "z",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
  });
});

describe("create_loadout", () => {
  it("creates a loadout with ship and name", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        createLoadout: vi.fn().mockResolvedValue({
          id: 10,
          name: "Mining Alpha",
          shipId: "ship-enterprise",
        }),
      }),
    });
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
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_loadout", { name: "Y" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Ship ID");
  });

  it("returns error for missing name", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_loadout", { ship_id: "x" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });

  it("detects duplicate loadout by name within ship (#81)", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Mining Alpha", shipId: "ship-enterprise",
        }]),
      }),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Mining Alpha", shipId: "ship-enterprise",
        }]),
      }),
    });
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-enterprise", name: "mining alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
  });

  it("allows same loadout name on different ships (#81)", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),  // empty for different ship
        createLoadout: vi.fn().mockResolvedValue({
          id: 11, name: "Mining Alpha", shipId: "ship-saladin",
        }),
      }),
    });
    const result = await executeFleetTool("create_loadout", {
      ship_id: "ship-saladin", name: "Mining Alpha",
    }, ctx) as Record<string, unknown>;
    expect(result.created).toBe(true);
  });
});

describe("activate_preset", () => {
  it("returns a guided action with preset details", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        getFleetPreset: vi.fn().mockResolvedValue({
          id: 5, name: "War Preset", isActive: false, slots: [{ dockNumber: 1, loadoutId: 10 }],
        }),
      }),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        getFleetPreset: vi.fn().mockResolvedValue(null),
      }),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        setReservation: vi.fn().mockResolvedValue({
          officerId: "kirk",
          reservedFor: "PvP Crew",
          locked: true,
        }),
      }),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        deleteReservation: vi.fn().mockResolvedValue(true),
      }),
    });
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
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("set_reservation", {
      reserved_for: "PvP",
    }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Officer ID");
  });
});

describe("create_variant", () => {
  it("creates a variant with bridge overrides", async () => {
    const ctx = toolEnv({
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
    });
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
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_variant", { name: "X" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("loadout ID");
  });

  it("returns error for missing name", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("create_variant", { loadout_id: 10 }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Name");
  });

  it("detects duplicate variant by name within loadout (#81)", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listVariants: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Swap", baseLoadoutId: 10,
        }]),
      }),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listVariants: vi.fn().mockResolvedValue([{
          id: 3, name: "PvP Swap", baseLoadoutId: 10,
        }]),
      }),
    });
    const result = await executeFleetTool("create_variant", {
      loadout_id: 10, name: "pvp swap",
    }, ctx) as Record<string, unknown>;
    expect(result.status).toBe("duplicate_detected");
  });
});

describe("get_effective_state", () => {
  it("returns effective dock state with conflicts", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore(),
    });
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
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listFleetPresets: vi.fn().mockResolvedValue([
          { id: 1, name: "War Config", isActive: true },
        ]),
      }),
    });
    const result = await executeFleetTool("get_effective_state", {}, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("get_effective_state");
    const preset = result.activePreset as Record<string, unknown>;
    expect(preset.id).toBe(1);
    expect(preset.name).toBe("War Config");
  });

  it("returns error when crew store unavailable", async () => {
    const result = await executeFleetTool("get_effective_state", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});
