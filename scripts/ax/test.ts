/**
 * ax/test.ts — Run tests with structured failure output.
 *
 * Flags: --file=X (filter by filename), --grep=X (filter by test name)
 */

import { relative } from "node:path";
import type { AxCommand, AxResult, TestFailure, TestResult } from "./types.js";
import { ROOT, getFlag, runCapture, makeResult } from "./runner.js";

// ─── Vitest parsers ─────────────────────────────────────────────

function parseVitestJson(json: Record<string, unknown>): TestResult {
  const testResults = json.testResults as Array<Record<string, unknown>> | undefined;
  const failures: TestFailure[] = [];

  const passed = Number(json.numPassedTests ?? 0);
  const failed = Number(json.numFailedTests ?? 0);
  const skipped = Number(json.numPendingTests ?? 0) + Number(json.numTodoTests ?? 0);
  const files = testResults?.length ?? 0;

  if (testResults) {
    for (const file of testResults) {
      const filePath = relative(ROOT, String(file.name ?? ""));
      const assertions = file.assertionResults as Array<Record<string, unknown>> | undefined;
      if (assertions) {
        for (const a of assertions) {
          if (String(a.status ?? "") === "failed") {
            const msgs = (a.failureMessages as string[]) ?? [];
            failures.push({
              file: filePath,
              test: String(a.fullName ?? a.title ?? "unknown"),
              error: msgs.join("\n").slice(0, 500),
            });
          }
        }
      }
    }
  }

  const startMs = Number(json.startTime ?? 0);
  let endMs = startMs;
  if (testResults) {
    for (const tr of testResults) {
      const trEnd = Number(tr.endTime ?? 0);
      if (trEnd > endMs) endMs = trEnd;
    }
  }
  const durationMs = endMs > startMs ? endMs - startMs : 0;

  return {
    files,
    passed,
    failed,
    skipped,
    duration: durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : "unknown",
    failures,
  };
}

function parseVitestText(text: string): TestResult {
  const fileMatch = text.match(/Test Files\s+(\d+)\s+(?:passed|failed)/);
  const passMatch = text.match(/(\d+)\s+passed/);
  const failMatch = text.match(/(\d+)\s+failed/);
  const skipMatch = text.match(/(\d+)\s+skipped/);
  const durMatch = text.match(/Duration\s+([\d.]+s)/);

  const failures: TestFailure[] = [];
  const failBlocks = text.split(/(?=FAIL\s)/);
  for (const block of failBlocks) {
    if (!block.startsWith("FAIL")) continue;
    const headerMatch = block.match(/FAIL\s+(.+?)(?:\s+>|$)/);
    const file = headerMatch?.[1]?.trim() ?? "unknown";
    const lines = block.split("\n").slice(1);
    const testName = lines.find(l => l.trim().startsWith("×") || l.trim().startsWith("✕"))
      ?.trim().replace(/^[×✕]\s*/, "") ?? "unknown";
    const errorLines = lines.filter(l =>
      l.includes("AssertionError") || l.includes("Error:") ||
      l.includes("expected") || l.includes("received"),
    );
    failures.push({
      file: relative(ROOT, file),
      test: testName,
      error: errorLines.slice(0, 4).join("\n").slice(0, 500),
    });
  }

  return {
    files: Number(fileMatch?.[1] ?? 0),
    passed: Number(passMatch?.[1] ?? 0),
    failed: Number(failMatch?.[1] ?? 0),
    skipped: Number(skipMatch?.[1] ?? 0),
    duration: durMatch?.[1] ?? "unknown",
    failures,
  };
}

// ─── Command ────────────────────────────────────────────────────

const command: AxCommand = {
  name: "test",
  description: "Run tests — structured failure output (--file=X, --grep=X)",

  async run(args): Promise<AxResult> {
    const start = Date.now();

    // Check postgres
    const pg = runCapture("docker", ["exec", "majel-postgres-1", "pg_isready", "-U", "majel", "-q"], { ignoreExit: true });
    if (pg.exitCode !== 0) {
      return makeResult("test", start, {}, {
        success: false,
        errors: ["PostgreSQL not running — tests require it"],
        hints: ["Run: npm run pg:start"],
      });
    }

    // Build vitest args
    const vitestArgs = ["vitest", "run", "--reporter=json"];

    const fileFilter = getFlag(args, "file");
    if (fileFilter) {
      const { stdout: fileList } = runCapture("find", ["test", "-name", "*.test.ts", "-type", "f"]);
      const files = fileList.trim().split("\n").filter(f => f.includes(fileFilter));
      if (files.length === 0) {
        return makeResult("test", start, { filter: fileFilter }, {
          success: false,
          errors: [`No test files matching "${fileFilter}"`],
        });
      }
      vitestArgs.push(...files);
    }

    const grepFilter = getFlag(args, "grep");
    if (grepFilter) {
      vitestArgs.push("--testNamePattern", grepFilter);
    }

    const result = runCapture("npx", vitestArgs, { ignoreExit: true });

    let testResult: TestResult;
    try {
      const json = JSON.parse(result.stdout);
      testResult = parseVitestJson(json);
    } catch {
      testResult = parseVitestText(result.stdout + "\n" + result.stderr);
    }

    const data: Record<string, unknown> = {
      files: testResult.files,
      passed: testResult.passed,
      failed: testResult.failed,
      skipped: testResult.skipped,
      duration: testResult.duration,
    };
    if (fileFilter) data.fileFilter = fileFilter;
    if (grepFilter) data.grepFilter = grepFilter;
    if (testResult.failures.length > 0) data.failures = testResult.failures;

    return makeResult("test", start, data, {
      success: testResult.failed === 0,
      errors: testResult.failed > 0 ? [`${testResult.failed} test(s) failed`] : undefined,
      hints: testResult.failed > 0
        ? ["Review failures above", "Run with --file=<name> to isolate"]
        : undefined,
    });
  },
};

export default command;
