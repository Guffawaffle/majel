import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";
import {
  abilitiesFromSnapshotExport,
  applyOverridesForBuild,
  buildInferenceReportPath,
  buildDeterministicArtifacts,
  createRunId,
  readEffectsOverridesFile,
  readEffectsSnapshotExportFile,
  deriveInferenceReport,
  deriveInferenceReportWithModel,
  hashInferenceReport,
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
    const inputPath = getFlag(args, "input");
    const runId = createRunId();
    const overridesPath = resolve("data", "seed", "effects-overrides.v1.json");
    const seed = await readEffectsSeedFile();
    let inputSource: "seed" | "snapshot-export" = "seed";
    let inputMetadata: Record<string, unknown> | undefined;

    if (inputPath) {
      const snapshotExport = await readEffectsSnapshotExportFile(inputPath);
      seed.officers = abilitiesFromSnapshotExport(snapshotExport, seed.taxonomy);
      inputSource = "snapshot-export";
      inputMetadata = {
        inputPath,
        snapshotId: snapshotExport.snapshot.snapshotId,
        contentHash: snapshotExport.snapshot.contentHash,
        schemaHash: snapshotExport.snapshot.schemaHash,
        sourceLabel: snapshotExport.snapshot.source,
      };
    }

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

    const builtBase = buildDeterministicArtifacts(seed, runId, snapshotVersion);
    const overrides = await readEffectsOverridesFile();
    let artifactWithOverrides;
    try {
      artifactWithOverrides = applyOverridesForBuild(builtBase.artifact, overrides, seed);
    } catch (error) {
      return makeResult("effects:build", start, {
        runId,
        mode,
        snapshotVersion,
        overridesPath,
      }, {
        success: false,
        errors: [error instanceof Error ? `Override application failed: ${error.message}` : "Override application failed"],
        hints: ["Validate data/seed/effects-overrides.v1.json targets and taxonomy references"],
      });
    }
    const built = buildDeterministicArtifacts(seed, runId, snapshotVersion, artifactWithOverrides);

    let determinismProbe: {
      stable: boolean;
      hashA: string;
      hashB: string;
    };
    try {
      determinismProbe = (() => {
        const fixedGeneratedAt = built.artifact.generatedAt;
        const aBase = buildEffectsContractV3Artifact(seed, {
          snapshotVersion,
          generatorVersion: "0.1.0",
          generatedAt: fixedGeneratedAt,
        });
        const bBase = buildEffectsContractV3Artifact(seed, {
          snapshotVersion,
          generatorVersion: "0.1.0",
          generatedAt: fixedGeneratedAt,
        });
        const a = applyOverridesForBuild(aBase, overrides, seed);
        const b = applyOverridesForBuild(bBase, overrides, seed);
        const hashA = hashEffectsContractArtifact(a);
        const hashB = hashEffectsContractArtifact(b);
        return {
          stable: hashA === hashB,
          hashA,
          hashB,
        };
      })();
    } catch (error) {
      return makeResult("effects:build", start, {
        runId,
        mode,
        snapshotVersion,
        overridesPath,
      }, {
        success: false,
        errors: [error instanceof Error ? `Override determinism probe failed: ${error.message}` : "Override determinism probe failed"],
      });
    }

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
      overrides: {
        path: overridesPath,
        operationCount: overrides.operations.length,
      },
      summary,
    };

    if (inputMetadata) {
      receipt.input = {
        source: inputSource,
        ...inputMetadata,
      };
    }

    if (mode === "hybrid") {
      const baseReport = deriveInferenceReport(built.artifact, runId, seed.taxonomy);
      const report = await deriveInferenceReportWithModel({
        report: baseReport,
        artifact: built.artifact,
        taxonomy: seed.taxonomy,
      });
      const reportHash = hashInferenceReport(report);
      const reportPath = buildInferenceReportPath(runId, reportHash);
      await writeJsonAt(reportPath, report);
      const statusCounts = summarizeCandidateStatuses(report.candidates);

      const deterministicSweepPath = resolve("tmp", "effects", "runs", runId, "deterministic-improvement-sweep.json");
      if (report.deterministicImprovementSweep) {
        await writeJsonAt(deterministicSweepPath, report.deterministicImprovementSweep);
      }

      receipt.stochastic = {
        inferenceReportPath: reportPath,
        candidateCount: report.candidates.length,
        statusCounts,
        deterministicSweepPath,
        deterministicSweepCount: report.deterministicImprovementSweep?.opportunityCount ?? 0,
        modelRun: report.modelRun,
      };
    }

    await writeJsonAt(receiptPath, receipt);

    return makeResult("effects:build", start, {
      runId,
      mode,
      snapshotVersion,
      input: {
        source: inputSource,
        ...(inputMetadata ?? {}),
      },
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
