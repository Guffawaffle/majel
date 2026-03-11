import { describe, expect, it } from "vitest";
import { recommendBridgeTrios, scoreOfficerForSlot } from "../web/src/lib/crew-recommender.js";
import { makeOfficer, makeEffectBundle, makeTestAbility } from "./crew-recommender-test-helpers.js";

describe("effect-based scoring (ADR-034)", () => {
  it("officer with relevant effect scores higher than one without", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-relevant": [makeTestAbility({
          id: "relevant:oa",
          officerId: "o-relevant",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
        "o-irrelevant": [makeTestAbility({
          id: "irrelevant:oa",
          officerId: "o-irrelevant",
          slot: "oa",
          effects: [{ effectKey: "mining_rate", magnitude: 1.0 }],
        })],
      },
    });

    const relevant = scoreOfficerForSlot(makeOfficer({ id: "o-relevant", name: "Relevant", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const irrelevant = scoreOfficerForSlot(makeOfficer({ id: "o-irrelevant", name: "Irrelevant", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(relevant.effectScore).toBeGreaterThan(irrelevant.effectScore);
  });

  it("officer with higher magnitude scores higher", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-high": [makeTestAbility({
          id: "high:oa",
          officerId: "o-high",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 2.0, applicableTargetKinds: ["hostile"] }],
        })],
        "o-low": [makeTestAbility({
          id: "low:oa",
          officerId: "o-low",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.5, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const high = scoreOfficerForSlot(makeOfficer({ id: "o-high", name: "High", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const low = scoreOfficerForSlot(makeOfficer({ id: "o-low", name: "Low", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(high.effectScore).toBeGreaterThan(low.effectScore);
  });

  it("effect score scales with intent weight", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:oa",
          officerId: "o-a",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-a", name: "A", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    expect(score.effectScore).toBe(50);
  });

  it("readiness reflects normalised level + power", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 1 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:oa",
          officerId: "o-a",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const low = scoreOfficerForSlot(makeOfficer({ id: "o-a", name: "A", userLevel: 1, userPower: 100 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const high = scoreOfficerForSlot(makeOfficer({ id: "o-a", name: "A", userLevel: 60, userPower: 1000 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(high.readiness).toBeGreaterThan(low.readiness);
  });

  it("multiple effects from one officer are additive", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2, weapon_damage: 1 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-dual": [makeTestAbility({
          id: "dual:oa",
          officerId: "o-dual",
          slot: "oa",
          effects: [
            { effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] },
            { effectKey: "weapon_damage", magnitude: 0.5, applicableTargetKinds: ["hostile"] },
          ],
        })],
        "o-single": [makeTestAbility({
          id: "single:oa",
          officerId: "o-single",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const dual = scoreOfficerForSlot(makeOfficer({ id: "o-dual", name: "Dual", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const single = scoreOfficerForSlot(makeOfficer({ id: "o-single", name: "Single", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(dual.effectScore).toBeGreaterThan(single.effectScore);
  });

  it("conditional effects are discounted relative to unconditional", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-unconditional": [makeTestAbility({
          id: "uncond:oa",
          officerId: "o-unconditional",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["hostile"] }],
        })],
        "o-conditional": [makeTestAbility({
          id: "cond:oa",
          officerId: "o-conditional",
          slot: "oa",
          effects: [{
            effectKey: "damage_dealt",
            magnitude: 1.0,
            applicableTargetKinds: ["hostile"],
            conditions: [{ conditionKey: "when_shields_depleted", params: null }],
          }],
        })],
      },
    });

    const uncond = scoreOfficerForSlot(makeOfficer({ id: "o-unconditional", name: "Uncond", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    const cond = scoreOfficerForSlot(makeOfficer({ id: "o-conditional", name: "Cond", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });

    expect(uncond.effectScore).toBeGreaterThan(cond.effectScore);
  });

  it("inapplicable effect contributes zero", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-wrong-target": [makeTestAbility({
          id: "wrong:oa",
          officerId: "o-wrong-target",
          slot: "oa",
          effects: [{ effectKey: "damage_dealt", magnitude: 1.0, applicableTargetKinds: ["station"] }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-wrong-target", name: "Wrong", userLevel: 1, userPower: 1 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1,
      slot: "bridge_1",
      effectBundle: bundle,
    });
    expect(score.effectScore).toBe(0);
  });

  it("officer with no abilities in bundle gets zero effect score but positive readiness", () => {
    const bundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {},
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-nodata", name: "No Data", userLevel: 30, userPower: 100 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 100,
      slot: "bridge_1",
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
