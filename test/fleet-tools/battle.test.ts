/**
 * fleet-tools/battle.test.ts — Tests for battle analysis tools
 *
 * Covers: analyze_battle_log, suggest_counter
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockResearchStore,
  createMockOverlayStore,
  FIXTURE_OFFICER,
  FIXTURE_OFFICER_OVERLAY,
  FIXTURE_SPOCK_OFFICER,
} from "./helpers.js";

describe("analyze_battle_log", () => {
  const SAMPLE_BATTLE_LOG = {
    battle_id: "battle-123",
    mode: "pvp",
    attacker_officers: ["officer-kirk"],
    defender_officers: ["officer-spock"],
    rounds: [
      {
        round: 1,
        damage_received: [{ amount: 12000, type: "energy", source_ability: "Opening Volley" }],
        damage_dealt: [{ amount: 10000, type: "kinetic" }],
        ability_triggers: ["Opening Volley"],
        hull_after: 88000,
        shield_after: 43000,
      },
      {
        round: 2,
        damage_received: [{ amount: 94000, type: "energy", source_ability: "Focused Barrage" }],
        damage_dealt: [{ amount: 14000, type: "kinetic" }],
        ability_triggers: ["Focused Barrage"],
        hull_after: 0,
        shield_after: 0,
        destroyed: true,
      },
    ],
  };

  it("parses rounds and identifies failure point", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockImplementation(async (id: string) => {
          if (id === "officer-kirk") return FIXTURE_OFFICER;
          if (id === "officer-spock") return FIXTURE_SPOCK_OFFICER;
          return null;
        }),
      }),
      researchStore: createMockResearchStore(),
    });

    const result = await executeFleetTool("analyze_battle_log", { battle_log: SAMPLE_BATTLE_LOG }, ctx) as Record<string, unknown>;
    expect(result.error).toBeUndefined();

    const failure = result.failurePoint as Record<string, unknown>;
    expect(failure.round).toBe(2);
    expect(failure.likelyCause).toBe("energy_spike_broke_shields");

    const rounds = result.roundByRound as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(2);

    const abilityHighlights = result.abilityHighlights as Record<string, unknown>;
    const officerAbilities = abilityHighlights.officerAbilities as Array<Record<string, unknown>>;
    expect(officerAbilities.length).toBeGreaterThanOrEqual(1);

    const researchContext = result.researchContext as Record<string, unknown>;
    const referencedBuffs = researchContext.referencedBuffs as Array<Record<string, unknown>>;
    expect(referencedBuffs.length).toBeGreaterThan(0);
  });

  it("returns error for invalid payload", async () => {
    const result = await executeFleetTool("analyze_battle_log", { battle_log: { rounds: [] } }, {});
    expect(result).toHaveProperty("error");
  });
});

describe("suggest_counter", () => {
  const SAMPLE_BATTLE_LOG = {
    battle_id: "battle-123",
    mode: "pvp",
    rounds: [
      {
        round: 1,
        damage_received: [{ amount: 120000, type: "kinetic" }],
        damage_dealt: [{ amount: 35000, type: "energy" }],
        ability_triggers: ["Impact Burst"],
        hull_after: 0,
        shield_after: 0,
        destroyed: true,
      },
    ],
  };

  it("returns concrete swap/counter recommendations", async () => {
    const defensiveOfficer = {
      ...FIXTURE_OFFICER,
      id: "officer-def",
      name: "Defense Specialist",
      officerAbility: "Boosts hull mitigation against kinetic damage",
    };
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue([defensiveOfficer]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([
          { ...FIXTURE_OFFICER_OVERLAY, refId: "officer-def" },
        ]),
      }),
      researchStore: createMockResearchStore(),
    });

    const result = await executeFleetTool("suggest_counter", { battle_log: SAMPLE_BATTLE_LOG }, ctx) as Record<string, unknown>;
    const changes = result.recommendedChanges as Array<Record<string, unknown>>;
    expect(changes.length).toBeGreaterThanOrEqual(3);

    const crew = changes.find((entry) => entry.category === "crew") as Record<string, unknown>;
    const swaps = crew.swaps as Array<Record<string, unknown>>;
    expect(swaps.length).toBeGreaterThanOrEqual(1);
    expect(swaps[0].officerName).toBe("Defense Specialist");
  });

  it("gracefully degrades without research store", async () => {
    const result = await executeFleetTool("suggest_counter", { battle_log: SAMPLE_BATTLE_LOG }, toolEnv()) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    const quality = result.dataQuality as Record<string, unknown>;
    expect(quality.hasResearchContext).toBe(false);
  });
});

