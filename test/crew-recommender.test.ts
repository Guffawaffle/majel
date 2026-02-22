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

  it("does not emit legacy reason strings in effect-based output", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    const spock = makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 });
    const mccoy = makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 });

    const recs = recommendBridgeTrios({
      officers: [kirk, spock, mccoy],
      intentKey: "grinding",
      reservations: [],
      limit: 1,
      effectBundle: bundle,
    });

    expect(recs.length).toBe(1);
    const reasons = recs[0]!.reasons.join(" ");
    expect(reasons).not.toContain("Captain Maneuver");
    expect(reasons).not.toContain("Ability text aligns");
    expect(reasons).not.toContain("Synergy group overlap detected");
  });

  it("throws when scoreOfficerForSlot is invoked without an effect bundle", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    expect(() => scoreOfficerForSlot(kirk, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: undefined as unknown as EffectBundleData,
    })).toThrow(/effect bundle is required/i);
  });

  it("throws when recommendBridgeTrios is invoked without an effect bundle", () => {
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 }),
    ];

    expect(() => recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 1,
      effectBundle: undefined as unknown as EffectBundleData,
    })).toThrow(/effect bundle is required/i);
  });

  it("throws when scoreOfficerForSlot is invoked with unknown intent key", () => {
    const kirk = makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 });
    expect(() => scoreOfficerForSlot(kirk, {
      intentKey: "nonexistent_intent",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: bundle,
    })).toThrow(/unknown intent key/i);
  });

  it("throws when recommendBridgeTrios is invoked with unknown intent key", () => {
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 }),
    ];

    expect(() => recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "nonexistent_intent",
      limit: 1,
      effectBundle: bundle,
    })).toThrow(/unknown intent key/i);
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

