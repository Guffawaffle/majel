import { describe, expect, it } from "vitest";
import type { EffectsSeedFile } from "../src/server/services/effects-contract-v3.js";
import {
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  validateEffectsSeedForV3,
} from "../src/server/services/effects-contract-v3.js";

function createValidSeed(): EffectsSeedFile {
  return {
    taxonomy: {
      targetKinds: ["hostile", "player_ship"],
      targetTags: ["pve", "pvp"],
      shipClasses: ["explorer"],
      slots: ["cm", "oa", "bda"],
      effectKeys: [
        { id: "damage_dealt", category: "damage" },
        { id: "mitigation", category: "survivability" },
      ],
      conditionKeys: [{ id: "requires_attacking", paramSchema: undefined }],
      issueTypes: [{ id: "unmapped_ability_text", severity: "info", defaultMessage: "unmapped" }],
    },
    intents: [{
      id: "hostile_grinding",
      name: "Hostile Grinding",
      description: "test",
      defaultContext: {
        targetKind: "hostile",
        engagement: "attacking",
        targetTags: ["pve"],
      },
      effectWeights: [{ effectKey: "damage_dealt", weight: 1 }],
    }],
    officers: [
      {
        id: "ability-beta-oa",
        officerId: "cdn:officer:200",
        slot: "oa",
        name: "beta-oa",
        rawText: "Increase mitigation by 10% when attacking.",
        isInert: false,
        effects: [
          {
            id: "ef-b",
            effectKey: "mitigation",
            magnitude: 0.1,
            unit: "percent",
            stacking: "additive",
            targetKinds: ["hostile"],
            targetTags: ["pve"],
            conditions: [{ conditionKey: "requires_attacking", params: null }],
          },
        ],
      },
      {
        id: "ability-alpha-cm",
        officerId: "cdn:officer:100",
        slot: "cm",
        name: "alpha-cm",
        rawText: "Increase damage dealt by 30%.",
        isInert: false,
        effects: [
          {
            id: "ef-a-2",
            effectKey: "damage_dealt",
            magnitude: 0.2,
            unit: "percent",
            stacking: "additive",
            targetKinds: ["hostile"],
            targetTags: ["pve"],
            conditions: [],
          },
          {
            id: "ef-a-1",
            effectKey: "damage_dealt",
            magnitude: 0.3,
            unit: "percent",
            stacking: "additive",
            targetKinds: ["hostile"],
            targetTags: ["pve"],
            conditions: [],
          },
        ],
      },
    ],
  };
}

describe("effects-contract-v3 validation", () => {
  it("reports explicit unknown taxonomy references", () => {
    const seed = createValidSeed();
    seed.officers[0].effects[0].effectKey = "unknown_effect";

    const result = validateEffectsSeedForV3(seed);

    expect(result.ok).toBe(false);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.issues.some((issue) => issue.path.includes("effectKey") && issue.message.includes("unknown_effect"))).toBe(true);
  });
});

describe("effects-contract-v3 determinism", () => {
  it("sorts output deterministically by officer, slot, and effect source", () => {
    const seed = createValidSeed();
    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    expect(artifact.officers.map((officer) => officer.officerId)).toEqual([
      "cdn:officer:100",
      "cdn:officer:200",
    ]);

    const cmEffects = artifact.officers[0].abilities[0].effects;
    expect(cmEffects[0].evidence[0].sourceRef).toContain("ef-a-1");
    expect(cmEffects[1].evidence[0].sourceRef).toContain("ef-a-2");
    expect(cmEffects[0].effectId).toBe("cdn:officer:100:cm:ef:src-0");
    expect(cmEffects[1].effectId).toBe("cdn:officer:100:cm:ef:src-1");
  });

  it("produces identical hashes for semantically identical shuffled input", () => {
    const base = createValidSeed();
    const shuffled: EffectsSeedFile = {
      ...base,
      officers: [base.officers[1], base.officers[0]].map((ability) => ({
        ...ability,
        effects: [...ability.effects].reverse(),
      })),
      intents: [...base.intents].reverse(),
    };

    const options = {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    };

    const hashA = hashEffectsContractArtifact(buildEffectsContractV3Artifact(base, options));
    const hashB = hashEffectsContractArtifact(buildEffectsContractV3Artifact(shuffled, options));

    expect(hashA).toBe(hashB);
  });
});
