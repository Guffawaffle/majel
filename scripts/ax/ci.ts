/**
 * ax/ci.ts — Lint → typecheck → test pipeline (short-circuits on failure).
 *
 * Composes the individual lint, typecheck, and test commands — no duplicate logic.
 */

import type { AxCommand, AxResult, CiStepResult } from "./types.js";
import { getFlag, makeResult, runCapture } from "./runner.js";
import lint from "./lint.js";
import typecheck from "./typecheck.js";
import test from "./test.js";
import effectsBudgets from "./effects-budgets.js";
import dataHygiene from "./data-hygiene.js";

const command: AxCommand = {
  name: "ci",
  description: "Lint → typecheck → test pipeline (short-circuits on failure)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const steps: CiStepResult[] = [];

    // Strip --fix for ci — never auto-fix in pipeline
    const ciArgs = args.filter(a => a !== "--fix");
    const ingestionFeed = getFlag(ciArgs, "ingestion-feed");
    const ingestionFeedsRoot = getFlag(ciArgs, "ingestion-feeds-root");
    const effectsGateInput = getFlag(ciArgs, "effects-gates-input");
    const effectsGateProfile = getFlag(ciArgs, "effects-gates-profile");
    const effectsGateDatasetKind = getFlag(ciArgs, "effects-gates-dataset-kind") ?? "hybrid";
    const effectsGateDbUrl = getFlag(ciArgs, "effects-gates-db-url");

    if (effectsGateDbUrl) {
      return makeResult("ci", start, { steps }, {
        success: false,
        errors: ["--effects-gates-db-url is disabled for security; use DATABASE_URL environment variable"],
        hints: ["Set DATABASE_URL in the CI environment/session before running ax ci"],
      });
    }

    // ── Step 1: Lint ──────────────────────────────────────────
    const lintResult = await lint.run(ciArgs);
    steps.push({
      step: "lint",
      success: lintResult.success,
      durationMs: lintResult.durationMs,
      data: {
        errors: lintResult.data.errorCount,
        warnings: lintResult.data.warningCount,
        cspOk: lintResult.data.cspOk,
      },
    });

    if (!lintResult.success) {
      return makeResult("ci", start, { steps, stoppedAt: "lint" }, {
        success: false,
        errors: [`lint failed with ${lintResult.data.errorCount} error(s)`],
        hints: ["Run: npm run ax -- lint"],
      });
    }

    // ── Step 2: Data hygiene ──────────────────────────────────
    const hygieneResult = await dataHygiene.run([...ciArgs, "--strict"]);
    steps.push({
      step: "data:hygiene",
      success: hygieneResult.success,
      durationMs: hygieneResult.durationMs,
      data: {
        strict: hygieneResult.data.strict,
        scannedFiles: hygieneResult.data.scannedFiles,
        violations: Array.isArray(hygieneResult.data.violations) ? hygieneResult.data.violations.length : 0,
        warnings: Array.isArray(hygieneResult.data.warnings) ? hygieneResult.data.warnings.length : 0,
      },
    });

    if (!hygieneResult.success) {
      return makeResult("ci", start, { steps, stoppedAt: "data:hygiene" }, {
        success: false,
        errors: hygieneResult.errors ?? ["data hygiene checks failed"],
        hints: ["Run: npm run ax -- data:hygiene"],
      });
    }

    // ── Optional Step: Feed ingestion validate gate ───────────
    if (ingestionFeed) {
      const ingestionStart = Date.now();
      const ingestionCmd = ["scripts/data-ingestion.ts", "validate", "--feed", ingestionFeed];
      if (ingestionFeedsRoot) ingestionCmd.push("--feeds-root", ingestionFeedsRoot);
      const ingestionResult = runCapture("tsx", ingestionCmd, { ignoreExit: true });
      const ingestionDuration = Date.now() - ingestionStart;

      steps.push({
        step: "data:ingestion:validate",
        success: ingestionResult.exitCode === 0,
        durationMs: ingestionDuration,
        data: {
          feed: ingestionFeed,
          feedsRoot: ingestionFeedsRoot ?? "data/feeds",
          exitCode: ingestionResult.exitCode,
        },
      });

      if (ingestionResult.exitCode !== 0) {
        return makeResult("ci", start, { steps, stoppedAt: "data:ingestion:validate" }, {
          success: false,
          errors: ["data ingestion validation failed"],
          hints: ["Run: npm run ax -- data:ingestion --mode=validate --feed <feedId-or-path>"],
        });
      }
    }

    // ── Step 3: Typecheck ─────────────────────────────────────
    const typecheckResult = await typecheck.run(ciArgs);
    steps.push({
      step: "typecheck",
      success: typecheckResult.success,
      durationMs: typecheckResult.durationMs,
      data: { errors: typecheckResult.data.errorCount },
    });

    if (!typecheckResult.success) {
      return makeResult("ci", start, { steps, stoppedAt: "typecheck" }, {
        success: false,
        errors: [`typecheck failed with ${typecheckResult.data.errorCount} error(s)`],
        hints: ["Run: npm run ax -- typecheck"],
      });
    }

    // ── Step 4: Effects dry-run ───────────────────────────────
    const effectsDryRunStart = Date.now();
    const effectsDryRun = runCapture("npm", ["run", "effects:dry-run"], { ignoreExit: true });
    const effectsDryRunDuration = Date.now() - effectsDryRunStart;
    steps.push({
      step: "effects:dry-run",
      success: effectsDryRun.exitCode === 0,
      durationMs: effectsDryRunDuration,
      data: {
        exitCode: effectsDryRun.exitCode,
      },
    });

    if (effectsDryRun.exitCode !== 0) {
      return makeResult("ci", start, { steps, stoppedAt: "effects:dry-run" }, {
        success: false,
        errors: ["effects dry-run failed"],
        hints: ["Run: npm run effects:dry-run"],
      });
    }

    // ── Step 5: Effects budgets ───────────────────────────────
    const budgetsResult = await effectsBudgets.run(ciArgs);
    steps.push({
      step: "effects:budgets",
      success: budgetsResult.success,
      durationMs: budgetsResult.durationMs,
      data: {
        deterministic: budgetsResult.data.deterministic,
        inferredPromotedRatio: budgetsResult.data.inferredPromotedRatio,
        lowConfidenceCandidateCount: budgetsResult.data.lowConfidenceCandidateCount,
        mappedCoveragePercent: budgetsResult.data.mappedCoveragePercent,
        warnings: budgetsResult.data.warnings,
      },
    });

    if (!budgetsResult.success) {
      return makeResult("ci", start, { steps, stoppedAt: "effects:budgets" }, {
        success: false,
        errors: budgetsResult.errors ?? ["effects budget gate failed"],
        hints: ["Run: npm run ax -- effects:budgets"],
      });
    }

    // ── Optional Step: Effects policy gates ─────────────────
    if (effectsGateInput) {
      const effectsGateStart = Date.now();
      const gateCmd = [
        "scripts/ax.ts",
        "effects:gates",
        "--input",
        effectsGateInput,
        "--dataset-kind",
        effectsGateDatasetKind,
      ];
      if (effectsGateProfile) gateCmd.push("--profile", effectsGateProfile);

      const gateResult = runCapture("tsx", gateCmd, { ignoreExit: true });
      const effectsGateDuration = Date.now() - effectsGateStart;

      steps.push({
        step: "effects:gates",
        success: gateResult.exitCode === 0,
        durationMs: effectsGateDuration,
        data: {
          input: effectsGateInput,
          profile: effectsGateProfile ?? "default",
          datasetKind: effectsGateDatasetKind,
          exitCode: gateResult.exitCode,
        },
      });

      if (gateResult.exitCode !== 0) {
        return makeResult("ci", start, { steps, stoppedAt: "effects:gates" }, {
          success: false,
          errors: ["effects policy gate failed"],
          hints: ["Run: npm run ax -- effects:gates --input <contractPath> [--profile local_dev|cloud_activation] [--dataset-kind deterministic|hybrid]"],
        });
      }
    }

    // ── Step 6: Test ──────────────────────────────────────────
    const testResult = await test.run(ciArgs);
    steps.push({
      step: "test",
      success: testResult.success,
      durationMs: testResult.durationMs,
      data: {
        files: testResult.data.files,
        passed: testResult.data.passed,
        failed: testResult.data.failed,
        skipped: testResult.data.skipped,
      },
    });

    if (!testResult.success) {
      return makeResult("ci", start, { steps, stoppedAt: "test" }, {
        success: false,
        errors: ["backend tests failed"],
        hints: ["Run: npm run ax -- test"],
      });
    }

    // ── Step 7: Web tests ─────────────────────────────────────
    const webTestStart = Date.now();
    const webTest = runCapture("npm", ["--prefix", "web", "run", "test"], { ignoreExit: true });
    const webTestDuration = Date.now() - webTestStart;
    steps.push({
      step: "test:web",
      success: webTest.exitCode === 0,
      durationMs: webTestDuration,
      data: {
        exitCode: webTest.exitCode,
      },
    });

    if (webTest.exitCode !== 0) {
      return makeResult("ci", start, { steps, stoppedAt: "test:web" }, {
        success: false,
        errors: ["web tests failed"],
        hints: ["Run: npm --prefix web run test"],
      });
    }

    const allPassed = steps.every(s => s.success);

    return makeResult("ci", start, { steps, allPassed }, {
      success: allPassed,
      errors: allPassed ? undefined : ["CI pipeline failed"],
      hints: allPassed
        ? undefined
        : steps.filter(s => !s.success).map(s => `Run: npm run ax -- ${s.step}`),
    });
  },
};

export default command;
