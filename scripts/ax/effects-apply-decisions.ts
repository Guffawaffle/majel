import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";
import {
  applyPromotionDecisions,
  buildInferenceReportPath,
  hashInferenceReport,
  readEffectsSeedFile,
  summarizeCandidateStatuses,
  type EffectsBuildReceipt,
  type InferenceReport,
  type ReviewDecisionTemplate,
  writeJsonAt,
} from "./effects-harness.js";
import { hashEffectsContractArtifact } from "../../src/server/services/effects-contract-v3.js";

const command: AxCommand = {
  name: "effects:apply-decisions",
  description: "Apply reviewed decisions with deterministic gates + promotion receipts",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const runId = getFlag(args, "run");
    const decisionsPath = getFlag(args, "decisions");

    if (!runId || !decisionsPath) {
      return makeResult("effects:apply-decisions", start, {
        runId: runId ?? null,
        decisionsPath: decisionsPath ?? null,
      }, {
        success: false,
        errors: ["Missing required flags --run and/or --decisions"],
        hints: ["Use: npm run ax -- effects:apply-decisions --run=<runId> --decisions=decisions.<runId>.json"],
      });
    }

    const receiptPath = resolve("receipts", `effects-build.${runId}.json`);
    let buildReceipt: EffectsBuildReceipt;
    try {
      buildReceipt = JSON.parse(await readFile(receiptPath, "utf-8")) as EffectsBuildReceipt;
    } catch {
      return makeResult("effects:apply-decisions", start, { runId, receiptPath }, {
        success: false,
        errors: ["Build receipt not found"],
        hints: ["Run: npm run ax -- effects:build --mode=hybrid"],
      });
    }

    if (!buildReceipt.stochastic?.inferenceReportPath) {
      return makeResult("effects:apply-decisions", start, { runId, receiptPath }, {
        success: false,
        errors: ["Run has no inference sidecar"],
        hints: ["Run: npm run ax -- effects:build --mode=hybrid"],
      });
    }

    const [artifact, report, decisionsTemplate, seed] = await Promise.all([
      readFile(buildReceipt.deterministic.contractPath, "utf-8").then((raw) => JSON.parse(raw)),
      readFile(buildReceipt.stochastic.inferenceReportPath, "utf-8").then((raw) => JSON.parse(raw) as InferenceReport),
      readFile(resolve(decisionsPath), "utf-8").then((raw) => JSON.parse(raw) as ReviewDecisionTemplate),
      readEffectsSeedFile(),
    ]);

    const promotionReceiptId = `receipt:${runId}:${Date.now()}`;
    const applied = applyPromotionDecisions({
      artifact,
      report,
      taxonomy: seed.taxonomy,
      decisions: decisionsTemplate.decisions,
      receiptId: promotionReceiptId,
    });

    const promotedArtifactHash = hashEffectsContractArtifact(applied.artifact);
    const promotedArtifactPath = resolve(
      "tmp",
      "effects",
      "runs",
      runId,
      "artifacts",
      `effects-contract.v3.promoted.${promotedArtifactHash.slice(0, 16)}.json`,
    );
    await writeJsonAt(promotedArtifactPath, applied.artifact);

    const nextReportHash = hashInferenceReport(applied.report);
    const nextInferenceReportPath = buildInferenceReportPath(runId, nextReportHash);
    await writeJsonAt(nextInferenceReportPath, applied.report);

    const gateReceiptPath = resolve("receipts", `effects-gates.${runId}.json`);
    const gateSummary = summarizeCandidateStatuses(applied.report.candidates);
    await writeJsonAt(gateReceiptPath, {
      schemaVersion: "1.0.0",
      runId,
      promotionReceiptId,
      sourceBuildReceipt: receiptPath,
      sourceInferenceReport: buildReceipt.stochastic.inferenceReportPath,
      promotedArtifactPath,
      inferenceReportPath: nextInferenceReportPath,
      gateSummary,
      outcomes: applied.gateOutcomes,
      generatedAt: new Date().toISOString(),
    });

    return makeResult("effects:apply-decisions", start, {
      runId,
      decisionsPath: resolve(decisionsPath),
      gateReceiptPath,
      promotedArtifactPath,
      inferenceReportPath: nextInferenceReportPath,
      gateSummary,
      promotedCount: applied.gateOutcomes.filter((outcome) => outcome.promoted).length,
      rejectedCount: applied.gateOutcomes.filter((outcome) => !outcome.promoted).length,
    });
  },
};

export default command;
