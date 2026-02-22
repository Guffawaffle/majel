import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  applyEffectsOverridesToArtifact,
  buildEffectsContractV3Artifact,
  type EffectsOverrideFile,
  type EffectsSeedFile,
  hashEffectsContractArtifact,
  sha256Hex,
  stableJsonStringify,
  summarizeEffectsContractArtifact,
  type EffectsContractArtifact,
} from "../../src/server/services/effects-contract-v3.js";
import type { SeedAbilityInput } from "../../src/server/stores/effect-store.js";
import { ROOT } from "./runner.js";

export type EffectsBuildMode = "deterministic" | "hybrid";

export interface EffectsBuildReceipt {
  schemaVersion: "1.0.0";
  runId: string;
  mode: EffectsBuildMode;
  artifactBase: string;
  generatedAt: string;
  snapshotVersion: string;
  deterministic: {
    manifestPath: string;
    taxonomyPath: string;
    officersIndexPath: string;
    chunkPaths: string[];
    contractPath: string;
  };
  determinism: {
    stable: boolean;
    hashA: string;
    hashB: string;
  };
  stochastic?: {
    inferenceReportPath: string;
    candidateCount: number;
    statusCounts: {
      proposed: number;
      gate_passed: number;
      gate_failed: number;
      rejected: number;
      promoted: number;
    };
  };
  overrides?: {
    path: string;
    operationCount: number;
  };
  input?: {
    source: "seed" | "snapshot-export";
    inputPath?: string;
    snapshotId?: string;
    contentHash?: string;
    schemaHash?: string;
    sourceLabel?: string;
  };
  summary: ReturnType<typeof summarizeEffectsContractArtifact>;
}

export interface InferenceCandidate {
  abilityId: string;
  candidateId: string;
  candidateStatus: "proposed" | "gate_failed" | "gate_passed" | "rejected" | "promoted";
  proposedEffects: EffectsContractArtifact["officers"][number]["abilities"][number]["effects"];
  confidence: { score: number; tier: "high" | "medium" | "low" };
  rationale: string;
  gateResults: { gate: string; status: "pass" | "fail"; message?: string }[];
  evidence: EffectsContractArtifact["officers"][number]["abilities"][number]["effects"][number]["evidence"];
  model: string | null;
  promptVersion: string | null;
  inputDigest: string;
}

export function evaluateInferenceCandidate(candidate: InferenceCandidate): InferenceCandidate {
  const signatureSet = new Set<string>();
  let duplicateFound = false;

  for (const effect of candidate.proposedEffects) {
    const signature = stableJsonStringify({
      effectKey: effect.effectKey,
      magnitude: effect.magnitude,
      unit: effect.unit,
      stacking: effect.stacking,
      targets: effect.targets,
      conditions: effect.conditions,
    });
    if (signatureSet.has(signature)) {
      duplicateFound = true;
      break;
    }
    signatureSet.add(signature);
  }

  const gateResults: InferenceCandidate["gateResults"] = [
    {
      gate: "evidence_presence",
      status: candidate.evidence.length > 0 ? "pass" : "fail",
      message: candidate.evidence.length > 0 ? undefined : "Candidate has no evidence entries",
    },
    {
      gate: "contradiction_intra_ability",
      status: duplicateFound ? "fail" : "pass",
      message: duplicateFound ? "Duplicate proposed effect signatures detected" : undefined,
    },
    {
      gate: "confidence_threshold",
      status: candidate.confidence.score >= 0.7 ? "pass" : "fail",
      message: candidate.confidence.score >= 0.7 ? undefined : "Below promotion confidence threshold (0.70)",
    },
  ];

  const evidenceGateFailed = gateResults[0].status === "fail";
  const contradictionGateFailed = gateResults[1].status === "fail";
  const confidenceGatePassed = gateResults[2].status === "pass";

  let candidateStatus: InferenceCandidate["candidateStatus"] = "proposed";
  if (contradictionGateFailed) {
    candidateStatus = "rejected";
  } else if (evidenceGateFailed) {
    candidateStatus = "gate_failed";
  } else if (confidenceGatePassed) {
    candidateStatus = "gate_passed";
  }

  return {
    ...candidate,
    candidateStatus,
    gateResults,
  };
}

