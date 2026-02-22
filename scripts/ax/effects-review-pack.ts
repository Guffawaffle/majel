import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { getFlag, makeResult } from "./runner.js";
import {
  buildDecisionTemplate,
  buildReviewPack,
  buildReviewPackMarkdown,
  type EffectsBuildReceipt,
  type InferenceReport,
  writeJsonAt,
} from "./effects-harness.js";

const command: AxCommand = {
  name: "effects:review-pack",
  description: "Generate AI review-pack from build run (--run=<runId>)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const runId = getFlag(args, "run");

    if (!runId) {
      return makeResult("effects:review-pack", start, {}, {
        success: false,
        errors: ["Missing required --run"],
        hints: ["Use: npm run ax -- effects:review-pack --run=<runId>"],
      });
    }

    const receiptPath = resolve("receipts", `effects-build.${runId}.json`);
    let receipt: EffectsBuildReceipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf-8")) as EffectsBuildReceipt;
    } catch {
      return makeResult("effects:review-pack", start, { runId, receiptPath }, {
        success: false,
        errors: ["Build receipt not found"],
        hints: ["Run: npm run ax -- effects:build --mode=hybrid"],
      });
    }

    if (!receipt.stochastic?.inferenceReportPath) {
      return makeResult("effects:review-pack", start, { runId, receiptPath }, {
        success: false,
        errors: ["Run has no stochastic inference report"],
        hints: ["Run: npm run ax -- effects:build --mode=hybrid"],
      });
    }

    const report = JSON.parse(await readFile(receipt.stochastic.inferenceReportPath, "utf-8")) as InferenceReport;
    const pack = buildReviewPack(report, receipt.snapshotVersion, receipt.generatedAt);
    const decisionTemplate = buildDecisionTemplate(pack);

    const reviewJsonPath = resolve("review", `review-pack.${runId}.json`);
    const reviewMdPath = resolve("review", `review-pack.${runId}.md`);
    const decisionTemplatePath = resolve("review", `decisions.template.${runId}.json`);
    await writeJsonAt(reviewJsonPath, pack);
    await writeFile(reviewMdPath, buildReviewPackMarkdown(pack), "utf-8");
    await writeJsonAt(decisionTemplatePath, decisionTemplate);

    const reviewReceiptPath = resolve("receipts", `effects-review-pack.${runId}.json`);
    await writeJsonAt(reviewReceiptPath, {
      schemaVersion: "1.0.0",
      runId,
      artifactBase: receipt.artifactBase,
      sourceReceiptPath: receiptPath,
      reviewJsonPath,
      reviewMdPath,
      decisionTemplatePath,
      candidateCount: pack.candidateCount,
      generatedAt: new Date().toISOString(),
    });

    return makeResult("effects:review-pack", start, {
      runId,
      artifactBase: receipt.artifactBase,
      reviewJsonPath,
      reviewMdPath,
      decisionTemplatePath,
      reviewReceiptPath,
      candidateCount: pack.candidateCount,
    });
  },
};

export default command;
