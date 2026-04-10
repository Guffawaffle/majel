/**
 * fleet-tools/armada-context.test.ts — Tests for get_armada_context
 *
 * Covers: availability check, away team locks, officer reservations, loadout_ids filter
 */

import { describe, it, expect, vi } from "vitest";
import { executeFleetTool, toolEnv, createMockCrewStore, createMockReferenceStore, FIXTURE_PLAN_ITEM } from "./helpers.js";

describe("get_armada_context", () => {
  it("returns all ships available when no locks exist", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore(),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;

    expect(result.totalAssignedShips).toBe(1);
    expect(result.availableForArmada).toBe(1);
    expect(result.lockedOrUnavailable).toBe(0);

    const ships = result.ships as Array<Record<string, unknown>>;
    expect(ships).toHaveLength(1);
    expect(ships[0].available).toBe(true);
    expect(ships[0].lockReasons).toEqual([]);
    expect(ships[0].loadoutId).toBe(10);
    expect(ships[0].loadoutName).toBe("Kirk Crew");
    expect(ships[0].shipName).toBe("USS Enterprise");
    expect(ships[0].dockNumber).toBe(1);
  });

  it("marks ship unavailable when bridge officer is in an away team", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          {
            ...FIXTURE_PLAN_ITEM,
            awayOfficers: ["officer-kirk"],
          },
        ]),
      }),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;

    expect(result.availableForArmada).toBe(0);
    expect(result.lockedOrUnavailable).toBe(1);

    const ships = result.ships as Array<Record<string, unknown>>;
    expect(ships[0].available).toBe(false);
    const lockReasons = ships[0].lockReasons as Array<Record<string, unknown>>;
    expect(lockReasons).toHaveLength(1);
    expect(lockReasons[0].type).toBe("away_team");
    expect(lockReasons[0].officerId).toBe("officer-kirk");
    expect(typeof lockReasons[0].detail).toBe("string");
    expect(lockReasons[0].detail).toContain("Arena PvP");
  });

  it("marks ship unavailable when bridge officer has a hard reservation", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listReservations: vi.fn().mockResolvedValue([
          {
            officerId: "officer-spock",
            reservedFor: "Armada Node",
            locked: true,
            notes: null,
            createdAt: "2024-01-01T00:00:00Z",
          },
        ]),
      }),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;

    expect(result.availableForArmada).toBe(0);

    const ships = result.ships as Array<Record<string, unknown>>;
    expect(ships[0].available).toBe(false);
    const lockReasons = ships[0].lockReasons as Array<Record<string, unknown>>;
    expect(lockReasons).toHaveLength(1);
    expect(lockReasons[0].type).toBe("officer_reserved");
    expect(lockReasons[0].officerId).toBe("officer-spock");
    expect(lockReasons[0].detail).toContain("Armada Node");
  });

  it("does not lock ship for unlocked (soft) reservations", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listReservations: vi.fn().mockResolvedValue([
          {
            officerId: "officer-kirk",
            reservedFor: "Soft Plan",
            locked: false,
            notes: null,
            createdAt: "2024-01-01T00:00:00Z",
          },
        ]),
      }),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;

    const ships = result.ships as Array<Record<string, unknown>>;
    expect(ships[0].available).toBe(true);
    expect(ships[0].lockReasons).toEqual([]);
  });

  it("filters to specified loadout_ids", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore(),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", { loadout_ids: [10] }, ctx) as Record<string, unknown>;
    expect(result.totalAssignedShips).toBe(1);
    expect((result.ships as unknown[]).length).toBe(1);
  });

  it("returns empty ships when loadout_ids do not match any dock", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore(),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", { loadout_ids: [999] }, ctx) as Record<string, unknown>;
    expect(result.totalAssignedShips).toBe(0);
    expect(result.availableForArmada).toBe(0);
    expect(result.note).toContain("No assigned ships");
  });

  it("returns error when crewStore is unavailable", async () => {
    const result = await executeFleetTool("get_armada_context", {}, toolEnv());
    expect(result).toHaveProperty("error");
  });

  it("returns note when no docks are assigned", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        getEffectiveDockState: vi.fn().mockResolvedValue({
          docks: [
            { dockNumber: 1, loadout: null, variantPatch: null, intentKeys: [], source: "manual" as const },
          ],
          awayTeams: [],
          conflicts: [],
        }),
      }),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;
    expect(result.totalAssignedShips).toBe(0);
    expect(result.note).toBeDefined();
    expect(typeof result.note).toBe("string");
  });

  it("includes bridge officer names in output", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore(),
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("get_armada_context", {}, ctx) as Record<string, unknown>;
    const ships = result.ships as Array<Record<string, unknown>>;
    const bridge = ships[0].bridge as Record<string, { id: string; name: string | null }>;
    expect(bridge.captain).toBeDefined();
    expect(bridge.captain.id).toBe("officer-kirk");
    expect(typeof bridge.captain.name).toBe("string");
  });
});
