import { describe, expect, it } from "vitest";
import { recommendBridgeTrios, scoreOfficerForSlot } from "../web/src/lib/crew-recommender.js";
import { makeOfficer, makeEffectBundle, makeTestAbility, makeGrindingBundle } from "./crew-recommender-test-helpers.js";

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

  it("explains no-benefit captain maneuvers as captain-negative", () => {
    const inertBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-inert": [
          makeTestAbility({
            id: "inert:cm",
            officerId: "o-inert",
            slot: "cm",
            isInert: true,
            rawText: "Provides no benefit.",
            effects: [],
          }),
          makeTestAbility({
            id: "inert:oa",
            officerId: "o-inert",
            slot: "oa",
            effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }],
          }),
        ],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-inert", name: "Inert", userLevel: 60, userPower: 1000 }), {
      intentKey: "grinding",
      reservations: [],
      maxPower: 1000,
      slot: "captain",
      effectBundle: inertBundle,
    });

    expect(score.captainBonus).toBeLessThan(0);
    expect(score.captainReason).toContain("provides no benefit");
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

  it("matches mining recommendations to the requested resource", () => {
    const miningBundle = makeEffectBundle({
      intents: {
        "mining-gas": {
          weights: { mining_rate_gas: 3, mining_rate: 0.75, mining_protection: 1.5, cargo_capacity: 1 },
          ctx: { targetKind: "hostile", engagement: "any", targetTags: ["pve"], shipContext: { shipClass: "survey" } },
        },
        "mining-crystal": {
          weights: { mining_rate_crystal: 3, mining_rate: 0.75, mining_protection: 1.5, cargo_capacity: 1 },
          ctx: { targetKind: "hostile", engagement: "any", targetTags: ["pve"], shipContext: { shipClass: "survey" } },
        },
      },
      officers: {
        "o-gas": [makeTestAbility({
          id: "gas:cm",
          officerId: "o-gas",
          slot: "cm",
          effects: [{ effectKey: "mining_rate_gas", magnitude: 0.5 }],
        })],
        "o-crystal": [makeTestAbility({
          id: "crystal:cm",
          officerId: "o-crystal",
          slot: "cm",
          effects: [{ effectKey: "mining_rate_crystal", magnitude: 0.5 }],
        })],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "cargo_capacity", magnitude: 0.25 }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "mining_protection", magnitude: 0.2 }],
        })],
      },
    });

    const officers = [
      makeOfficer({ id: "o-gas", name: "Gas Miner", userLevel: 40, userPower: 700 }),
      makeOfficer({ id: "o-crystal", name: "Crystal Miner", userLevel: 40, userPower: 700 }),
      makeOfficer({ id: "o-b1", name: "Cargo", userLevel: 40, userPower: 700 }),
      makeOfficer({ id: "o-b2", name: "Protection", userLevel: 40, userPower: 700 }),
    ];

    const gasRecs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "mining-gas",
      limit: 1,
      effectBundle: miningBundle,
    });
    const crystalRecs = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "mining-crystal",
      limit: 1,
      effectBundle: miningBundle,
    });

    expect(gasRecs[0]?.captainId).toBe("o-gas");
    expect(crystalRecs[0]?.captainId).toBe("o-crystal");
  });

  it("does not treat wrong-resource mining captains as viable", () => {
    const miningBundle = makeEffectBundle({
      intents: {
        "mining-gas": {
          weights: { mining_rate_gas: 3, mining_rate: 0.75, mining_protection: 1.5, cargo_capacity: 1 },
          ctx: { targetKind: "hostile", engagement: "any", targetTags: ["pve"], shipContext: { shipClass: "survey" } },
        },
      },
      officers: {
        "o-crystal": [makeTestAbility({
          id: "crystal:cm",
          officerId: "o-crystal",
          slot: "cm",
          effects: [{ effectKey: "mining_rate_crystal", magnitude: 0.5 }],
        })],
      },
    });

    const score = scoreOfficerForSlot(makeOfficer({ id: "o-crystal", name: "Crystal Miner", userLevel: 40, userPower: 700 }), {
      intentKey: "mining-gas",
      reservations: [],
      maxPower: 700,
      slot: "captain",
      effectBundle: miningBundle,
    });

    expect(score.captainBonus).toBeLessThan(0);
    expect(score.captainReason).toContain("no useful effect");
  });

  it("keeps no-benefit captain reason visible even in fallback runs", () => {
    const fallbackBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-inert": [
          makeTestAbility({
            id: "inert:cm",
            officerId: "o-inert",
            slot: "cm",
            isInert: true,
            rawText: "Provides no benefit.",
            effects: [],
          }),
          makeTestAbility({
            id: "inert:oa",
            officerId: "o-inert",
            slot: "oa",
            effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }],
          }),
        ],
        "o-b1": [makeTestAbility({
          id: "b1:oa",
          officerId: "o-b1",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.25, applicableTargetKinds: ["hostile"] }],
        })],
        "o-b2": [makeTestAbility({
          id: "b2:oa",
          officerId: "o-b2",
          slot: "oa",
          effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }],
        })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-inert", name: "Inert", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b1", name: "Bridge 1", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 700 }),
      ],
      reservations: [],
      intentKey: "grinding",
      limit: 1,
      effectBundle: fallbackBundle,
    });

    const joinedReasons = recs[0]?.reasons.join(" ") ?? "";
    expect(joinedReasons).toContain("No viable captains found");
    expect(joinedReasons).toContain("provides no benefit");
  });

  it("allow mode still permits reserved officers with penalty reasoning", () => {
    const reservationBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-cap": [makeTestAbility({ id: "cap:cm", officerId: "o-cap", slot: "cm", effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }] })],
        "o-b1": [makeTestAbility({ id: "b1:oa", officerId: "o-b1", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.25, applicableTargetKinds: ["hostile"] }] })],
        "o-b2": [makeTestAbility({ id: "b2:oa", officerId: "o-b2", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }] })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-cap", name: "Captain", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b1", name: "Reserved Bridge", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 700 }),
      ],
      reservations: [{ officerId: "o-b1", reservedFor: "Dock 1", locked: false, notes: null, createdAt: "2026-03-07T00:00:00.000Z" }],
      reservationExclusionMode: "allow",
      intentKey: "grinding",
      limit: 1,
      effectBundle: reservationBundle,
    });

    expect(recs[0]).toBeDefined();
    expect([recs[0]?.captainId, recs[0]?.bridge1Id, recs[0]?.bridge2Id]).toContain("o-b1");
    expect(recs[0]?.reasons.join(" ")).toContain("reserved officer");
  });

  it("exclude_locked mode filters locked officers but keeps soft reservations eligible", () => {
    const reservationBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-cap": [makeTestAbility({ id: "cap:cm", officerId: "o-cap", slot: "cm", effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }] })],
        "o-soft": [makeTestAbility({ id: "soft:oa", officerId: "o-soft", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.25, applicableTargetKinds: ["hostile"] }] })],
        "o-locked": [makeTestAbility({ id: "locked:oa", officerId: "o-locked", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.3, applicableTargetKinds: ["hostile"] }] })],
        "o-b2": [makeTestAbility({ id: "b2:oa", officerId: "o-b2", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }] })],
        "o-b3": [makeTestAbility({ id: "b3:oa", officerId: "o-b3", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.18, applicableTargetKinds: ["hostile"] }] })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-cap", name: "Captain", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-soft", name: "Soft Reserved", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-locked", name: "Locked Reserved", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b3", name: "Bridge 3", userLevel: 40, userPower: 680 }),
      ],
      reservations: [
        { officerId: "o-soft", reservedFor: "Dock 1", locked: false, notes: null, createdAt: "2026-03-07T00:00:00.000Z" },
        { officerId: "o-locked", reservedFor: "Dock 2", locked: true, notes: null, createdAt: "2026-03-07T00:00:00.000Z" },
      ],
      reservationExclusionMode: "exclude_locked",
      intentKey: "grinding",
      limit: 1,
      effectBundle: reservationBundle,
    });

    expect(recs[0]).toBeDefined();
    expect([recs[0]?.captainId, recs[0]?.bridge1Id, recs[0]?.bridge2Id]).not.toContain("o-locked");
    expect(recs[0]?.reasons.join(" ")).toContain("locked reserved officer");
  });

  it("exclude_all_reserved mode filters both soft and locked reservations", () => {
    const reservationBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-cap": [makeTestAbility({ id: "cap:cm", officerId: "o-cap", slot: "cm", effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }] })],
        "o-soft": [makeTestAbility({ id: "soft:oa", officerId: "o-soft", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.25, applicableTargetKinds: ["hostile"] }] })],
        "o-locked": [makeTestAbility({ id: "locked:oa", officerId: "o-locked", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.3, applicableTargetKinds: ["hostile"] }] })],
        "o-b2": [makeTestAbility({ id: "b2:oa", officerId: "o-b2", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }] })],
        "o-b3": [makeTestAbility({ id: "b3:oa", officerId: "o-b3", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.18, applicableTargetKinds: ["hostile"] }] })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-cap", name: "Captain", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-soft", name: "Soft Reserved", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-locked", name: "Locked Reserved", userLevel: 40, userPower: 900 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b3", name: "Bridge 3", userLevel: 40, userPower: 680 }),
      ],
      reservations: [
        { officerId: "o-soft", reservedFor: "Dock 1", locked: false, notes: null, createdAt: "2026-03-07T00:00:00.000Z" },
        { officerId: "o-locked", reservedFor: "Dock 2", locked: true, notes: null, createdAt: "2026-03-07T00:00:00.000Z" },
      ],
      reservationExclusionMode: "exclude_all_reserved",
      intentKey: "grinding",
      limit: 1,
      effectBundle: reservationBundle,
    });

    expect(recs[0]).toBeDefined();
    expect([recs[0]?.captainId, recs[0]?.bridge1Id, recs[0]?.bridge2Id]).not.toContain("o-soft");
    expect([recs[0]?.captainId, recs[0]?.bridge1Id, recs[0]?.bridge2Id]).not.toContain("o-locked");
    expect(recs[0]?.reasons.join(" ")).toContain("reserved officers from suggestions");
  });

  it("preferred captain override keeps reserved captain eligible under exclusion mode", () => {
    const reservationBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { weapon_damage: 2.5 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-cap": [makeTestAbility({ id: "cap:cm", officerId: "o-cap", slot: "cm", effects: [{ effectKey: "weapon_damage", magnitude: 0.4, applicableTargetKinds: ["hostile"] }] })],
        "o-b1": [makeTestAbility({ id: "b1:oa", officerId: "o-b1", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.25, applicableTargetKinds: ["hostile"] }] })],
        "o-b2": [makeTestAbility({ id: "b2:oa", officerId: "o-b2", slot: "oa", effects: [{ effectKey: "weapon_damage", magnitude: 0.2, applicableTargetKinds: ["hostile"] }] })],
      },
    });

    const recs = recommendBridgeTrios({
      officers: [
        makeOfficer({ id: "o-cap", name: "Captain", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b1", name: "Bridge 1", userLevel: 40, userPower: 700 }),
        makeOfficer({ id: "o-b2", name: "Bridge 2", userLevel: 40, userPower: 700 }),
      ],
      reservations: [{ officerId: "o-cap", reservedFor: "Dock 1", locked: true, notes: null, createdAt: "2026-03-07T00:00:00.000Z" }],
      reservationExclusionMode: "exclude_all_reserved",
      intentKey: "grinding",
      captainId: "o-cap",
      limit: 1,
      effectBundle: reservationBundle,
    });

    expect(recs[0]?.captainId).toBe("o-cap");
    expect(recs[0]?.reasons.join(" ")).toContain("Preferred captain override kept a reserved officer eligible");
  });

  it("emits a single run-level fallback warning", () => {
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

  it("supports scenario overrides for engagement", () => {
    const defendingBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { armor: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-defender": [makeTestAbility({
          id: "defender:cm",
          officerId: "o-defender",
          slot: "cm",
          effects: [{
            effectKey: "armor",
            magnitude: 0.4,
            conditions: [{ conditionKey: "requires_defending", params: null }],
          }],
        })],
      },
    });

    const officer = makeOfficer({ id: "o-defender", name: "Defender", userLevel: 30, userPower: 100 });

    const attackingScore = scoreOfficerForSlot(officer, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 100,
      slot: "captain",
      effectBundle: defendingBundle,
    });

    const defendingScore = scoreOfficerForSlot(officer, {
      intentKey: "grinding",
      reservations: [],
      maxPower: 100,
      slot: "captain",
      contextOverrides: { engagement: "defending" },
      effectBundle: defendingBundle,
    });

    expect(defendingScore.effectScore).toBeGreaterThan(attackingScore.effectScore);
  });

  it("filters out low-confidence recommendations when minConfidence is high", () => {
    const uncertainBundle = makeEffectBundle({
      intents: {
        grinding: {
          weights: { damage_dealt: 2 },
          ctx: { targetKind: "hostile", engagement: "attacking", targetTags: ["pve"] },
        },
      },
      officers: {
        "o-a": [makeTestAbility({
          id: "a:cm",
          officerId: "o-a",
          slot: "cm",
          effects: [
            { effectKey: "mystery_alpha", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "mystery_beta", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "mystery_gamma", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
        "o-b": [makeTestAbility({
          id: "b:oa",
          officerId: "o-b",
          slot: "oa",
          effects: [
            { effectKey: "mystery_beta", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "mystery_delta", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
        "o-c": [makeTestAbility({
          id: "c:oa",
          officerId: "o-c",
          slot: "oa",
          effects: [
            { effectKey: "mystery_gamma", magnitude: null, applicableTargetKinds: ["hostile"] },
            { effectKey: "mystery_epsilon", magnitude: null, applicableTargetKinds: ["hostile"] },
          ],
        })],
      },
    });

    const officers = [
      makeOfficer({ id: "o-a", name: "A", userLevel: 30, userPower: 100 }),
      makeOfficer({ id: "o-b", name: "B", userLevel: 30, userPower: 100 }),
      makeOfficer({ id: "o-c", name: "C", userLevel: 30, userPower: 100 }),
    ];

    const withoutFilter = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      limit: 5,
      effectBundle: uncertainBundle,
    });
    const highOnly = recommendBridgeTrios({
      officers,
      reservations: [],
      intentKey: "grinding",
      minConfidence: "high",
      limit: 5,
      effectBundle: uncertainBundle,
    });

    expect(withoutFilter.length).toBeGreaterThan(0);
    expect(highOnly.length).toBe(0);
  });
});
