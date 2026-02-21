import { describe, it, expect } from "vitest";
import { resolveGuidedSetupSuggestions } from "./guided-setup-templates.js";
import type { CatalogOfficer, CatalogShip } from "./types.js";

function makeOfficer(id: string, name: string, ownershipState: "unknown" | "owned" | "unowned"): CatalogOfficer {
  return {
    id,
    name,
    rarity: null,
    groupName: null,
    captainManeuver: null,
    officerAbility: null,
    belowDeckAbility: null,
    abilities: null,
    tags: null,
    officerGameId: null,
    officerClass: null,
    faction: null,
    synergyId: null,
    maxRank: null,
    traitConfig: null,
    source: "test",
    ownershipState,
    target: false,
    userLevel: null,
    userRank: null,
    userPower: null,
    targetNote: null,
    targetPriority: null,
  };
}

function makeShip(id: string, name: string, ownershipState: "unknown" | "owned" | "unowned"): CatalogShip {
  return {
    id,
    name,
    shipClass: null,
    grade: null,
    rarity: null,
    faction: null,
    tier: null,
    hullType: null,
    buildTimeInSeconds: null,
    maxTier: null,
    maxLevel: null,
    blueprintsRequired: null,
    gameId: null,
    ability: null,
    officerBonus: null,
    source: "test",
    ownershipState,
    target: false,
    userTier: null,
    userLevel: null,
    userPower: null,
    targetNote: null,
    targetPriority: null,
  };
}

describe("resolveGuidedSetupSuggestions", () => {
  it("matches selected template entities and pre-checks already owned records", () => {
    const officers: CatalogOfficer[] = [
      makeOfficer("o1", "Kirk", "owned"),
      makeOfficer("o2", "Spock", "unknown"),
      makeOfficer("o3", "T'Pring", "unowned"),
    ];
    const ships: CatalogShip[] = [
      makeShip("s1", "USS Enterprise", "unknown"),
      makeShip("s2", "D'Vor", "owned"),
      makeShip("s3", "Franklin", "unknown"),
    ];

    const result = resolveGuidedSetupSuggestions(officers, ships, ["pvp", "mining"]);

    expect(result.officers.map((item) => item.name)).toEqual(["Kirk", "Spock", "T'Pring"]);
    expect(result.ships.map((item) => item.name)).toEqual(["D'Vor", "USS Enterprise"]);

    expect(result.officers.find((item) => item.name === "Kirk")?.checked).toBe(true);
    expect(result.officers.find((item) => item.name === "Spock")?.checked).toBe(false);
    expect(result.ships.find((item) => item.name === "D'Vor")?.checked).toBe(true);
  });
});