export function summarizeCandidateStatuses(candidates: InferenceCandidate[]): {
  proposed: number;
  gate_passed: number;
  gate_failed: number;
  rejected: number;
  promoted: number;
} {
  const counts = {
    proposed: 0,
    gate_passed: 0,
    gate_failed: 0,
    rejected: 0,
    promoted: 0,
  };

  for (const candidate of candidates) {
    counts[candidate.candidateStatus]++;
  }

  return counts;
}

export interface InferenceReport {
  schemaVersion: "1.0.0";
  artifactBase: string;
  runId: string;
  model: string | null;
  promptVersion: string | null;
  candidates: InferenceCandidate[];
}

export interface GateRunResult {
  candidate: InferenceCandidate;
  allPassed: boolean;
}

export interface ReviewDecisionInput {
  candidateId: string;
  action: ReviewDecisionAction;
  reason: string;
  ticket?: string;
}

export interface PromotionRunResult {
  artifact: EffectsContractArtifact;
  report: InferenceReport;
  gateOutcomes: Array<{
    candidateId: string;
    action: ReviewDecisionAction;
    promoted: boolean;
    reason: string;
    gateResults: InferenceCandidate["gateResults"];
  }>;
}

const INTERPRETATION_TRIGGER_UNMAPPED_TYPES = new Set<string>([
  "unmapped_ability_text",
  "unknown_magnitude",
  "low_confidence_mapping",
  "unknown_effect_key",
]);

export interface ReviewPack {
  schemaVersion: "1.0.0";
  runId: string;
  artifactBase: string;
  snapshotVersion: string;
  generatedAt: string;
  candidateCount: number;
  candidates: ReviewPackCandidate[];
}

export type ReviewDecisionAction = "promote" | "reject" | "override" | "rule";

export interface ReviewPackCandidate extends InferenceCandidate {
  suggestedAction: ReviewDecisionAction;
  suggestedReason: string;
}

export interface ReviewDecisionTemplate {
  schemaVersion: "1.0.0";
  runId: string;
  artifactBase: string;
  decisions: {
    candidateId: string;
    action: ReviewDecisionAction;
    reason: string;
    ticket?: string;
  }[];
}

export interface EffectsSnapshotExportFile {
  schemaVersion: "1.0.0";
  snapshot: {
    snapshotId: string;
    source: string;
    sourceVersion: string;
    generatedAt: string;
    schemaHash: string;
    contentHash: string;
  };
  officers: Array<{
    officerId: string;
    abilities: Array<{
      abilityId: string;
      slot: "cm" | "oa" | "bda";
      name: string | null;
      rawText: string;
      isInert: boolean;
      sourceRef: string;
    }>;
  }>;
}

export async function readEffectsSeedFile(): Promise<EffectsSeedFile> {
  const seedPath = resolve(ROOT, "data", "seed", "effect-taxonomy.json");
  const raw = await readFile(seedPath, "utf-8");
  return JSON.parse(raw) as EffectsSeedFile;
}

export async function readEffectsOverridesFile(): Promise<EffectsOverrideFile> {
  const path = resolve(ROOT, "data", "seed", "effects-overrides.v1.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as EffectsOverrideFile;
  } catch {
    return {
      schemaVersion: "1.0.0",
      artifactBase: "*",
      operations: [],
    };
  }
}

export async function readEffectsSnapshotExportFile(path: string): Promise<EffectsSnapshotExportFile> {
  const absolute = resolve(ROOT, path);
  const raw = await readFile(absolute, "utf-8");
  return JSON.parse(raw) as EffectsSnapshotExportFile;
}

