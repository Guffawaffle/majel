/**
 * fleet-tools/context.test.ts — Tests for context read tools
 *
 * Covers: list_active_events, list_away_teams, get_faction_standing
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockUserSettingsStore,
  createMockCrewStore,
  FIXTURE_PLAN_ITEM,
} from "./helpers.js";

describe("list_active_events", () => {
  it("returns normalized active events from user settings", async () => {
    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    });

    const result = await executeFleetTool("list_active_events", {}, ctx) as Record<string, unknown>;
    expect(result.totalEvents).toBe(1);
    expect(result.totalActiveEvents).toBe(1);

    const events = result.events as Array<Record<string, unknown>>;
    expect(events[0].name).toBe("Klingon Separatists");
    expect(events[0].type).toBe("hostile_hunt");
    expect(events[0].isActive).toBe(true);
  });

  it("returns empty payload when user settings store is unavailable", async () => {
    const result = await executeFleetTool("list_active_events", {}, toolEnv({ userId: "u-1" })) as Record<string, unknown>;
    expect(result.totalEvents).toBe(0);
    expect(result.source).toBe("unavailable");
  });
});

describe("list_away_teams", () => {
  it("returns locked officers from settings and plan items", async () => {
    const ctx = toolEnv({
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
    });

    const result = await executeFleetTool("list_away_teams", {}, ctx) as Record<string, unknown>;
    const lockedOfficerIds = result.lockedOfficerIds as string[];
    expect(lockedOfficerIds).toContain("officer-kirk");
    expect(lockedOfficerIds).toContain("officer-spock");
    expect(result.totalAssignments).toBe(2);
  });
});

describe("get_faction_standing", () => {
  it("returns normalized faction standings with store access", async () => {
    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    });

    const result = await executeFleetTool("get_faction_standing", {}, ctx) as Record<string, unknown>;
    const standings = result.standings as Array<Record<string, unknown>>;
    expect(standings.length).toBeGreaterThanOrEqual(4);
    const klingon = standings.find((row) => row.faction === "Klingon");
    expect(klingon?.storeAccess).toBe("locked");
  });

  it("filters by faction name", async () => {
    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
    });

    const result = await executeFleetTool("get_faction_standing", { faction: "feder" }, ctx) as Record<string, unknown>;
    const standings = result.standings as Array<Record<string, unknown>>;
    expect(standings).toHaveLength(1);
    expect(standings[0].faction).toBe("Federation");
  });
});

