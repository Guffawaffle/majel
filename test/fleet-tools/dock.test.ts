/**
 * fleet-tools/dock.test.ts — Tests for dock/fleet state read tools
 *
 * Covers: list_docks, get_officer_conflicts, analyze_fleet
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockCrewStore,
  FIXTURE_PLAN_ITEM,
} from "./helpers.js";

describe("list_docks", () => {
  it("returns dock assignments", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore(), referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("list_docks", {}, ctx) as Record<string, unknown>;
    const docks = result.docks as Array<Record<string, unknown>>;
    expect(docks).toHaveLength(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[0].assignment).toBeDefined();
    expect((docks[0].assignment as Record<string, unknown>).loadoutName).toBe("Kirk Crew");
    expect((docks[0].assignment as Record<string, unknown>).shipName).toBe("USS Enterprise");
    expect(((docks[0].assignment as Record<string, unknown>).bridgeNames as Record<string, unknown>).captain).toBe("James T. Kirk");
    expect(docks[1].dockNumber).toBe(2);
    expect((docks[1] as Record<string, unknown>).assignment).toBeNull();
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("list_docks", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

describe("get_officer_conflicts", () => {
  it("returns conflict data", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore(), referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("get_officer_conflicts", {}, ctx) as Record<string, unknown>;
    expect(result.totalConflicts).toBe(1);
    const conflicts = result.conflicts as Array<Record<string, unknown>>;
    expect(conflicts[0].officerId).toBe("officer-kirk");
    expect(conflicts[0].officerName).toBe("James T. Kirk");
    expect((conflicts[0].locations as unknown[]).length).toBe(2);
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("get_officer_conflicts", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});


describe("analyze_fleet", () => {
  it("gathers comprehensive fleet state", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([FIXTURE_PLAN_ITEM]),
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Kirk Crew", shipId: "ship-enterprise",
          isActive: true, intentKeys: ["pvp"],
        }]),
      }),
    });
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
    const result = await executeFleetTool("analyze_fleet", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });
});

