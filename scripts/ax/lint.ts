/**
 * ax/lint.ts — ESLint + CSP check with structured errors.
 *
 * Flags: --fix (auto-fix lint errors)
 */

import { resolve, relative } from "node:path";
import type { AxCommand, AxResult, LintError } from "./types.js";
import { ROOT, hasFlag, runCapture, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "lint",
  description: "ESLint + CSP check with structured errors (--fix)",

  async run(args): Promise<AxResult> {
    const start = Date.now();

    const eslintArgs = ["eslint", "--format=json", "."];
    if (hasFlag(args, "fix")) eslintArgs.splice(1, 0, "--fix");

    const result = runCapture("npx", eslintArgs, { ignoreExit: true });

    const lintErrors: LintError[] = [];
    let errorCount = 0;
    let warningCount = 0;

    try {
      const json = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      for (const file of json) {
        const filePath = relative(ROOT, String(file.filePath ?? ""));
        const messages = file.messages as Array<Record<string, unknown>> | undefined;
        if (messages) {
          for (const m of messages) {
            const severity = Number(m.severity) === 2 ? "error" as const : "warning" as const;
            if (severity === "error") errorCount++;
            else warningCount++;
            lintErrors.push({
              file: filePath,
              line: Number(m.line ?? 0),
              col: Number(m.column ?? 0),
              rule: String(m.ruleId ?? "unknown"),
              severity,
              message: String(m.message ?? ""),
            });
          }
        }
      }
    } catch {
      if (result.exitCode !== 0) {
        lintErrors.push({
          file: "unknown",
          line: 0,
          col: 0,
          rule: "parse-error",
          severity: "error",
          message: result.stderr.slice(0, 500) || result.stdout.slice(0, 500),
        });
        errorCount = 1;
      }
    }

    // CSP hash check
    const csp = runCapture("node", [resolve(ROOT, "scripts/check-csp-hash.mjs")], { ignoreExit: true });
    const cspOk = csp.exitCode === 0;
    if (!cspOk) {
      errorCount++;
      lintErrors.push({
        file: "src/server/middleware.ts",
        line: 0,
        col: 0,
        rule: "csp-hash",
        severity: "error",
        message: "CSP hash mismatch — run: npm run fix:csp",
      });
    }

    return makeResult("lint", start, {
      errorCount,
      warningCount,
      cspOk,
      fixApplied: hasFlag(args, "fix"),
      errors: lintErrors.filter(e => e.severity === "error").slice(0, 30),
      warnings: lintErrors.filter(e => e.severity === "warning").slice(0, 20),
    }, {
      success: errorCount === 0,
      errors: errorCount > 0 ? [`${errorCount} lint error(s)`] : undefined,
      hints: errorCount > 0
        ? ["Run with --fix to auto-fix", !cspOk ? "Run: npm run fix:csp" : undefined].filter(Boolean) as string[]
        : undefined,
    });
  },
};

export default command;
