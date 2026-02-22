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

// ═══════════════════════════════════════════════════════════════
// Effect-Based Scoring (ADR-034)
// ═══════════════════════════════════════════════════════════════

import type { EffectBundleData } from "../web/src/lib/effect-bundle-adapter.js";
import type { OfficerAbility, EffectTag, TargetContext, IntentDefinition } from "../web/src/lib/types/effect-types.js";

/**
 * Build a minimal EffectBundleData for testing.
 */
function makeEffectBundle(opts: {
  officers: Record<string, OfficerAbility[]>;
  intents: Record<string, { weights: Record<string, number>; ctx?: Partial<TargetContext> }>;
}): EffectBundleData {
  const intentWeights = new Map<string, Record<string, number>>();
  const intents = new Map<string, IntentDefinition>();
  const officerAbilities = new Map<string, OfficerAbility[]>();

  for (const [key, def] of Object.entries(opts.intents)) {
    intentWeights.set(key, def.weights);
    intents.set(key, {
      id: key,
      name: key,
      description: `${key} intent`,
      defaultContext: {
        targetKind: "hostile",
        engagement: "any",
        targetTags: ["pve"],
        ...def.ctx,
      } as TargetContext,
      effectWeights: def.weights,
    });
  }

  for (const [id, abilities] of Object.entries(opts.officers)) {
    officerAbilities.set(id, abilities);
  }

  return { schemaVersion: "1.0.0", intentWeights, officerAbilities, intents };
}

function makeTestAbility(opts: {
  id: string;
  officerId: string;
  slot: "cm" | "oa" | "bda";
  effects: Partial<EffectTag>[];
  isInert?: boolean;
}): OfficerAbility {
  return {
    id: opts.id,
    officerId: opts.officerId,
    slot: opts.slot,
    name: opts.id,
    rawText: null,
    isInert: opts.isInert ?? false,
    effects: opts.effects.map((e, i) => ({
      id: `${opts.id}-e${i}`,
      abilityId: opts.id,
      effectKey: e.effectKey ?? "damage_dealt",
      magnitude: e.magnitude ?? null,
      unit: e.unit ?? null,
      stacking: e.stacking ?? null,
      applicableTargetKinds: e.applicableTargetKinds ?? [],
      applicableTargetTags: e.applicableTargetTags ?? [],
      conditions: e.conditions ?? [],
    })),
  };
}

const GRINDING_WEIGHTS: Record<string, number> = {
  damage_dealt: 3.0,
  weapon_damage: 2.5,
  crit_chance: 2.0,
  crit_damage: 2.0,
  mitigation: 1.5,
  armor: 1.5,
  hull_health: 1.0,
  shield_health: 1.0,
  officer_attack: 1.0,
  officer_defense: 0.8,
  officer_health: 0.8,
  dodge: 0.5,
};

