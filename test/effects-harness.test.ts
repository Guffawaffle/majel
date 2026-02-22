import { describe, expect, it } from "vitest";
import {
  buildEffectsContractV3Artifact,
  type EffectsSeedFile,
} from "../src/server/services/effects-contract-v3.js";
import {
  buildInferenceReportPath,
  buildDecisionTemplate,
  buildReviewPack,
  deriveInferenceReport,
  evaluateInferenceCandidate,
  hashInferenceReport,
  suggestDecisionAction,
  summarizeCandidateStatuses,
  type InferenceCandidate,
} from "../scripts/ax/effects-harness.js";

function createCandidateEffect(effectId: string): InferenceCandidate["proposedEffects"][number] {
  return {
    effectId,
    effectKey: "damage_dealt",
    magnitude: 0.2,
    unit: "percent",
    stacking: "additive",
    targets: {
      targetKinds: ["hostile"],
      targetTags: ["pve"],
      shipClass: null,
    },
    conditions: [],
    extraction: {
      method: "deterministic",
      ruleId: "seed_contract_v0",
      model: null,
      promptVersion: null,
      inputDigest: "sha256:test",
    },
    inferred: false,
    promotionReceiptId: null,
    confidence: {
      score: 1,
      tier: "high",
      forcedByOverride: false,
    },
    evidence: [{
      sourceRef: "effect-taxonomy.json#/officers/byAbilityId/test/effects/0",
      snippet: "Increase damage dealt",
      ruleId: "seed_contract_v0",
      sourceLocale: "en",
      sourcePath: "effect-taxonomy.json",
      sourceOffset: 0,
    }],
  };
}

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
  it("derives inference candidates for needs_interpretation triggers", () => {
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
    expect(report.candidates[0].model).toBeNull();
    expect(report.candidates[0].promptVersion).toBeNull();
    expect(report.candidates[0].inputDigest.startsWith("sha256:")).toBe(true);
  });

  it("hashes and names sidecar report deterministically", () => {
    const seed = createSeedWithUnmappedAbility();
    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });

    const reportA = deriveInferenceReport(artifact, "run-123");
    const reportB = deriveInferenceReport(artifact, "run-123");
    const hashA = hashInferenceReport(reportA);
    const hashB = hashInferenceReport(reportB);

    expect(hashA).toBe(hashB);
    expect(buildInferenceReportPath("run-123", hashA)).toBe(buildInferenceReportPath("run-123", hashB));
    expect(buildInferenceReportPath("run-123", hashA)).toMatch(/inference-report\.[a-f0-9]{16}\.json$/);
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

  it("marks high-confidence valid candidates as gate_passed", () => {
    const evaluated = evaluateInferenceCandidate({
      abilityId: "cdn:officer:100:oa",
      candidateId: "cand-pass",
      candidateStatus: "proposed",
      proposedEffects: [createCandidateEffect("effect-a")],
      confidence: { score: 0.91, tier: "high" },
      rationale: "test",
      gateResults: [],
      evidence: [{
        sourceRef: "effect-taxonomy.json#/test",
        snippet: "test",
        ruleId: "seed_contract_v0",
        sourceLocale: "en",
        sourcePath: "effect-taxonomy.json",
        sourceOffset: 0,
      }],
      model: null,
      promptVersion: null,
      inputDigest: "sha256:test",
    });

    expect(evaluated.candidateStatus).toBe("gate_passed");
    expect(evaluated.gateResults.every((gate) => gate.status === "pass")).toBe(true);
  });

  it("rejects candidates with duplicate effect signatures", () => {
    const duplicated = createCandidateEffect("effect-a");
    const evaluated = evaluateInferenceCandidate({
      abilityId: "cdn:officer:100:oa",
      candidateId: "cand-reject",
      candidateStatus: "proposed",
      proposedEffects: [duplicated, { ...duplicated, effectId: "effect-b" }],
      confidence: { score: 0.95, tier: "high" },
      rationale: "test",
      gateResults: [],
      evidence: [{
        sourceRef: "effect-taxonomy.json#/test",
        snippet: "test",
        ruleId: "seed_contract_v0",
        sourceLocale: "en",
        sourcePath: "effect-taxonomy.json",
        sourceOffset: 0,
      }],
      model: null,
      promptVersion: null,
      inputDigest: "sha256:test",
    });

    expect(evaluated.candidateStatus).toBe("rejected");
    expect(evaluated.gateResults.some((gate) => gate.gate === "contradiction_intra_ability" && gate.status === "fail")).toBe(true);
  });

  it("summarizes candidate status counts", () => {
    const counts = summarizeCandidateStatuses([
      { abilityId: "a", candidateId: "1", candidateStatus: "proposed", proposedEffects: [], confidence: { score: 0.5, tier: "medium" }, rationale: "", gateResults: [], evidence: [], model: null, promptVersion: null, inputDigest: "sha256:1" },
      { abilityId: "a", candidateId: "2", candidateStatus: "gate_passed", proposedEffects: [], confidence: { score: 0.9, tier: "high" }, rationale: "", gateResults: [], evidence: [], model: null, promptVersion: null, inputDigest: "sha256:2" },
      { abilityId: "a", candidateId: "3", candidateStatus: "gate_failed", proposedEffects: [], confidence: { score: 0.4, tier: "low" }, rationale: "", gateResults: [], evidence: [], model: null, promptVersion: null, inputDigest: "sha256:3" },
      { abilityId: "a", candidateId: "4", candidateStatus: "rejected", proposedEffects: [], confidence: { score: 0.8, tier: "high" }, rationale: "", gateResults: [], evidence: [], model: null, promptVersion: null, inputDigest: "sha256:4" },
    ]);

    expect(counts).toEqual({ proposed: 1, gate_passed: 1, gate_failed: 1, rejected: 1 });
  });

  it("suggests promote for gate_passed and reject for rejected", () => {
    const promote = suggestDecisionAction({
      abilityId: "a",
      candidateId: "p",
      candidateStatus: "gate_passed",
      proposedEffects: [],
      confidence: { score: 0.9, tier: "high" },
      rationale: "",
      gateResults: [],
      evidence: [],
      model: null,
      promptVersion: null,
      inputDigest: "sha256:p",
    });
    const reject = suggestDecisionAction({
      abilityId: "a",
      candidateId: "r",
      candidateStatus: "rejected",
      proposedEffects: [],
      confidence: { score: 0.9, tier: "high" },
      rationale: "",
      gateResults: [{ gate: "contradiction_intra_ability", status: "fail" }],
      evidence: [],
      model: null,
      promptVersion: null,
      inputDigest: "sha256:r",
    });

    expect(promote.action).toBe("promote");
    expect(reject.action).toBe("reject");
  });

  it("builds decisions template from review pack suggested actions", () => {
    const seed = createSeedWithUnmappedAbility();
    const artifact = buildEffectsContractV3Artifact(seed, {
      generatedAt: "2026-02-22T00:00:00.000Z",
      snapshotVersion: "stfc-test",
      generatorVersion: "0.1.0",
    });
    const report = deriveInferenceReport(artifact, "run-123");
    const pack = buildReviewPack(report, "stfc-test", "2026-02-22T00:00:00.000Z");
    const template = buildDecisionTemplate(pack);

    expect(template.runId).toBe("run-123");
    expect(template.artifactBase).toBe(pack.artifactBase);
    expect(template.decisions).toHaveLength(pack.candidateCount);
    if (template.decisions[0]) {
      expect(template.decisions[0].reason.startsWith("TODO: confirm - ")).toBe(true);
    }
  });
});
