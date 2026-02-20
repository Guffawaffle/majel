/**
 * ax/ci.ts — Lint → typecheck → test pipeline (short-circuits on failure).
 *
 * Composes the individual lint, typecheck, and test commands — no duplicate logic.
 */

import type { AxCommand, AxResult, CiStepResult } from "./types.js";
import { makeResult } from "./runner.js";
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

    // ── Step 3: Test ──────────────────────────────────────────
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
