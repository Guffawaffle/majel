import { describe, expect, it } from "vitest";
import {
  buildEffectsContractV3Artifact,
  type EffectsSeedFile,
} from "../src/server/services/effects-contract-v3.js";
import {
  buildReviewPack,
  deriveInferenceReport,
} from "../scripts/ax/effects-harness.js";

function createSeedWithUnmappedAbility(): EffectsSeedFile {
  return {
    taxonomy: {
      targetKinds: ["hostile"],
      targetTags: ["pve"],
      shipClasses: ["explorer"],
      slots: ["cm", "oa", "bda"],
      effectKeys: [{ id: "damage_dealt", category: "damage" }],
      conditionKeys: [],
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
        id: "mapped-cm",
        officerId: "cdn:officer:100",
        slot: "cm",
        name: "Mapped",
        rawText: "Increase damage dealt by 20%.",
        isInert: false,
        effects: [{
          id: "mapped-effect",
          effectKey: "damage_dealt",
          magnitude: 0.2,
          unit: "percent",
          stacking: "additive",
          targetKinds: ["hostile"],
          targetTags: ["pve"],
          conditions: [],
        }],
      },
      {
        id: "unmapped-oa",
        officerId: "cdn:officer:100",
        slot: "oa",
        name: "Unmapped",
        rawText: "Do mysterious thing",
        isInert: false,
        effects: [],
      },
    ],
  };
}

describe("effects-harness inference + review pack", () => {
  it("derives hybrid inference candidates only for unmapped abilities", () => {
    const seed = createSeedWithUnmappedAbility();
    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const report = deriveInferenceReport(artifact, "run-123");
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].abilityId).toBe("cdn:officer:100:oa");
    expect(report.candidates[0].candidateStatus).toBe("proposed");
    expect(report.candidates[0].gateResults.some((gate) => gate.gate === "confidence_threshold")).toBe(true);
  });

  it("buildReviewPack includes proposed and medium/low confidence candidates", () => {
    const seed = createSeedWithUnmappedAbility();
    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });
    const report = deriveInferenceReport(artifact, "run-123");

    const pack = buildReviewPack(report, "stfc-test", "2026-02-22T00:00:00.000Z");
    expect(pack.runId).toBe("run-123");
    expect(pack.candidateCount).toBe(1);
    expect(pack.candidates[0].confidence.tier).toBe("medium");
  });
});
