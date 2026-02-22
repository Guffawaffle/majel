import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  sha256Hex,
  stableJsonStringify,
  summarizeEffectsContractArtifact,
  type EffectsContractArtifact,
  type EffectsSeedFile,
} from "../../src/server/services/effects-contract-v3.js";
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
  };
  summary: ReturnType<typeof summarizeEffectsContractArtifact>;
}

export interface InferenceCandidate {
  abilityId: string;
  candidateId: string;
  candidateStatus: "proposed" | "gate_failed" | "gate_passed" | "rejected";
  proposedEffects: EffectsContractArtifact["officers"][number]["abilities"][number]["effects"];
  confidence: { score: number; tier: "high" | "medium" | "low" };
  rationale: string;
  gateResults: { gate: string; status: "pass" | "fail"; message?: string }[];
  evidence: EffectsContractArtifact["officers"][number]["abilities"][number]["effects"][number]["evidence"];
}

export interface InferenceReport {
  schemaVersion: "1.0.0";
  artifactBase: string;
  runId: string;
  model: string | null;
  promptVersion: string | null;
  candidates: InferenceCandidate[];
}

export interface ReviewPack {
  schemaVersion: "1.0.0";
  runId: string;
  artifactBase: string;
  snapshotVersion: string;
  generatedAt: string;
  candidateCount: number;
  candidates: InferenceCandidate[];
}

export async function readEffectsSeedFile(): Promise<EffectsSeedFile> {
  const seedPath = resolve(ROOT, "data", "seed", "effect-taxonomy.json");
  const raw = await readFile(seedPath, "utf-8");
  return JSON.parse(raw) as EffectsSeedFile;
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
): {
  artifact: EffectsContractArtifact;
  artifactHash: string;
  manifestPath: string;
  taxonomyPath: string;
  officersIndexPath: string;
  chunkPaths: string[];
  contractPath: string;
} {
  const artifact = buildEffectsContractV3Artifact(seed, { snapshotVersion, generatorVersion: "0.1.0" });
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
  const candidates: InferenceCandidate[] = [];

  for (const officer of artifact.officers) {
    for (const ability of officer.abilities) {
      const shouldPropose = !ability.isInert && (ability.unmapped.length > 0 || ability.effects.length === 0);
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

      candidates.push({
        abilityId: ability.abilityId,
        candidateId: `${ability.abilityId}:cand:0`,
        candidateStatus: "proposed",
        proposedEffects: ability.effects,
        confidence: { score: 0.55, tier: "medium" },
        rationale: "Deterministic extraction yielded unmapped/empty effect coverage; candidate queued for review",
        gateResults: [
          { gate: "schema_validity", status: "pass" },
          { gate: "taxonomy_validity", status: "pass" },
          { gate: "confidence_threshold", status: "fail", message: "Below promotion threshold" },
        ],
        evidence: evidence.length > 0 ? evidence : fallbackEvidence,
      });
    }
  }

  return {
    schemaVersion: "1.0.0",
    artifactBase: artifact.artifactVersion,
    runId,
    model: null,
    promptVersion: null,
    candidates,
  };
}

export function buildReviewPack(
  report: InferenceReport,
  snapshotVersion: string,
  generatedAt: string,
): ReviewPack {
  const candidates = report.candidates.filter((candidate) => {
    if (candidate.candidateStatus === "proposed" || candidate.candidateStatus === "gate_failed") return true;
    return candidate.confidence.tier !== "high";
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
    if (candidate.evidence[0]) {
      lines.push(`- evidence: ${candidate.evidence[0].sourceRef}`);
      lines.push(`- snippet: ${candidate.evidence[0].snippet}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
