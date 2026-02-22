import { describe, expect, it } from "vitest";
import type { EffectsSeedFile } from "../src/server/services/effects-contract-v3.js";
import {
  applyEffectsOverridesToArtifact,
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  type EffectsOverrideFile,
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

  it("uses source-span ordering for stable span-based effect IDs when spans exist", () => {
    const seed = createValidSeed();
    const abilityWithSpans = seed.officers[1] as typeof seed.officers[1] & {
      effects: Array<typeof seed.officers[1]["effects"][number] & { sourceSpan?: { start: number; end: number } }>;
    };

    abilityWithSpans.effects[0] = {
      ...abilityWithSpans.effects[0],
      sourceSpan: { start: 20, end: 29 },
    };
    abilityWithSpans.effects[1] = {
      ...abilityWithSpans.effects[1],
      sourceSpan: { start: 5, end: 11 },
    };

    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const cmEffects = artifact.officers[0].abilities[0].effects;
    expect(cmEffects[0].evidence[0].sourceRef).toContain("/spans/5-11");
    expect(cmEffects[0].effectId).toBe("cdn:officer:100:cm:ef:src-0");
    expect(cmEffects[1].evidence[0].sourceRef).toContain("/spans/20-29");
    expect(cmEffects[1].effectId).toBe("cdn:officer:100:cm:ef:src-1");
  });

  it("emits unknown_effect_key unmapped entries with evidence sourceRef", () => {
    const seed = createValidSeed();
    const invalidAbility = seed.officers[1] as typeof seed.officers[1] & {
      effects: Array<typeof seed.officers[1]["effects"][number] & { sourceRef?: string }>;
    };

    invalidAbility.effects = [{
      ...invalidAbility.effects[0],
      id: "ef-unknown",
      effectKey: "unknown_effect_key",
      sourceRef: "seed://ability/alpha/span/1",
    }];

    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const ability = artifact.officers[0].abilities[0];
    expect(ability.effects).toHaveLength(0);
    expect(ability.unmapped.some((entry) => entry.type === "unknown_effect_key")).toBe(true);
    expect(ability.unmapped[0].evidence[0].sourceRef).toBe("seed://ability/alpha/span/1");
  });

  it("enforces ability invariant effects>0 OR isInert OR unmapped>0", () => {
    const seed = createValidSeed();
    seed.officers[1].effects = [];
    seed.officers[1].isInert = false;

    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const ability = artifact.officers[0].abilities[0];
    expect(ability.effects.length > 0 || ability.isInert || ability.unmapped.length > 0).toBe(true);
    expect(ability.unmapped.length).toBeGreaterThan(0);
  });
});

describe("effects-contract-v3 overrides", () => {
  function createReplaceOverride(effectId: string): EffectsOverrideFile {
    return {
      schemaVersion: "1.0.0",
      artifactBase: "*",
      operations: [
        {
          op: "replace_effect",
          target: {
            abilityId: "cdn:officer:100:cm",
            effectId,
          },
          value: {
            effectKey: "mitigation",
            magnitude: 0.5,
            unit: "percent",
            stacking: "additive",
            targets: {
              targetKinds: ["hostile"],
              targetTags: ["pve"],
              shipClass: null,
            },
            conditions: [{ conditionKey: "requires_attacking", params: null }],
            extraction: {
              method: "deterministic",
              ruleId: "override",
              model: null,
              promptVersion: null,
              inputDigest: "sha256:override",
            },
            inferred: false,
            promotionReceiptId: null,
            confidence: {
              score: 1,
              tier: "high",
              forcedByOverride: false,
            },
            evidence: [
              {
                sourceRef: "effect-taxonomy.json#/overrides/0",
                snippet: "manual override",
                ruleId: "override",
                sourceLocale: "en",
                sourcePath: "effect-taxonomy.json",
                sourceOffset: 0,
              },
            ],
          },
          reason: "test replace",
          author: "@test",
          ticket: "MAJ-000",
        },
      ],
    };
  }

  it("applies replace_effect using stable effect IDs and marks forcedByOverride", () => {
    const seed = createValidSeed();
    const base = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const targetEffectId = "cdn:officer:100:cm:ef:src-0";
    const overridden = applyEffectsOverridesToArtifact(base, createReplaceOverride(targetEffectId), seed.taxonomy);
    const ability = overridden.officers[0].abilities[0];
    const replaced = ability.effects.find((effect) => effect.effectId === targetEffectId);

    expect(replaced).toBeTruthy();
    expect(replaced!.effectKey).toBe("mitigation");
    expect(replaced!.confidence.forcedByOverride).toBe(true);
    expect(replaced!.extraction.method).toBe("overridden");
  });

  it("fails when override target effect is missing", () => {
    const seed = createValidSeed();
    const base = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    expect(() => applyEffectsOverridesToArtifact(base, createReplaceOverride("missing-effect"), seed.taxonomy)).toThrow(
      /Override target effect not found/,
    );
  });

  it("fails when two operations mutate the same ability/effect target", () => {
    const seed = createValidSeed();
    const base = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const duplicated = createReplaceOverride("cdn:officer:100:cm:ef:src-0");
    duplicated.operations.push({ ...duplicated.operations[0]! });

    expect(() => applyEffectsOverridesToArtifact(base, duplicated, seed.taxonomy)).toThrow(/duplicate mutation target/);
  });

  it("fails when override creates duplicate effect signatures in one ability", () => {
    const seed = createValidSeed();
    const base = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const duplicatedSignatureOverride = createReplaceOverride("cdn:officer:100:cm:ef:src-1");
    duplicatedSignatureOverride.operations[0]!.value = {
      ...base.officers[0].abilities[0].effects[0],
      extraction: {
        method: "deterministic",
        ruleId: "override",
        model: null,
        promptVersion: null,
        inputDigest: "sha256:duplicate",
      },
      inferred: false,
      promotionReceiptId: null,
      confidence: {
        score: 1,
        tier: "high",
        forcedByOverride: false,
      },
    };

    expect(() => applyEffectsOverridesToArtifact(base, duplicatedSignatureOverride, seed.taxonomy)).toThrow(
      /duplicate effect signature/,
    );
  });
});