describe("phase-1 scoring contract: applicability drives contribution", () => {
  const bundle = makeEffectBundle({
    intents: {
      grinding: {
        weights: { damage_dealt: 2 },
        ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
      },
    },
    officers: {
      "o-works": [makeTestAbility({
        id: "works:oa",
        officerId: "o-works",
        slot: "oa",
        effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
      })],
      "o-conditional": [makeTestAbility({
        id: "conditional:oa",
        officerId: "o-conditional",
        slot: "oa",
        effects: [{
          effectKey: "damage_dealt",
          magnitude: 1.0,
          applicableTargetKinds: ["hostile"],
          conditions: [{ conditionKey: "when_shields_depleted", params: null }],
        }],
      })],
      "o-blocked": [makeTestAbility({
        id: "blocked:oa",
        officerId: "o-blocked",
        slot: "oa",
        effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["station"] }],
      })],
    },
  });

  it("scores works > conditional > blocked with same weight and magnitude", () => {
    const works = scoreOfficerForSlot(makeOfficer({ id: "o-works", name: "Works", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const conditional = scoreOfficerForSlot(makeOfficer({ id: "o-conditional", name: "Conditional", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const blocked = scoreOfficerForSlot(makeOfficer({ id: "o-blocked", name: "Blocked", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(works.effectScore).toBeGreaterThan(conditional.effectScore);
    expect(conditional.effectScore).toBeGreaterThan(blocked.effectScore);
    expect(works.effectScore).toBe(20);
    expect(conditional.effectScore).toBe(10);
    expect(blocked.effectScore).toBe(0);
  });

  it("emits status-aware evidence in recommendation reasons", () => {
    const reasonBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2, weapon_damage: 1 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-captain": [makeTestAbility({
          id: "captain:cm",
          officerId: "o-captain",
          slot: "cm",
          effects: [
            { effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] },
            { effectKey: "weapon_damage", magnitude: 1.0, conditions: [{ conditionKey: "when_shields_depleted", params: null }] },
          ],
        })],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-captain", name: "Captain", userLevel: 30, userPower: 100 }),
        makeOfficer({ id: "o-b1", name: "Bridge 1", userLevel: 30, userPower: 100 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 30, userPower: 100 }),
      ],
      reservations: [],
      intentKey: "grinding",
      limit: 1,
      effectBundle: reasonBundle,
    });

    expect(recs.length).toBe(1);
    const reasons = recs[0]!.reasons.join(" ").toLowerCase();
    expect(reasons).toContain("works");
    expect(reasons).toContain("conditional");
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

  it("auto-captain selection excludes non-viable captains when viable options exist", () => {
    const gatingBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 3, weapon_damage: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-viable": [
          makeTestAbility({
            id: "viable:cm",
            officerId: "o-viable",
            slot: "cm",
            effects: [{ effectKey: "damage_dealt", magnitude: 0.05, applicableTargetKinds: ["hostile"] }],
          }),
        ],
        "o-nonviable": [
          makeTestAbility({
            id: "bad:oa",
            officerId: "o-nonviable",
            slot: "oa",
            effects: [{ effectKey: "weapon_damage", magnitude: 0.90, applicableTargetKinds: ["hostile"] }],
          }),
        ],
        "o-b1": [makeTestAbility({
          id: "b1:oa", officerId: "o-b1", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.15, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa", officerId: "o-b2", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.12, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const officers = [
      makeOfficer({ id: "o-viable", name: "Viable", userLevel: 40, userPower: 600 }),
      makeOfficer({ id: "o-nonviable", name: "Nonviable", userLevel: 60, userPower: 1500 }),
      makeOfficer({ id: "o-b1", name: "Bridge 1", userLevel: 40, userPower: 700 }),
      makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 650 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 5,
      effectBundle: gatingBundle,
    });

    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.captainId !== "o-nonviable")).toBe(true);
  });

  it("uses fallback captains only when no viable captain exists and reports warning", () => {
    const fallbackBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:oa", officerId: "o-a", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.12, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b": [makeTestAbility({
          id: "b:oa", officerId: "o-b", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.10, applicableTargetKinds: ["hostile"] }],
        })],
        "o-c": [makeTestAbility({
          id: "c:oa", officerId: "o-c", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.11, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-a", name: "A", userLevel: 40, userPower: 500 }),
        makeOfficer({ id: "o-b", name: "B", userLevel: 40, userPower: 520 }),
        makeOfficer({ id: "o-c", name: "C", userLevel: 40, userPower: 510 }),
      ],
      reservations: [],
      intentKey: "grinding",
      limit: 1,
      effectBundle: fallbackBundle,
    });

    expect(recs.length).toBe(1);
    expect(recs[0]?.reasons.some((line) => line.includes("No viable captains found"))).toBe(true);
  });

  it("treats applicable allowlisted CM as viable even with zero intent weight", () => {
    const zeroWeightBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 0, weapon_damage: 0 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-allowlisted": [makeTestAbility({
          id: "allowlisted:cm",
          officerId: "o-allowlisted",
          slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-allowlisted", name: "Allowlisted", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "captain",
      effectBundle: zeroWeightBundle,
    });

    expect(score.captainBonus).toBeGreaterThan(0);
  });

  it("treats applicable negative-weight CM as viable (tradeoff-aware viability)", () => {
    const negativeWeightBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: -1 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-negative": [makeTestAbility({
          id: "negative:cm",
          officerId: "o-negative",
          slot: "cm",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-negative", name: "Negative", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "captain",
      effectBundle: negativeWeightBundle,
    });

    expect(score.captainBonus).toBeGreaterThan(0);
  });

  it("does not treat non-combat CM keys as viable for combat intents", () => {
    const nonCombatCmBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 1.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-miner": [makeTestAbility({
          id: "miner:cm",
          officerId: "o-miner",
          slot: "cm",
          effects: [{ effectKey: "mining_rate", magnitude: 0.5 }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-miner", name: "Miner", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "captain",
      effectBundle: nonCombatCmBundle,
    });

    expect(score.captainBonus).toBeLessThan(0);
  });

  it("treats officer stat CM keys as viable for combat intents", () => {
    const officerStatCmBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 1.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-doc": [makeTestAbility({
          id: "doc:cm",
          officerId: "o-doc",
          slot: "cm",
          effects: [{ effectKey: "officer_health", magnitude: 0.35, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-doc", name: "Doc", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "captain",
      effectBundle: officerStatCmBundle,
    });

    expect(score.captainBonus).toBeGreaterThan(0);
  });

  it("treats economy CM keys as viable for economy intents even on armada targets", () => {
    const economyBundle = makeEffectBundle({
      intents: {
        armada_loot: {
          weights: { mitigation: 0.1 },
          ctx: { targetKind: "armada_target", engagement: "attacking", targetTags: ["pve", "armada"] },
        },
      },
      officers: {
        "o-loot": [makeTestAbility({
          id: "loot:cm",
          officerId: "o-loot",
          slot: "cm",
          effects: [{ effectKey: "loot", magnitude: 0.5, applicableTargetKinds: ["armada_target"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-loot", name: "Looter", userLevel: 1, userPower: 1 }), {
      intentKey: "armada_loot",
      reservations: [],
      maxPower: 1,
      slot: "captain",
      effectBundle: economyBundle,
    });

    expect(score.captainBonus).toBeGreaterThan(0);
  });

  it("emits fallback warning once per recommendation run", () => {
    const fallbackBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:oa", officerId: "o-a", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.12, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b": [makeTestAbility({
          id: "b:oa", officerId: "o-b", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.10, applicableTargetKinds: ["hostile"] }],
        })],
        "o-c": [makeTestAbility({
          id: "c:oa", officerId: "o-c", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.11, applicableTargetKinds: ["hostile"] }],
        })],
        "o-d": [makeTestAbility({
          id: "d:oa", officerId: "o-d", slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.09, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-a", name: "A", userLevel: 40, userPower: 500 }),
        makeOfficer({ id: "o-b", name: "B", userLevel: 40, userPower: 520 }),
        makeOfficer({ id: "o-c", name: "C", userLevel: 40, userPower: 510 }),
        makeOfficer({ id: "o-d", name: "D", userLevel: 40, userPower: 515 }),
      ],
      reservations: [],
      intentKey: "grinding",
      limit: 3,
      effectBundle: fallbackBundle,
    });

    const warningCount = recs
      .flatMap((r) => r.reasons)
      .filter((line) => line.includes("No viable captains found"))
      .length;

    expect(warningCount).toBe(1);
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

describe("issue #136 uncertainty penalties + confidence buckets", () => {
  it("unknown-key-heavy officer cannot dominate ranking on readiness alone", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 3 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-known": [makeTestAbility({
          id: "known:cm",
          officerId: "o-known",
          slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.2, applicableTargetKinds: ["hostile"] }],
        })],
        "o-uk1": [makeTestAbility({
          id: "uk1:cm",
          officerId: "o-uk1",
          slot: "cm",
          effects: [{ effectKey: "mystery_alpha", magnitude: 2.0, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-known", name: "Known", userLevel: 20, userPower: 300 }),
        makeOfficer({ id: "o-uk1", name: "UnknownKey", userLevel: 60, userPower: 3000 }),
        makeOfficer({ id: "o-b1", name: "Bridge 1", userLevel: 30, userPower: 600 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 30, userPower: 600 }),
      ],
      reservations: [],
      intentKey: "grinding",
      captainId: "o-known",
      limit: 1,
      effectBundle: bundle,
    });

    expect(recs.length).toBe(1);
    expect(recs[0]?.captainId).toBe("o-known");
    expect([recs[0]?.bridge1Id, recs[0]?.bridge2Id]).not.toContain("o-uk1");
  });

  it("unknown magnitude is conservative versus known magnitude", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 4 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-known-mag": [makeTestAbility({
          id: "known-mag:oa",
          officerId: "o-known-mag",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
        "o-unknown-mag": [makeTestAbility({
          id: "unknown-mag:oa",
          officerId: "o-unknown-mag",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: null, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const known = scoreOfficerForSlot(makeOfficer({ id: "o-known-mag", name: "KnownMag", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const unknown = scoreOfficerForSlot(makeOfficer({ id: "o-unknown-mag", name: "UnknownMag", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(known.effectScore).toBeGreaterThan(unknown.effectScore);
  });

  it("confidence buckets drop with uncertainty and conditional concentration", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 3 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-safe-cap": [makeTestAbility({
          id: "safe-cap:cm",
          officerId: "o-safe-cap",
          slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.4, applicableTargetKinds: ["hostile"] }],
        })],
        "o-safe-b1": [makeTestAbility({
          id: "safe-b1:oa",
          officerId: "o-safe-b1",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        })],
        "o-safe-b2": [makeTestAbility({
          id: "safe-b2:oa",
          officerId: "o-safe-b2",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        })],
        "o-risk-cap": [makeTestAbility({
          id: "risk-cap:cm",
          officerId: "o-risk-cap",
          slot: "cm",
          effects: [
            { effectKey: "damage_dealt", magnitude: null, applicableTargetKinds: ["hostile"], conditions: [{ conditionKey: "requires_defending", params: null }] },
            { effectKey: "unknown_1", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "unknown_2", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
        "o-risk-b1": [makeTestAbility({
          id: "risk-b1:oa",
          officerId: "o-risk-b1",
          slot: "oa",
          effects: [
            { effectKey: "damage_dealt", magnitude: null, applicableTargetKinds: ["hostile"], conditions: [{ conditionKey: "requires_defending", params: null }] },
            { effectKey: "unknown_3", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "unknown_4", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
        "o-risk-b2": [makeTestAbility({
          id: "risk-b2:oa",
          officerId: "o-risk-b2",
          slot: "oa",
          effects: [
            { effectKey: "damage_dealt", magnitude: null, applicableTargetKinds: ["hostile"], conditions: [{ conditionKey: "requires_defending", params: null }] },
            { effectKey: "unknown_5", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "unknown_6", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
      },
    });

    const safe = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-safe-cap", name: "Safe Cap", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-safe-b1", name: "Safe B1", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-safe-b2", name: "Safe B2", userLevel: 40, userPower: 900 }),
      ],
      reservations: [],
      intentKey: "grinding",
      captainId: "o-safe-cap",
      limit: 1,
      effectBundle: bundle,
    });

    const risky = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-risk-cap", name: "Risk Cap", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-risk-b1", name: "Risk B1", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-risk-b2", name: "Risk B2", userLevel: 40, userPower: 900 }),
      ],
      reservations: [],
      intentKey: "grinding",
      captainId: "o-risk-cap",
      limit: 1,
      effectBundle: bundle,
    });

    expect(safe.length).toBe(1);
    expect(risky.length).toBe(1);
    expect(safe[0]?.confidence).toBe("high");
    expect(risky[0]?.confidence).toBe("low");
  });
});

describe("issue #138 golden regression suite (recommender)", () => {
  it("hostile grinding keeps Kirk/Spock/McCoy ahead of accidental alternatives", () => {
    const bundle = makeGrindingBundle();
    const officers = [
      makeOfficer({ id: "o-kirk", name: "Kirk", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-spock", name: "Spock", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-mccoy", name: "McCoy", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-sulu", name: "Sulu", userLevel: 60, userPower: 1000 }),
      makeOfficer({ id: "o-ivanov", name: "Ivanov", userLevel: 60, userPower: 1000 }),
    ];

    const recs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 10,
      effectBundle: bundle,
    });

    expect(recs[0]?.captainId).toBe("o-kirk");
    const kirkTrio = recs.find((r) =>
      r.captainId === "o-kirk"
      && [r.bridge1Id, r.bridge2Id].sort().join(",") === ["o-mccoy", "o-spock"].sort().join(","),
    );
    expect(kirkTrio).toBeDefined();
  });

  it("fallback warning remains deduped when no viable captains exist", () => {
    const fallbackBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({ id: "a:oa", officerId: "o-a", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.10, applicableTargetKinds: ["hostile"] }] })],
        "o-b": [makeTestAbility({ id: "b:oa", officerId: "o-b", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.11, applicableTargetKinds: ["hostile"] }] })],
        "o-c": [makeTestAbility({ id: "c:oa", officerId: "o-c", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.12, applicableTargetKinds: ["hostile"] }] })],
        "o-d": [makeTestAbility({ id: "d:oa", officerId: "o-d", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.09, applicableTargetKinds: ["hostile"] }] })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-a", name: "A", userLevel: 40, userPower: 500 }),
        makeOfficer({ id: "o-b", name: "B", userLevel: 40, userPower: 520 }),
        makeOfficer({ id: "o-c", name: "C", userLevel: 40, userPower: 510 }),
        makeOfficer({ id: "o-d", name: "D", userLevel: 40, userPower: 515 }),
      ],
      reservations: [],
      intentKey: "grinding",
      limit: 3,
      effectBundle: fallbackBundle,
    });

    const warningCount = recs
      .flatMap((r) => r.reasons)
      .filter((line) => line.includes("No viable captains found"))
      .length;

    expect(warningCount).toBe(1);
  });
});