export function abilitiesFromSnapshotExport(snapshot: EffectsSnapshotExportFile): SeedAbilityInput[] {
  const abilities: SeedAbilityInput[] = [];

  for (const officer of snapshot.officers) {
    for (const ability of officer.abilities) {
      abilities.push({
        id: ability.abilityId,
        officerId: officer.officerId,
        slot: ability.slot,
        name: ability.name,
        rawText: ability.rawText,
        isInert: ability.isInert,
        effects: [],
      });
    }
  }

  return abilities;
}

export async function writeJsonAt(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export { summarizeEffectsContractArtifact };

export function createRunId(): string {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${iso}-${Math.random().toString(16).slice(2, 8)}`;
}

export function buildDeterministicArtifacts(
  seed: EffectsSeedFile,
  runId: string,
  snapshotVersion: string,
  artifactInput?: EffectsContractArtifact,
): {
  artifact: EffectsContractArtifact;
  artifactHash: string;
  manifestPath: string;
  taxonomyPath: string;
  officersIndexPath: string;
  chunkPaths: string[];
  contractPath: string;
} {
  const artifact = artifactInput ?? buildEffectsContractV3Artifact(seed, { snapshotVersion, generatorVersion: "0.1.0" });
  const artifactHash = hashEffectsContractArtifact(artifact);
  const shortHash = artifactHash.slice(0, 16);

  const baseDir = resolve(ROOT, "tmp", "effects", "runs", runId, "artifacts");
  const effectsDir = resolve(baseDir, "effects");

  const taxonomyPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    taxonomyRef: artifact.taxonomyRef,
    taxonomy: seed.taxonomy,
  };

  const officersIndexPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    officers: artifact.officers.map((officer) => ({
      officerId: officer.officerId,
      officerName: officer.officerName,
      abilities: officer.abilities.map((ability) => ({
        abilityId: ability.abilityId,
        slot: ability.slot,
        effectCount: ability.effects.length,
        unmappedCount: ability.unmapped.length,
      })),
    })),
  };

  const chunkPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    officers: artifact.officers,
  };

  const taxonomyHash = sha256Hex(stableJsonStringify(taxonomyPayload)).slice(0, 16);
  const indexHash = sha256Hex(stableJsonStringify(officersIndexPayload)).slice(0, 16);
  const chunkHash = sha256Hex(stableJsonStringify(chunkPayload)).slice(0, 16);

  const taxonomyPath = resolve(baseDir, `taxonomy.${taxonomyHash}.json`);
  const officersIndexPath = resolve(baseDir, `officers.index.${indexHash}.json`);
  const chunkPath = resolve(effectsDir, `chunk-0001.${chunkHash}.json`);
  const contractPath = resolve(baseDir, `effects-contract.v3.${shortHash}.json`);
  const manifestPath = resolve(baseDir, `manifest.${shortHash}.json`);

  return {
    artifact,
    artifactHash,
    manifestPath,
    taxonomyPath,
    officersIndexPath,
    chunkPaths: [chunkPath],
    contractPath,
  };
}

export function applyOverridesForBuild(
  artifact: EffectsContractArtifact,
  overrides: EffectsOverrideFile,
  seed: EffectsSeedFile,
): EffectsContractArtifact {
  return applyEffectsOverridesToArtifact(artifact, overrides, seed.taxonomy);
}

export async function writeDeterministicArtifacts(input: {
  seed: EffectsSeedFile;
  runId: string;
  artifact: EffectsContractArtifact;
  artifactHash: string;
  manifestPath: string;
  taxonomyPath: string;
  officersIndexPath: string;
  chunkPaths: string[];
  contractPath: string;
}): Promise<void> {
  const { seed, artifact, artifactHash, manifestPath, taxonomyPath, officersIndexPath, chunkPaths, contractPath } = input;

  const taxonomyPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    taxonomyRef: artifact.taxonomyRef,
    taxonomy: seed.taxonomy,
  };

  const officersIndexPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    officers: artifact.officers.map((officer) => ({
      officerId: officer.officerId,
      officerName: officer.officerName,
      abilities: officer.abilities.map((ability) => ({
        abilityId: ability.abilityId,
        slot: ability.slot,
        effectCount: ability.effects.length,
        unmappedCount: ability.unmapped.length,
      })),
    })),
  };

  const chunkPayload = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    officers: artifact.officers,
  };

  const manifest = {
    schemaVersion: artifact.schemaVersion,
    artifactVersion: artifact.artifactVersion,
    generatedAt: artifact.generatedAt,
    runId: input.runId,
    artifactHash: `sha256:${artifactHash}`,
    paths: {
      taxonomy: taxonomyPath,
      officersIndex: officersIndexPath,
      effects: chunkPaths,
      contract: contractPath,
    },
  };

  await writeJsonAt(taxonomyPath, taxonomyPayload);
  await writeJsonAt(officersIndexPath, officersIndexPayload);
  await writeJsonAt(chunkPaths[0], chunkPayload);
  await writeJsonAt(contractPath, artifact);
  await writeJsonAt(manifestPath, manifest);
}

export function deriveInferenceReport(
  artifact: EffectsContractArtifact,
  runId: string,
): InferenceReport {
  const rawCandidates: InferenceCandidate[] = [];

  for (const officer of artifact.officers) {
    for (const ability of officer.abilities) {
      const hasTriggerUnmapped = ability.unmapped.some((entry) => INTERPRETATION_TRIGGER_UNMAPPED_TYPES.has(entry.type));
      const shouldPropose = (!ability.isInert && ability.effects.length === 0) || hasTriggerUnmapped;
      if (!shouldPropose) continue;

      const evidence = ability.effects.flatMap((effect) => effect.evidence);
      const fallbackEvidence = [{
        sourceRef: `effect-taxonomy.json#/officers/byAbilityId/${ability.abilityId}`,
        snippet: ability.rawText,
        ruleId: "seed_contract_v0",
        sourceLocale: "en" as const,
        sourcePath: "effect-taxonomy.json" as const,
        sourceOffset: 0,
      }];

      const provenanceModel = ability.effects.find((effect) => effect.extraction.model !== null)?.extraction.model ?? null;
      const provenancePromptVersion = ability.effects.find((effect) => effect.extraction.promptVersion !== null)?.extraction.promptVersion ?? null;
      const inputDigest = `sha256:${sha256Hex(stableJsonStringify({
        abilityId: ability.abilityId,
        rawText: ability.rawText,
        effectDigests: ability.effects.map((effect) => effect.extraction.inputDigest),
      }))}`;

      rawCandidates.push({
        abilityId: ability.abilityId,
        candidateId: `${ability.abilityId}:cand:0`,
        candidateStatus: "proposed",
        proposedEffects: ability.effects,
        confidence: { score: 0.55, tier: "medium" },
        rationale: "Deterministic extraction yielded unmapped/empty effect coverage; candidate queued for review",
        gateResults: [],
        evidence: evidence.length > 0 ? evidence : fallbackEvidence,
        model: provenanceModel,
        promptVersion: provenancePromptVersion,
        inputDigest,
      });
    }
  }

  const candidates = rawCandidates
    .map((candidate) => evaluateInferenceCandidate(candidate))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));

  return {
    schemaVersion: "1.0.0",
    artifactBase: artifact.artifactVersion,
    runId,
    model: null,
    promptVersion: null,
    candidates,
  };
}

