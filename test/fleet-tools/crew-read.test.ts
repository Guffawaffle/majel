/**
 * fleet-tools/crew-read.test.ts — Tests for crew composition read tools
 *
 * Covers: list_owned_officers, get_loadout_detail, find_loadouts_for_intent,
 *         suggest_crew, resolve_conflict, what_if_remove_officer
 */

import { describe, it, expect, vi } from "vitest";
import type { ReferenceOfficer } from "../../src/server/stores/reference-store.js";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockOverlayStore,
  createMockCrewStore,
  createMockResearchStore,
  createMockUserSettingsStore,
  FIXTURE_OFFICER,
  FIXTURE_OFFICER_OVERLAY,
} from "./helpers.js";

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
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
    });
    const result = await executeFleetTool("list_owned_officers", {}, ctx) as Record<string, unknown>;
    expect(result.totalOwned).toBe(1);
    const officers = result.officers as Array<Record<string, unknown>>;
    expect(officers[0].name).toBe("James T. Kirk");
    expect(officers[0].level).toBe(50);
    expect(officers[0].captainManeuver).toBe("Inspirational");
  });

  it("filters out officers with missing reference data", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
    });
    const result = await executeFleetTool("list_owned_officers", {}, ctx) as Record<string, unknown>;
    expect(result.totalOwned).toBe(0);
  });

  it("returns error when overlay store unavailable", async () => {
    const ctx = toolEnv({ referenceStore: createMockReferenceStore() });
    const result = await executeFleetTool("list_owned_officers", {}, ctx);
    expect(result).toHaveProperty("error");
  });

  it("returns error when reference store unavailable", async () => {
    const ctx = toolEnv({ overlayStore: createMockOverlayStore() });
    const result = await executeFleetTool("list_owned_officers", {}, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("get_loadout_detail", () => {
  it("returns full loadout with crew members", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([FIXTURE_OFFICER, FIXTURE_SPOCK_OFFICER, { ...FIXTURE_OFFICER, id: "officer-bones", name: "Leonard McCoy" }]),
      }),
      crewStore: createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_REFS),
      }),
    });
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 10 }, ctx) as Record<string, unknown>;
    expect(result.name).toBe("Kirk Crew");
    expect(result.shipId).toBe("ship-enterprise");
    expect(result.shipName).toBe("USS Enterprise");
    expect(result.intentKeys).toEqual(["pvp"]);
    const bc = result.bridgeCore as Record<string, unknown>;
    expect(bc).not.toBeNull();
    const members = bc.members as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
    expect(members[0].officerId).toBe("officer-kirk");
    expect(members[0].officerName).toBe("James T. Kirk");
    expect(members[0].slot).toBe("captain");
  });

  it("returns error for nonexistent loadout", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        getLoadout: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 999 }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("get_loadout_detail", { loadout_id: 10 }, {});
    expect(result).toHaveProperty("error");
  });
});


describe("find_loadouts_for_intent", () => {
  it("returns loadouts matching an intent", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{ id: 10, name: "Kirk Crew", shipId: "ship-enterprise", isActive: true, intentKeys: ["pvp"] }]),
        getLoadout: vi.fn().mockResolvedValue(FIXTURE_LOADOUT_WITH_REFS),
      }),
    });
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "pvp" }, ctx) as Record<string, unknown>;
    expect(result.intentKey).toBe("pvp");
    expect(result.totalLoadouts).toBe(1);
    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts[0].name).toBe("Kirk Crew");
  });

  it("returns error for empty intent key", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("required");
  });

  it("returns error when loadout store unavailable", async () => {
    const result = await executeFleetTool("find_loadouts_for_intent", { intent_key: "pvp" }, {});
    expect(result).toHaveProperty("error");
  });
});


describe("suggest_crew", () => {
  it("gathers ship, intent, owned officers, and existing loadouts", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([FIXTURE_LOADOUT_WITH_REFS]),
      }),
      researchStore: createMockResearchStore(),
    });
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
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
      }),
    });
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
    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      referenceStore: createMockReferenceStore(),
      userSettingsStore: createMockUserSettingsStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([FIXTURE_OFFICER_OVERLAY]),
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
      }),
    });

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
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getShip: vi.fn().mockResolvedValue(null),
      }),
    });
    const result = await executeFleetTool("suggest_crew", { ship_id: "nonexistent" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when reference store unavailable", async () => {
    const result = await executeFleetTool("suggest_crew", { ship_id: "ship-enterprise" }, {});
    expect(result).toHaveProperty("error");
  });
});


describe("resolve_conflict", () => {
  it("gathers officer details, conflicts, alternatives, and cascade preview", async () => {
    const ctx = toolEnv({
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
    });
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
    const ctx = toolEnv({
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
    });
    const result = await executeFleetTool(
      "resolve_conflict", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.conflict).toBeNull();
  });

  it("returns error for unknown officer", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(null),
      }),
      crewStore: createMockCrewStore(),
    });
    const result = await executeFleetTool("resolve_conflict", { officer_id: "nonexistent" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("returns error when reference store unavailable", async () => {
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("resolve_conflict", { officer_id: "officer-kirk" }, ctx);
    expect(result).toHaveProperty("error");
  });
});

describe("what_if_remove_officer", () => {
  it("returns cascade preview for officer removal", async () => {
    const ctx = toolEnv({
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
    });
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
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    });
    const result = await executeFleetTool(
      "what_if_remove_officer", { officer_id: "officer-kirk" }, ctx,
    ) as Record<string, unknown>;
    expect(result.totalAffected).toBe(0);
  });

  it("works without reference store (no officer name)", async () => {
    const ctx = toolEnv({
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([]),
        listPlanItems: vi.fn().mockResolvedValue([]),
      }),
    });
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
    const ctx = toolEnv({ crewStore: createMockCrewStore() });
    const result = await executeFleetTool("what_if_remove_officer", { officer_id: "" }, ctx);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("required");
  });
});

// ─── Target/Goal Tracking Tools (#17) ─────────────────────

