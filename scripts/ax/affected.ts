/**
 * ax/affected.ts — Map changed files → affected tests.
 *
 * Flags: --run (actually run the tests), --main (diff against origin/main)
 *
 * Uses a curated SOURCE_TO_TEST_MAP plus fallback heuristics to determine
 * which test files are impacted by uncommitted source changes.
 */

import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { AxCommand, AxResult, TestFailure } from "./types.js";
import { ROOT, hasFlag, runCapture, makeResult } from "./runner.js";

// ─── Source → Test mapping ──────────────────────────────────────

/**
 * Maps source files to their most likely test files using naming conventions
 * and known architectural relationships. Not a full import graph — just fast
 * heuristic mapping that covers ~95% of cases.
 */
const SOURCE_TO_TEST_MAP: Record<string, string[]> = {
  // Stores
  "src/server/stores/crew-store.ts":           ["crew-store", "fleet-tools", "crew-routes", "crew-validation"],
  "src/server/stores/receipt-store.ts":         ["receipt-store", "receipt-routes", "fleet-tools"],
  "src/server/stores/overlay-store.ts":         ["fleet-tools", "catalog"],
  "src/server/stores/reference-store.ts":       ["fleet-tools", "catalog", "cdn-ingest-pipeline"],
  "src/server/stores/target-store.ts":          ["target-store", "target-routes", "target-conflicts"],
  "src/server/stores/user-store.ts":            ["user-store", "auth", "auth-validation"],
  "src/server/stores/behavior-store.ts":        ["behavior-store"],
  "src/server/stores/invite-store.ts":          ["invite-store", "auth-validation"],
  "src/server/stores/settings.ts":              ["settings"],
  "src/server/stores/user-settings-store.ts":   ["user-settings"],
  "src/server/stores/postgres-frame-store.ts":  ["postgres-frame-store"],
  "src/server/stores/inventory-store.ts":       ["fleet-tools"],
  "src/server/stores/research-store.ts":        ["fleet-tools"],
  // Services
  "src/server/services/fleet-tools/read-tools.ts":    ["fleet-tools"],
  "src/server/services/fleet-tools/mutate-tools.ts":   ["fleet-tools"],
  "src/server/services/fleet-tools/declarations.ts":   ["fleet-tools"],
  "src/server/services/fleet-tools/index.ts":          ["fleet-tools"],
  "src/server/services/plan-solver.ts":                ["plan-solver", "fleet-tools"],
  "src/server/services/plan-briefing.ts":              ["plan-solver"],
  "src/server/services/target-conflicts.ts":           ["target-conflicts"],
  "src/server/services/gamedata-ingest.ts":            ["cdn-ingest-pipeline", "catalog"],
  "src/server/services/cdn-mappers.ts":                ["cdn-ingest-pipeline"],
  "src/server/services/game-enums.ts":                 ["game-enums"],
  "src/server/services/auth.ts":                       ["auth", "auth-validation"],
  "src/server/services/password.ts":                   ["password"],
  "src/server/services/memory.ts":                     ["memory"],
  "src/server/services/memory-middleware.ts":           ["memory-middleware"],
  "src/server/services/micro-runner.ts":               ["micro-runner"],
  // Routes
  "src/server/routes/admiral.ts":          ["admiral-routes"],
  "src/server/routes/auth.ts":             ["auth", "auth-validation"],
  "src/server/routes/catalog.ts":          ["catalog"],
  "src/server/routes/crews.ts":            ["crew-routes"],
  "src/server/routes/receipts.ts":         ["receipt-routes"],
  "src/server/routes/sessions.ts":         ["session-routes", "sessions"],
  "src/server/routes/settings.ts":         ["settings"],
  "src/server/routes/targets.ts":          ["target-routes"],
  "src/server/routes/user-settings.ts":    ["user-settings"],
  "src/server/routes/diagnostic-query.ts": ["diagnostic-query"],
  // Core
  "src/server/config.ts":       ["config"],
  "src/server/db.ts":           ["db", "dual-pool"],
  "src/server/logger.ts":       ["logger"],
  "src/server/sessions.ts":     ["sessions"],
  "src/server/safe-router.ts":  ["safe-router"],
  "src/server/envelope.ts":     ["api"],
  "src/server/index.ts":        ["app-context", "api", "middleware"],
  "src/server/app-context.ts":  ["app-context"],
  "src/server/ip-allowlist.ts": ["middleware"],
  "src/server/rate-limit.ts":   ["middleware"],
  // Types
  "src/server/types/crew-types.ts": ["crew-store", "crew-validation", "fleet-tools"],
};