function makeGrindingBundle(): EffectBundleData {
  return makeEffectBundle({
    intents: {
      grinding: {
        weights: GRINDING_WEIGHTS,
        ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
      },
    },
    officers: {
      "o-kirk": [
        makeTestAbility({
          id: "kirk:cm", officerId: "o-kirk", slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.30, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "kirk:oa", officerId: "o-kirk", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.20, applicableTargetKinds: ["hostile"] }],
        }),
      ],
      "o-spock": [
        makeTestAbility({
          id: "spock:cm", officerId: "o-spock", slot: "cm",
          effects: [{ effectKey: "crit_chance", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "spock:oa", officerId: "o-spock", slot: "oa",
          effects: [
            { effectKey: "officer_attack", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
            { effectKey: "officer_defense", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
            { effectKey: "officer_health", magnitude: 0.15, applicableTargetKinds: ["hostile"] },
          ],
        }),
      ],
      "o-mccoy": [
        makeTestAbility({
          id: "mccoy:cm", officerId: "o-mccoy", slot: "cm",
          effects: [{ effectKey: "hull_health", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        }),
        makeTestAbility({
          id: "mccoy:oa", officerId: "o-mccoy", slot: "oa",
          effects: [{
            effectKey: "mitigation", magnitude: 0.15, applicableTargetKinds: ["hostile"],
            conditions: [{ conditionKey: "at_round_start", params: null }],
          }],
        }),
      ],
      "o-sulu": [
        makeTestAbility({
          id: "sulu:cm", officerId: "o-sulu", slot: "cm",
          effects: [{
            effectKey: "dodge", magnitude: 0.20,
            conditions: [{ conditionKey: "at_combat_start", params: null }],
          }],
        }),
        makeTestAbility({
          id: "sulu:oa", officerId: "o-sulu", slot: "oa",
          effects: [{
            effectKey: "weapon_damage", magnitude: 0.10,
            conditions: [{ conditionKey: "requires_attacking", params: null }],
          }],
        }),
      ],
      "o-ivanov": [
        makeTestAbility({
          id: "ivanov:cm", officerId: "o-ivanov", slot: "cm",
          effects: [{
            effectKey: "weapon_damage", magnitude: 0.10,
            conditions: [{ conditionKey: "at_round_start", params: null }],
          }],
        }),
        makeTestAbility({
          id: "ivanov:oa", officerId: "o-ivanov", slot: "oa",
          effects: [{
            effectKey: "armor", magnitude: 0.10,
            conditions: [{ conditionKey: "requires_defending", params: null }],
          }],
        }),
      ],
    },
  });
}

describe("effect-based scoring (ADR-034)", () => {
  const bundle = makeGrindingBundle();

  it("returns non-zero effectScore when bundle is provided", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    expect(score.effectScore).toBeGreaterThan(0);
    expect(score.goalFit).toBe(0);
    expect(score.shipFit).toBe(0);
    expect(score.counterFit).toBe(0);
  });

  it("returns zero effectScore when bundle is absent (legacy path)", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
    });
    expect(score.effectScore).toBe(0);
  });

  it("Kirk scores higher than Sulu as captain for grinding", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const sulu = makeOfficer({ id: "o-sulu", name: "Sulu", userLevel: 60, userPower: 1000 });

    const kirkScore = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    const suluScore = scoreOfficerForSlot(sulu, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });

    expect(kirkScore.effectScore).toBeGreaterThan(suluScore.effectScore);
  });

  it("officer not in bundle gets effectScore 0", () => {
    const unknown = makeOfficer({ id: "o-unknown", name: "Unknown", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(unknown, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    expect(score.effectScore).toBe(0);
    expect(score.readiness).toBeGreaterThan(0);
  });
});

describe("effect-based captain gating", () => {
  const bundle = makeGrindingBundle();

  it("captain with useful CM gets positive captainBonus", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    expect(score.captainBonus).toBeGreaterThan(0);
  });

  it("captain without effects in bundle gets negative captainBonus", () => {
    const noEffects = makeOfficer({ id: "o-unknown", name: "No Effects", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(noEffects, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    expect(score.captainBonus).toBeLessThan(0);
  });

  it("bridge slot gets zero captainBonus", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const score = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    expect(score.captainBonus).toBe(0);
  });
});

describe("effect-based synergy multiplier", () => {
  it("synergy is multiplicative, not additive", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: GRINDING_WEIGHTS,
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:cm", officerId: "o-a", slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.20, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b": [makeTestAbility({
          id: "b:oa", officerId: "o-b", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.10, applicableTargetKinds: ["hostile"] }],
        })],
        "o-c": [makeTestAbility({
          id: "c:oa", officerId: "o-c", slot: "oa",
          effects: [{ effectKey: "crit_chance", magnitude: 0.10, applicableTargetKinds: ["hostile"] }],
        })],
        "o-d": [makeTestAbility({
          id: "d:oa", officerId: "o-d", slot: "oa",
          effects: [{ effectKey: "mitigation", magnitude: 0.10, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const officers = [
      makeOfficer({ id: "o-a", name: "A", synergyId: 1, userLevel: 30, userPower: 100 }),
      makeOfficer({ id: "o-b", name: "B", synergyId: 1, userLevel: 30, userPower: 100 }),
      makeOfficer({ id: "o-c", name: "C", synergyId: 1, userLevel: 30, userPower: 100 }),
      makeOfficer({ id: "o-d", name: "D", synergyId: null, userLevel: 30, userPower: 100 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      captainId: "o-a",
      limit: 5,
      effectBundle: bundle,
    });

    const synergyTrio = recs.find((r) =>
      [r.bridge1Id, r.bridge2Id].sort().join(",") === ["o-b", "o-c"].sort().join(","),
    );
    const partialTrio = recs.find((r) =>
      [r.bridge1Id, r.bridge2Id].sort().join(",") === ["o-b", "o-d"].sort().join(","),
    );

    expect(synergyTrio).toBeDefined();
    expect(partialTrio).toBeDefined();

    const synergyFactor = synergyTrio!.factors.find((f) => f.key === "synergy");
    const partialFactor = partialTrio!.factors.find((f) => f.key === "synergy");
    expect(synergyFactor!.score).toBeGreaterThan(partialFactor!.score);
    expect(synergyTrio!.totalScore).toBeGreaterThan(partialTrio!.totalScore);
  });
});

describe("golden trio regression: Kirk/Spock/McCoy > Sulu/Spock/Ivanov for grinding", () => {
  const bundle = makeGrindingBundle();

  it("effect-based recommender ranks Kirk trio above Sulu trio", () => {
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", synergyId: 1, userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", synergyId: 1, userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", synergyId: 1, userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-sulu", name: "Sulu", synergyId: 2, userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-ivanov", name: "Ivanov", synergyId: 2, userLevel: 60, userPower: 1000 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 10,
      effectBundle: bundle,
    });

    expect(recs.length).toBeGreaterThan(0);

    const kirkTrio = recs.find((r) =>
      r.captainId === "o-kirk"
      && [r.bridge1Id, r.bridge2Id].sort().join(",") === ["o-mccoy", "o-spock"].sort().join(","),
    );
    const suluTrio = recs.find((r) =>
      r.captainId === "o-sulu"
      && [r.bridge1Id, r.bridge2Id].sort().join(",") === ["o-ivanov", "o-spock"].sort().join(","),
    );

    expect(kirkTrio).toBeDefined();
    if (suluTrio) {
      expect(kirkTrio!.totalScore).toBeGreaterThan(suluTrio.totalScore);
    }
    expect(recs[0]?.captainId).toBe("o-kirk");
  });

  it("Sulu does NOT falsely outscore Kirk for hostile grinding (regression)", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const sulu = makeOfficer({ id: "o-sulu", name: "Sulu", userLevel: 60, userPower: 1000 });

    const kirkScore = scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });
    const suluScore = scoreOfficerForSlot(sulu, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    });

    expect(kirkScore.effectScore).toBeGreaterThan(suluScore.effectScore * 2);
  });

  it("produces structured reasons mentioning effect keys", () => {
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 1,
      effectBundle: bundle,
    });

    expect(recs.length).toBe(1);
    const rec = recs[0]!;

    const reasons = rec.reasons.join(" ");
    expect(reasons).toMatch(/damage|weapon|crit/i);
    const effectFactor = rec.factors.find((f) => f.key === "effectScore");
    expect(effectFactor).toBeDefined();
    expect(effectFactor!.score).toBeGreaterThan(0);
  });

  it("honors preferred captain with effect scoring", () => {
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-sulu", name: "Sulu", userLevel: 60, userPower: 1000 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      captainId: "o-sulu",
      limit: 5,
      effectBundle: bundle,
    });

    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.captainId === "o-sulu")).toBe(true);
  });
});
