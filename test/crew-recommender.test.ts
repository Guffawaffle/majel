import { describe, expect, it } from "vitest";
import { recommendBridgeTrios, scoreOfficerForSlot } from "../web/src/lib/crew-recommender.js";
import type { CatalogOfficer } from "../web/src/lib/types.js";

function makeOfficer(input: Partial<CatalogOfficer> & { id: string; name: string }): CatalogOfficer {
  const { id, name, ...rest } = input;
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
    ownershipState: "owned",
    target: false,
    userLevel: 30,
    userRank: null,
    userPower: 100,
    targetNote: null,
    targetPriority: null,
    ...rest,
  };
}

describe("crew-recommender mining specificity", () => {
  it("prefers Gas-specific captain maneuver for mining-gas", () => {
    const tpring = makeOfficer({
      id: "o-tpring",
      name: "T'Pring",
      captainManeuver: "T'Pring increases the Mining Rate of the ship when mining Gas.",
      officerAbility: "Increases protected cargo.",
      userLevel: 10,
      userPower: 30,
      abilities: {
        captainManeuver: {
          name: "Gas Miner",
          shortDescription: "Increases mining rate when mining Gas.",
          description: "Captain Maneuver",
        },
      },
    });

    const genericMinerCaptain = makeOfficer({
      id: "o-generic-cm",
      name: "Generic Miner",
      captainManeuver: "Increases Mining Speed of the ship.",
      officerAbility: "Minor combat effect.",
      userLevel: 60,
      userPower: 600,
      abilities: {
        captainManeuver: {
          name: "Advanced Mining",
          shortDescription: "Increases mining speed.",
          description: "Captain Maneuver",
        },
      },
    });

    const gasOnlyOfficerAbility = makeOfficer({
      id: "o-gas-oa",
      name: "Gas OA Specialist",
      captainManeuver: "Reduces incoming damage.",
      officerAbility: "Increases Gas mining speed.",
      userLevel: 60,
      userPower: 700,
      abilities: {
        officerAbility: {
          name: "Gas Extraction",
          shortDescription: "Increases Gas mining speed.",
          description: "Officer Ability",
        },
      },
    });

    const utility = makeOfficer({
      id: "o-utility",
      name: "Utility",
      officerAbility: "Increases protected cargo while mining.",
      userLevel: 20,
      userPower: 120,
    });

    const recommendations = recommendBridgeTrios({
      officers: [tpring, genericMinerCaptain, gasOnlyOfficerAbility, utility],
      reservations: [],
      intentKey: "mining-gas",
      limit: 3,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]?.captainId).toBe("o-tpring");
  });

  it("treats OA as active on captain slot", () => {
    const tpring = makeOfficer({
      id: "tpring",
      name: "T'Pring",
      captainManeuver: "Increases Gas mining speed when captain.",
      abilities: { captainManeuver: { name: "Gas Miner" } },
    });

    const oaOnly = makeOfficer({
      id: "oa-only",
      name: "OA Only",
      captainManeuver: "Boosts shields.",
      officerAbility: "Increases Gas mining speed on bridge.",
      abilities: { officerAbility: { name: "Gas Mining" } },
    });

    const captainScore = scoreOfficerForSlot(tpring, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "captain",
    });

    const oaCaptainScore = scoreOfficerForSlot(oaOnly, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "captain",
    });

    expect(captainScore.goalFit).toBeGreaterThan(0);
    expect(oaCaptainScore.goalFit).toBeGreaterThan(0);
  });

  it("counts OA for captain slot because captain is on bridge", () => {
    const oaOnlyCaptain = makeOfficer({
      id: "oa-captain",
      name: "OA Captain",
      captainManeuver: "Boosts armor in combat.",
      officerAbility: "Increases Gas mining speed on bridge.",
      abilities: {
        officerAbility: {
          name: "Gas Specialist",
          shortDescription: "Increases Gas mining speed.",
        },
      },
    });

    const captainScore = scoreOfficerForSlot(oaOnlyCaptain, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "captain",
    });

    expect(captainScore.goalFit).toBeGreaterThan(0);
  });

  it("does not count BDA text for bridge slots", () => {
    const bdaOnly = makeOfficer({
      id: "bda-only",
      name: "BDA Only",
      belowDeckAbility: "Increases Gas mining speed when assigned below decks.",
      abilities: {
        belowDeckAbility: {
          name: "Below Deck Gas Mining",
          shortDescription: "Gas mining boost from below decks.",
        },
      },
    });

    const captainScore = scoreOfficerForSlot(bdaOnly, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "captain",
    });

    const bridgeScore = scoreOfficerForSlot(bdaOnly, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "bridge_1",
    });

    expect(captainScore.goalFit).toBe(0);
    expect(bridgeScore.goalFit).toBe(0);
  });

  it("honors preferred captain even when outside default captain shortlist", () => {
    const preferredCaptain = makeOfficer({
      id: "preferred-captain",
      name: "Preferred Captain",
      captainManeuver: "No mining bonus here.",
      userLevel: 1,
      userPower: 1,
    });

    const bridgeA = makeOfficer({
      id: "bridge-a",
      name: "Bridge A",
      officerAbility: "Increases Gas mining speed.",
      userLevel: 40,
      userPower: 400,
    });

    const bridgeB = makeOfficer({
      id: "bridge-b",
      name: "Bridge B",
      officerAbility: "Improves protected cargo while mining.",
      userLevel: 40,
      userPower: 400,
    });

    const filler = Array.from({ length: 12 }, (_, idx) => makeOfficer({
      id: `filler-${idx}`,
      name: `Filler ${idx}`,
      captainManeuver: "Increases Gas mining speed when captain.",
      userLevel: 60,
      userPower: 900 + idx,
    }));

    const recommendations = recommendBridgeTrios({
      officers: [preferredCaptain, bridgeA, bridgeB, ...filler],
      reservations: [],
      intentKey: "mining-gas",
      captainId: preferredCaptain.id,
      limit: 3,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.every((rec) => rec.captainId === preferredCaptain.id)).toBe(true);
  });

  it("applies captain bonus when CM is present only in structured abilities", () => {
    const structuredCmOnly = makeOfficer({
      id: "structured-cm-only",
      name: "Structured CM Only",
      captainManeuver: null,
      officerAbility: "No mining bonus.",
      abilities: {
        captainManeuver: {
          name: "Gas Captain",
          shortDescription: "Increases Gas mining speed.",
        },
      },
    });

    const score = scoreOfficerForSlot(structuredCmOnly, {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 100,
      slot: "captain",
    });

    expect(score.captainBonus).toBe(3);
  });

  it("uses top-scoring bridge officers even when they appear late in input order", () => {
    const captain = makeOfficer({
      id: "captain",
      name: "Captain",
      captainManeuver: "No mining bonus here.",
      userLevel: 1,
      userPower: 1,
    });

    const weakBridge = Array.from({ length: 20 }, (_, idx) => makeOfficer({
      id: `weak-${idx}`,
      name: `Weak ${idx}`,
      officerAbility: "Minor combat effect.",
      userLevel: 1,
      userPower: 1,
    }));

    const strongA = makeOfficer({
      id: "strong-a",
      name: "Strong A",
      officerAbility: "Increases Gas mining speed while mining.",
      userLevel: 60,
      userPower: 1200,
    });

    const strongB = makeOfficer({
      id: "strong-b",
      name: "Strong B",
      officerAbility: "Increases Gas mining speed and protected cargo while mining.",
      userLevel: 60,
      userPower: 1300,
    });

    const recommendations = recommendBridgeTrios({
      officers: [captain, ...weakBridge, strongA, strongB],
      reservations: [],
      intentKey: "mining-gas",
      captainId: captain.id,
      limit: 5,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    const top = recommendations[0];
    expect(top?.captainId).toBe(captain.id);
    expect([top?.bridge1Id, top?.bridge2Id]).toContain("strong-a");
    expect([top?.bridge1Id, top?.bridge2Id]).toContain("strong-b");
  });
});
