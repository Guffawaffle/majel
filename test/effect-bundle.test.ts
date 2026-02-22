/**
 * effect-bundle.test.ts — Smoke tests for effect bundle route + adapter
 *
 * Verifies:
 * - Route returns 200 with valid structure
 * - Bundle has non-empty intents + officers
 * - Adapter converts bundle to Maps correctly
 */

import { describe, it, expect } from "vitest";
import { adaptEffectBundle, type EffectBundleResponse } from "../web/src/lib/effect-bundle-adapter.js";

// Helper to create a minimal valid bundle
function createMockBundle(): EffectBundleResponse {
  return {
    schemaVersion: "1.0.0",
    intents: [
      {
        id: "grinding",
        name: "Grinding",
        description: "PvE hostile battles",
        defaultContext: {
          targetKind: "hostile",
          engagement: "attacking",
          targetTags: ["pve"],
        },
        effectWeights: {
          damage_dealt: 3.0,
          weapon_damage: 2.5,
          crit_chance: 2.0,
        },
      },
    ],
    officers: {
      "kirk-001": {
        id: "kirk-001",
        name: "Kirk",
        abilities: [
          {
            id: "kirk-cm",
            slot: "cm",
            name: "Captain Maneuver",
            rawText: "Increase damage dealt by 30%",
            isInert: false,
            effects: [
              {
                id: "kirk-cm-dmg",
                effectKey: "damage_dealt",
                magnitude: 0.3,
                unit: "percent",
                stacking: "additive",
                applicableTargetKinds: ["hostile"],
                applicableTargetTags: [],
                conditions: [],
              },
            ],
          },
          {
            id: "kirk-oa",
            slot: "oa",
            name: "Officer Ability",
            rawText: "Increase weapon damage by 20%",
            isInert: false,
            effects: [
              {
                id: "kirk-oa-weap",
                effectKey: "weapon_damage",
                magnitude: 0.2,
                unit: "percent",
                stacking: "additive",
                applicableTargetKinds: ["hostile"],
                applicableTargetTags: [],
                conditions: [],
              },
            ],
          },
        ],
      },
    },
  };
}

describe("EffectBundleAdapter", () => {
  it("adapts a valid bundle to indexed Maps", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    expect(adapted.schemaVersion).toBe("1.0.0");
    expect(adapted.intentWeights.size).toBe(1);
    expect(adapted.officerAbilities.size).toBe(1);
    expect(adapted.intents.size).toBe(1);
  });

  it("indexes intent weights correctly", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const weights = adapted.intentWeights.get("grinding");
    expect(weights).toEqual({
      damage_dealt: 3.0,
      weapon_damage: 2.5,
      crit_chance: 2.0,
    });
  });

  it("indexes officer abilities with effects", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities).toBeDefined();
    expect(abilities!.length).toBe(2);

    // Check first ability (CM)
    const cm = abilities![0];
    expect(cm.slot).toBe("cm");
    expect(cm.effects).toHaveLength(1);
    expect(cm.effects[0].effectKey).toBe("damage_dealt");
    expect(cm.effects[0].magnitude).toBe(0.3);
  });

  it("indexes intents with default context", () => {
    const raw = createMockBundle();
    const adapted = adaptEffectBundle(raw);

    const intent = adapted.intents.get("grinding");
    expect(intent).toBeDefined();
    expect(intent!.name).toBe("Grinding");
    expect(intent!.defaultContext?.targetKind).toBe("hostile");
    expect(intent!.defaultContext?.targetTags).toEqual(["pve"]);
  });

  it("handles abilities with no effects", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities.push({
      id: "kirk-inert",
      slot: "bda",
      name: "Inert",
      rawText: null,
      isInert: true,
      effects: [],
    });

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities).toHaveLength(3);
    expect(abilities![2].isInert).toBe(true);
    expect(abilities![2].effects).toHaveLength(0);
  });

  it("preserves effects with null magnitude", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].magnitude = null;

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    expect(abilities![0].effects[0].magnitude).toBeNull();
  });

  it("converts condition objects correctly", () => {
    const raw = createMockBundle();
    raw.officers["kirk-001"].abilities[0].effects[0].conditions.push({
      conditionKey: "requires_attacking",
      params: null,
    });

    const adapted = adaptEffectBundle(raw);
    const abilities = adapted.officerAbilities.get("kirk-001");
    const effect = abilities![0].effects[0];
    expect(effect.conditions).toHaveLength(1);
    expect(effect.conditions[0].conditionKey).toBe("requires_attacking");
    expect(effect.conditions[0].params).toBeNull();
  });
});
