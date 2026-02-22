import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";
import {
  buildDeterministicArtifacts,
  createRunId,
  deriveInferenceReport,
  readEffectsSeedFile,
  summarizeEffectsContractArtifact,
  summarizeCandidateStatuses,
  type EffectsBuildMode,
  type EffectsBuildReceipt,
  writeDeterministicArtifacts,
  writeJsonAt,
} from "./effects-harness.js";
import {
  buildEffectsContractV3Artifact,
  hashEffectsContractArtifact,
  validateEffectsSeedForV3,
} from "../../src/server/services/effects-contract-v3.js";

const command: AxCommand = {
  name: "effects:build",
  description: "Build effects artifacts + receipt (--snapshot, --mode=deterministic|hybrid)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const mode = (getFlag(args, "mode") ?? "deterministic") as EffectsBuildMode;
    if (mode !== "deterministic" && mode !== "hybrid") {
      return makeResult("effects:build", start, {}, {
        success: false,
        errors: [`Invalid mode '${mode}'`],
        hints: ["Use --mode=deterministic or --mode=hybrid"],
      });
    }

    const snapshotVersion = getFlag(args, "snapshot") ?? "stfc-seed-v0";
    const runId = createRunId();
    const seed = await readEffectsSeedFile();

    const validation = validateEffectsSeedForV3(seed);
    if (!validation.ok) {
      return makeResult("effects:build", start, {
        runId,
        snapshotVersion,
        mode,
        errors: validation.errors,
        warnings: validation.warnings,
        issues: validation.issues.slice(0, 50),
      }, {
        success: false,
        errors: ["Seed contract validation failed"],
        hints: ["Run: npm run effects:dry-run"],
      });
    }

    const built = buildDeterministicArtifacts(seed, runId, snapshotVersion);

    const determinismProbe = (() => {
      const fixedGeneratedAt = built.artifact.generatedAt;
      const a = buildEffectsContractV3Artifact(seed, {
        snapshotVersion,
        generatorVersion: "0.1.0",
        generatedAt: fixedGeneratedAt,
      });
      const b = buildEffectsContractV3Artifact(seed, {
        snapshotVersion,
        generatorVersion: "0.1.0",
        generatedAt: fixedGeneratedAt,
      });
      const hashA = hashEffectsContractArtifact(a);
      const hashB = hashEffectsContractArtifact(b);
      return {
        stable: hashA === hashB,
        hashA,
        hashB,
      };
    })();

    if (!determinismProbe.stable) {
      return makeResult("effects:build", start, {
        runId,
        mode,
        snapshotVersion,
        determinism: determinismProbe,
      }, {
        success: false,
        errors: ["Determinism gate failed: identical input produced divergent hashes"],
      });
    }

    await writeDeterministicArtifacts({
      seed,
      runId,
      artifact: built.artifact,
      artifactHash: built.artifactHash,
      manifestPath: built.manifestPath,
      taxonomyPath: built.taxonomyPath,
      officersIndexPath: built.officersIndexPath,
      chunkPaths: built.chunkPaths,
      contractPath: built.contractPath,
    });

    const summary = summarizeEffectsContractArtifact(built.artifact);
    const receiptPath = resolve("receipts", `effects-build.${runId}.json`);
    const receipt: EffectsBuildReceipt = {
      schemaVersion: "1.0.0",
      runId,
      mode,
      artifactBase: built.artifact.artifactVersion,
      generatedAt: built.artifact.generatedAt,
      snapshotVersion,
      deterministic: {
        manifestPath: built.manifestPath,
        taxonomyPath: built.taxonomyPath,
        officersIndexPath: built.officersIndexPath,
        chunkPaths: built.chunkPaths,
        contractPath: built.contractPath,
      },
      determinism: determinismProbe,
      summary,
    };

    if (mode === "hybrid") {
      const report = deriveInferenceReport(built.artifact, runId);
      const reportPath = resolve("tmp", "effects", "runs", runId, "inference-report.json");
      await writeJsonAt(reportPath, report);
      const statusCounts = summarizeCandidateStatuses(report.candidates);
      receipt.stochastic = {
        inferenceReportPath: reportPath,
        candidateCount: report.candidates.length,
        statusCounts,
      };
    }

    await writeJsonAt(receiptPath, receipt);

    return makeResult("effects:build", start, {
      runId,
      mode,
      snapshotVersion,
      artifactBase: receipt.artifactBase,
      deterministic: receipt.deterministic,
      stochastic: receipt.stochastic ?? null,
      receiptPath,
      determinism: determinismProbe,
      summary,
    });
  },
};

export default command;
