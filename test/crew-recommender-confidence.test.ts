import { describe, expect, it } from "vitest";
import { recommendBridgeTrios, scoreOfficerForSlot } from "../web/src/lib/crew-recommender.js";
import { makeOfficer, makeEffectBundle, makeTestAbility, GRINDING_WEIGHTS } from "./crew-recommender-test-helpers.js";

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