export function hashInferenceReport(report: InferenceReport): string {
  return sha256Hex(stableJsonStringify(report));
}

export function buildInferenceReportPath(runId: string, reportHash: string): string {
  const shortHash = reportHash.slice(0, 16);
  return resolve("tmp", "effects", "runs", runId, `inference-report.${shortHash}.json`);
}

function effectSignature(effect: EffectsContractArtifact["officers"][number]["abilities"][number]["effects"][number]): string {
  return stableJsonStringify({
    effectKey: effect.effectKey,
    magnitude: effect.magnitude,
    unit: effect.unit,
    stacking: effect.stacking,
    targets: effect.targets,
    conditions: effect.conditions,
  });
}

export function runInferenceCandidateGates(
  candidate: InferenceCandidate,
  taxonomy: EffectsSeedFile["taxonomy"],
): GateRunResult {
  const taxonomyEffectKeys = new Set(taxonomy.effectKeys.map((item) => item.id));
  const taxonomyConditionKeys = new Set(taxonomy.conditionKeys.map((item) => item.id));
  const taxonomyTargetKinds = new Set(taxonomy.targetKinds);
  const taxonomyTargetTags = new Set(taxonomy.targetTags);
  const taxonomyShipClasses = new Set(taxonomy.shipClasses);

  const schemaValid = candidate.proposedEffects.every((effect) => (
    typeof effect.effectKey === "string"
    && Array.isArray(effect.targets.targetKinds)
    && Array.isArray(effect.targets.targetTags)
    && Array.isArray(effect.conditions)
  ));

  const taxonomyValid = candidate.proposedEffects.every((effect) => (
    taxonomyEffectKeys.has(effect.effectKey)
    && effect.targets.targetKinds.every((value) => taxonomyTargetKinds.has(value))
    && effect.targets.targetTags.every((value) => taxonomyTargetTags.has(value))
    && (effect.targets.shipClass === null || taxonomyShipClasses.has(effect.targets.shipClass))
    && effect.conditions.every((condition) => taxonomyConditionKeys.has(condition.conditionKey))
  ));

  const conditionSchemaValid = candidate.proposedEffects.every((effect) => (
    effect.conditions.every((condition) => {
      if (condition.params === null) return true;
      return Object.values(condition.params).every((value) => typeof value === "string");
    })
  ));

  const deterministicOrdering = candidate.proposedEffects.every((effect) => (
    effect.conditions.every((condition) => {
      if (condition.params === null) return true;
      const keys = Object.keys(condition.params);
      return keys.every((key, index) => index === 0 || keys[index - 1]!.localeCompare(key) <= 0);
    })
  ));

  const confidencePass = candidate.confidence.score >= 0.7 && candidate.confidence.tier === "high";
  const contradictionIntraAbility = (() => {
    const signatures = new Set<string>();
    for (const effect of candidate.proposedEffects) {
      const signature = effectSignature(effect);
      if (signatures.has(signature)) return false;
      signatures.add(signature);
    }
    return true;
  })();

  const gateResults: InferenceCandidate["gateResults"] = [
    { gate: "schema_validity", status: schemaValid ? "pass" : "fail" },
    { gate: "taxonomy_validity", status: taxonomyValid ? "pass" : "fail" },
    { gate: "condition_schema_validity", status: conditionSchemaValid ? "pass" : "fail" },
    { gate: "ordering_determinism", status: deterministicOrdering ? "pass" : "fail" },
    { gate: "confidence_threshold", status: confidencePass ? "pass" : "fail" },
    { gate: "contradiction_intra_ability", status: contradictionIntraAbility ? "pass" : "fail" },
  ];

  const allPassed = gateResults.every((gate) => gate.status === "pass");
  const nextStatus: InferenceCandidate["candidateStatus"] = allPassed ? "gate_passed" : "rejected";

  return {
    allPassed,
    candidate: {
      ...candidate,
      candidateStatus: nextStatus,
      gateResults,
    },
  };
}

