/**
 * ax/ci.ts — Lint → typecheck → test pipeline (short-circuits on failure).
 *
 * Composes the individual lint, typecheck, and test commands — no duplicate logic.
 */

import type { AxCommand, AxResult, CiStepResult } from "./types.js";
import { makeResult, runCapture } from "./runner.js";
import lint from "./lint.js";
import typecheck from "./typecheck.js";
import test from "./test.js";

const command: AxCommand = {
  name: "ci",
  description: "Lint → typecheck → test pipeline (short-circuits on failure)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const steps: CiStepResult[] = [];

    // Strip --fix for ci — never auto-fix in pipeline
    const ciArgs = args.filter(a => a !== "--fix");

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

    // ── Step 2: Typecheck ─────────────────────────────────────
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

    // ── Step 3: Effects dry-run ───────────────────────────────
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

    // ── Step 4: Test ──────────────────────────────────────────
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

    // ── Step 5: Web tests ─────────────────────────────────────
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
