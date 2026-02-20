/**
 * ax/coverage.ts — Per-file test coverage sorted by lowest.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { AxCommand, AxResult, CoverageFile } from "./types.js";
import { ROOT, runCapture, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "coverage",
  description: "Per-file test coverage sorted by lowest",

  async run(_args): Promise<AxResult> {
    const start = Date.now();

    // Check postgres first
    const pg = runCapture("docker", ["exec", "majel-postgres-1", "pg_isready", "-U", "majel", "-q"], { ignoreExit: true });
    if (pg.exitCode !== 0) {
      return makeResult("coverage", start, {}, {
        success: false,
        errors: ["PostgreSQL not running"],
        hints: ["Run: npm run pg:start"],
      });
    }

    // Run vitest with coverage
    const result = runCapture("npx", ["vitest", "run", "--coverage", "--reporter=verbose"], { ignoreExit: true });
    const testsPassed = result.exitCode === 0;

    // Parse coverage JSON if it exists
    const coverageJsonPath = resolve(ROOT, "coverage", "coverage-summary.json");
    const files: CoverageFile[] = [];
    let totals: CoverageFile | null = null;

    if (existsSync(coverageJsonPath)) {
      try {
        const coverageData = JSON.parse(readFileSync(coverageJsonPath, "utf-8")) as Record<string, Record<string, { pct: number }>>;
        for (const [filePath, data] of Object.entries(coverageData)) {
          const entry: CoverageFile = {
            file: filePath === "total" ? "TOTAL" : relative(ROOT, filePath),
            lines: data.lines?.pct ?? 0,
            branches: data.branches?.pct ?? 0,
            functions: data.functions?.pct ?? 0,
            statements: data.statements?.pct ?? 0,
          };
          if (filePath === "total") {
            totals = entry;
          } else {
            files.push(entry);
          }
        }
      } catch { /* ignore parse errors */ }
    }

    // Sort by lowest line coverage
    files.sort((a, b) => a.lines - b.lines);

    return makeResult("coverage", start, {
      testsPassed,
      totals,
      fileCount: files.length,
      lowest: files.slice(0, 15),
      highest: files.slice(-5).reverse(),
    }, {
      success: testsPassed,
      errors: !testsPassed ? ["Some tests failed during coverage run"] : undefined,
      hints: files.length > 0 && files[0].lines < 50
        ? [`Lowest coverage: ${files[0].file} (${files[0].lines}% lines)`]
        : undefined,
    });
  },
};

export default command;