function enforceNoOverwriteInvariant(
  baseArtifact: EffectsContractArtifact,
  nextArtifact: EffectsContractArtifact,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  const baseAbilityMap = new Map<string, EffectsContractArtifact["officers"][number]["abilities"][number]>();
  for (const officer of baseArtifact.officers) {
    for (const ability of officer.abilities) baseAbilityMap.set(ability.abilityId, ability);
  }

  for (const officer of nextArtifact.officers) {
    for (const ability of officer.abilities) {
      const baseAbility = baseAbilityMap.get(ability.abilityId);
      if (!baseAbility) continue;

      const baseSignatures = new Set(baseAbility.effects.map((effect) => effectSignature(effect)));
      const nextSignatures = new Set(ability.effects.map((effect) => effectSignature(effect)));

      for (const signature of baseSignatures) {
        if (!nextSignatures.has(signature)) {
          violations.push(`${ability.abilityId}: deterministic signature removed`);
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function applyPromotionDecisions(input: {
  artifact: EffectsContractArtifact;
  report: InferenceReport;
  taxonomy: EffectsSeedFile["taxonomy"];
  decisions: ReviewDecisionInput[];
  receiptId: string;
}): PromotionRunResult {
  const { artifact, report, taxonomy, decisions, receiptId } = input;
  const decisionByCandidateId = new Map(decisions.map((entry) => [entry.candidateId, entry]));
  const artifactNext = JSON.parse(JSON.stringify(artifact)) as EffectsContractArtifact;
  const reportCandidates = [...report.candidates];

  const abilityLookup = new Map<string, EffectsContractArtifact["officers"][number]["abilities"][number]>();
  for (const officer of artifactNext.officers) {
    for (const ability of officer.abilities) {
      abilityLookup.set(ability.abilityId, ability);
    }
  }

  const gateOutcomes: PromotionRunResult["gateOutcomes"] = [];

  for (let index = 0; index < reportCandidates.length; index += 1) {
    const originalCandidate = reportCandidates[index]!;
    const gateRun = runInferenceCandidateGates(originalCandidate, taxonomy);
    const decision = decisionByCandidateId.get(originalCandidate.candidateId);
    const action = decision?.action ?? "reject";

    let promoted = false;
    let candidateNext = gateRun.candidate;
    const reason = decision?.reason ?? "Missing explicit decision; default reject";

    if (action === "promote" && gateRun.allPassed) {
      const ability = abilityLookup.get(originalCandidate.abilityId);
      if (!ability) {
        gateOutcomes.push({
          candidateId: originalCandidate.candidateId,
          action,
          promoted: false,
          reason: `Missing ability target for candidate: ${reason}`,
          gateResults: gateRun.candidate.gateResults,
        });
        reportCandidates[index] = { ...candidateNext, candidateStatus: "rejected" };
        continue;
      }

      const existingSignatures = new Set(ability.effects.map((effect) => effectSignature(effect)));
      const promotedEffects = originalCandidate.proposedEffects.filter((effect) => !existingSignatures.has(effectSignature(effect)));
      if (promotedEffects.length > 0) {
        let inferredIndex = ability.effects.filter((effect) => effect.inferred).length;
        const mappedEffects = promotedEffects.map((effect) => {
          inferredIndex += 1;
          return {
            ...effect,
            effectId: `${ability.abilityId}:inf:${inferredIndex}`,
            extraction: {
              method: "inferred" as const,
              ruleId: effect.extraction.ruleId,
              model: originalCandidate.model,
              promptVersion: originalCandidate.promptVersion,
              inputDigest: originalCandidate.inputDigest,
            },
            inferred: true as const,
            promotionReceiptId: receiptId,
          };
        });
        ability.effects.push(...mappedEffects);
        promoted = true;
        candidateNext = {
          ...candidateNext,
          candidateStatus: "promoted",
        };
      }
    }

    if (!promoted && action === "promote") {
      candidateNext = {
        ...candidateNext,
        candidateStatus: "rejected",
      };
    }

    reportCandidates[index] = candidateNext;
    gateOutcomes.push({
      candidateId: originalCandidate.candidateId,
      action,
      promoted,
      reason,
      gateResults: candidateNext.gateResults,
    });
  }

  const invariant = enforceNoOverwriteInvariant(artifact, artifactNext);
  if (!invariant.ok) {
    throw new Error(`No-overwrite invariant violated: ${invariant.violations.join("; ")}`);
  }

  const reportNext: InferenceReport = {
    ...report,
    candidates: reportCandidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  };

  return {
    artifact: artifactNext,
    report: reportNext,
    gateOutcomes,
  };
}

export function buildReviewPack(
  report: InferenceReport,
  snapshotVersion: string,
  generatedAt: string,
): ReviewPack {
  const candidates = report.candidates.filter((candidate) => {
    if (candidate.candidateStatus === "proposed" || candidate.candidateStatus === "gate_failed" || candidate.candidateStatus === "rejected") return true;
    return candidate.confidence.tier !== "high";
  }).map((candidate) => {
    const suggestion = suggestDecisionAction(candidate);
    return {
      ...candidate,
      suggestedAction: suggestion.action,
      suggestedReason: suggestion.reason,
    };
  });

  return {
    schemaVersion: "1.0.0",
    runId: report.runId,
    artifactBase: report.artifactBase,
    snapshotVersion,
    generatedAt,
    candidateCount: candidates.length,
    candidates,
  };
}

export function suggestDecisionAction(candidate: InferenceCandidate): {
  action: ReviewDecisionAction;
  reason: string;
} {
  if (candidate.candidateStatus === "rejected") {
    return {
      action: "reject",
      reason: "Contradiction or duplicate signature gate failed",
    };
  }

  if (candidate.candidateStatus === "gate_passed") {
    return {
      action: "promote",
      reason: "Candidate passed current deterministic gates and confidence threshold",
    };
  }

  const evidenceFailed = candidate.gateResults.some(
    (gate) => gate.gate === "evidence_presence" && gate.status === "fail",
  );
  if (evidenceFailed) {
    return {
      action: "rule",
      reason: "Evidence gap suggests deterministic parsing/rule improvement",
    };
  }

  if (candidate.candidateStatus === "gate_failed") {
    return {
      action: "override",
      reason: "Gate failure requires explicit override or manual review before promotion",
    };
  }

  if (candidate.confidence.tier === "low") {
    return {
      action: "rule",
      reason: "Low-confidence candidate should drive rule refinement instead of direct promotion",
    };
  }

  return {
    action: "override",
    reason: "Medium-confidence proposal requires explicit override/manual adjudication",
  };
}

export function buildDecisionTemplate(pack: ReviewPack): ReviewDecisionTemplate {
  return {
    schemaVersion: "1.0.0",
    runId: pack.runId,
    artifactBase: pack.artifactBase,
    decisions: pack.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      action: candidate.suggestedAction,
      reason: `TODO: confirm - ${candidate.suggestedReason}`,
    })),
  };
}

export function buildReviewPackMarkdown(pack: ReviewPack): string {
  const lines: string[] = [];
  lines.push(`# Effects Review Pack — ${pack.runId}`);
  lines.push("");
  lines.push(`- artifactBase: ${pack.artifactBase}`);
  lines.push(`- snapshotVersion: ${pack.snapshotVersion}`);
  lines.push(`- generatedAt: ${pack.generatedAt}`);
  lines.push(`- candidateCount: ${pack.candidateCount}`);
  lines.push("");

  if (pack.candidates.length === 0) {
    lines.push("No candidates require AI review for this run.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  for (const candidate of pack.candidates) {
    lines.push(`## ${candidate.candidateId}`);
    lines.push(`- abilityId: ${candidate.abilityId}`);
    lines.push(`- status: ${candidate.candidateStatus}`);
    lines.push(`- confidence: ${candidate.confidence.score} (${candidate.confidence.tier})`);
    lines.push(`- rationale: ${candidate.rationale}`);
    lines.push(`- proposedEffects: ${candidate.proposedEffects.length}`);
    lines.push(`- gateResults: ${candidate.gateResults.map((gate) => `${gate.gate}:${gate.status}`).join(", ")}`);
    lines.push(`- suggestedAction: ${candidate.suggestedAction}`);
    lines.push(`- suggestedReason: ${candidate.suggestedReason}`);
    if (candidate.evidence[0]) {
      lines.push(`- evidence: ${candidate.evidence[0].sourceRef}`);
      lines.push(`- snippet: ${candidate.evidence[0].snippet}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