/** Fallback: try to match by filename convention */
function guessTestFiles(srcFile: string): string[] {
  const basename = srcFile.replace(/^.*\//, "").replace(/\.ts$/, "");
  const candidates = [basename];
  if (basename.endsWith("-store")) {
    const routeName = basename.replace("-store", "-routes");
    candidates.push(routeName);
  }
  return candidates;
}

// ─── Command ────────────────────────────────────────────────────

const command: AxCommand = {
  name: "affected",
  description: "Map changed files → affected tests (--run, --main)",

  async run(args): Promise<AxResult> {
    const start = Date.now();

    const base = hasFlag(args, "main") ? "origin/main" : "HEAD";
    const diffArgs = base === "HEAD"
      ? ["diff", "--name-only", "--no-color", "HEAD"]
      : ["diff", "--name-only", "--no-color", base];
    const stagedArgs = ["diff", "--cached", "--name-only", "--no-color"];

    // Get both unstaged and staged changes
    const unstaged = runCapture("git", diffArgs, { ignoreExit: true });
    const staged = runCapture("git", stagedArgs, { ignoreExit: true });
    const untracked = runCapture("git", ["ls-files", "--others", "--exclude-standard"], { ignoreExit: true });

    const allChanged = new Set<string>();
    for (const line of [...unstaged.stdout.split("\n"), ...staged.stdout.split("\n"), ...untracked.stdout.split("\n")]) {
      const trimmed = line.trim();
      if (trimmed) allChanged.add(trimmed);
    }

    // Separate test files from source files
    const changedTestFiles = new Set<string>();
    const changedSrcFiles = new Set<string>();
    for (const file of allChanged) {
      if (file.startsWith("test/") && file.endsWith(".test.ts")) {
        changedTestFiles.add(file);
      } else if (file.startsWith("src/") && file.endsWith(".ts")) {
        changedSrcFiles.add(file);
      }
    }

    // Map source files → test files
    const affectedTests = new Set<string>();

    // Changed test files are always included
    for (const tf of changedTestFiles) affectedTests.add(tf);

    // Map source changes to test files
    for (const srcFile of changedSrcFiles) {
      const mapped = SOURCE_TO_TEST_MAP[srcFile];
      if (mapped) {
        for (const testName of mapped) affectedTests.add(`test/${testName}.test.ts`);
      } else {
        const guesses = guessTestFiles(srcFile);
        for (const g of guesses) {
          const testPath = `test/${g}.test.ts`;
          if (existsSync(resolve(ROOT, testPath))) affectedTests.add(testPath);
        }
      }
    }

    // Config changes → recommend full run
    const configFiles = ["package.json", "tsconfig.json", "vitest.config.ts", "eslint.config.mjs"];
    const configChanged = configFiles.some(f => allChanged.has(f));

    const sortedTests = [...affectedTests].sort();

    // Nothing affected
    if (sortedTests.length === 0 && !configChanged) {
      return makeResult("affected", start, {
        changedFiles: allChanged.size,
        changedSrcFiles: changedSrcFiles.size,
        changedTestFiles: changedTestFiles.size,
        affectedTestFiles: 0,
        configChanged: false,
        recommendation: "no-tests-needed",
      });
    }

    // Config changed → full run
    if (configChanged) {
      return makeResult("affected", start, {
        changedFiles: allChanged.size,
        configChanged: true,
        configFilesChanged: configFiles.filter(f => allChanged.has(f)),
        recommendation: "run-all",
        hint: "Config file changed — full test suite recommended",
      });
    }

    // Actually run the tests if --run
    if (hasFlag(args, "run")) {
      const pg = runCapture("docker", ["exec", "majel-postgres-1", "pg_isready", "-U", "majel", "-q"], { ignoreExit: true });
      if (pg.exitCode !== 0) {
        return makeResult("affected", start, {}, {
          success: false,
          errors: ["PostgreSQL not running"],
          hints: ["Run: npm run pg:start"],
        });
      }

      const vitestArgs = ["vitest", "run", "--reporter=json", ...sortedTests];
      const result = runCapture("npx", vitestArgs, { ignoreExit: true });

      let passed = 0;
      let failed = 0;
      let files = 0;
      const failures: TestFailure[] = [];
      try {
        const json = JSON.parse(result.stdout);
        passed = Number(json.numPassedTests ?? 0);
        failed = Number(json.numFailedTests ?? 0);
        const testResults = json.testResults as Array<Record<string, unknown>> | undefined;
        files = testResults?.length ?? 0;
        if (testResults) {
          for (const file of testResults) {
            const filePath = relative(ROOT, String(file.name ?? ""));
            const assertions = file.assertionResults as Array<Record<string, unknown>> | undefined;
            if (assertions) {
              for (const a of assertions) {
                if (String(a.status ?? "") === "failed") {
                  failures.push({
                    file: filePath,
                    test: String(a.fullName ?? a.title ?? "unknown"),
                    error: ((a.failureMessages as string[]) ?? []).join("\n").slice(0, 500),
                  });
                }
              }
            }
          }
        }
      } catch { /* fallback */ }

      return makeResult("affected", start, {
        changedFiles: allChanged.size,
        affectedTestFiles: sortedTests.length,
        testFiles: sortedTests,
        ran: true,
        files,
        passed,
        failed,
        failures: failures.length > 0 ? failures : undefined,
      }, {
        success: failed === 0,
        errors: failed > 0 ? [`${failed} test(s) failed`] : undefined,
      });
    }

    // Dry-run mode (default): report what would be tested
    return makeResult("affected", start, {
      changedFiles: allChanged.size,
      changedSrcFiles: changedSrcFiles.size,
      changedTestFiles: changedTestFiles.size,
      affectedTestFiles: sortedTests.length,
      testFiles: sortedTests,
      recommendation: "run-affected",
      runCommand: "npm run ax -- affected --run",
    });
  },
};

export default command;
