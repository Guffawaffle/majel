import { describe, expect, it } from "vitest";
import { recommendBridgeTrios, scoreOfficerForSlot } from "../web/src/lib/crew-recommender.js";
import { makeOfficer, makeEffectBundle, makeTestAbility, makeGrindingBundle } from "./crew-recommender-test-helpers.js";

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

  it("fallback warning is deduped to one run-level reason when no viable captains exist", () => {
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

  it("pvp station context ranks player/station captain over hostile-only captain", () => {
    const bundle = makeEffectBundle({
      intents: {
        pvp_station_hit: {
          weights: { damage_dealt: 1, weapon_damage: 1 },
          ctx: { targetKind: "station", engagement: "attacking", targetTags: ["pvp", "station"] },
        },
      },
      officers: {
        "o-pvp": [makeTestAbility({
          id: "pvp:cm",
          officerId: "o-pvp",
          slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.4, conditions: [{ conditionKey: "requires_pvp", params: null }] }],
        })],
        "o-hostile": [makeTestAbility({
          id: "hostile:cm",
          officerId: "o-hostile",
          slot: "cm",
          effects: [{ effectKey: "damage_dealt", magnitude: 0.4, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2 }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2 }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-pvp", name: "PvP Captain", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-hostile", name: "Hostile Captain", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-b1", name: "Bridge One", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-b2", name: "Bridge Two", userLevel: 50, userPower: 900 }),
      ],
      reservations: [],
      intentKey: "pvp_station_hit",
      limit: 3,
      effectBundle: bundle,
    });

    expect(recs[0]?.captainId).toBe("o-pvp");
  });

  it("armada context ranks armada-only captain over pvp-only captain", () => {
    const bundle = makeEffectBundle({
      intents: {
        armada_loot: {
          weights: { armada_loot: 1, weapon_damage: 1 },
          ctx: { targetKind: "armada_target", engagement: "attacking", targetTags: ["pve", "armada"] },
        },
      },
      officers: {
        "o-armada": [makeTestAbility({
          id: "armada:cm",
          officerId: "o-armada",
          slot: "cm",
          effects: [{ effectKey: "armada_loot", magnitude: 0.4, conditions: [{ conditionKey: "requires_armada_target", params: null }] }],
        })],
        "o-pvp": [makeTestAbility({
          id: "pvp:cm",
          officerId: "o-pvp",
          slot: "cm",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.4, conditions: [{ conditionKey: "requires_pvp", params: null }] }],
        })],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2 }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2 }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-armada", name: "Armada Captain", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-pvp", name: "PvP Captain", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-b1", name: "Bridge One", userLevel: 50, userPower: 900 }),
        makeOfficer({ id: "o-b2", name: "Bridge Two", userLevel: 50, userPower: 900 }),
      ],
      reservations: [],
      intentKey: "armada_loot",
      limit: 3,
      effectBundle: bundle,
    });

    expect(recs[0]?.captainId).toBe("o-armada");
  });
});
