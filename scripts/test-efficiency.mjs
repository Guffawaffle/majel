#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const outputDir = path.join(cwd, "tmp");
const outputFile = path.join(outputDir, "vitest-efficiency.json");
const summaryFile = path.join(outputDir, "test-efficiency-summary.json");
const topFilesCount = Number(process.env.TEST_EFFICIENCY_TOP_FILES ?? 10);
const topTestsCount = Number(process.env.TEST_EFFICIENCY_TOP_TESTS ?? 25);
const jsonSummaryMode = process.env.TEST_EFFICIENCY_JSON === "1";

function run(command, args, { silent = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: silent ? "pipe" : "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    if (silent) {
      if (result.stdout?.length) process.stdout.write(result.stdout);
      if (result.stderr?.length) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
}

if (!process.env.CI) {
  run("npm", ["run", "pg:check", "--silent"], { silent: jsonSummaryMode });
}

fs.mkdirSync(outputDir, { recursive: true });

const start = Date.now();
run("npx", [
  "vitest",
  "run",
  "--reporter=json",
  `--outputFile=${outputFile}`,
], { silent: jsonSummaryMode });
const wallMs = Date.now() - start;

const report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
const testResults = report.testResults ?? [];

const fileRows = testResults
  .map((suite) => ({
    name: path.relative(cwd, suite.name),
    tests: (suite.assertionResults ?? []).length,
    durationMs: (suite.endTime ?? 0) - (suite.startTime ?? 0),
  }))
  .sort((a, b) => b.durationMs - a.durationMs);

const testRows = testResults
  .flatMap((suite) =>
    (suite.assertionResults ?? []).map((test) => ({
      file: path.relative(cwd, suite.name),
      fullName: test.fullName,
      durationMs: test.duration ?? 0,
      status: test.status,
    })),
  )
  .sort((a, b) => b.durationMs - a.durationMs);

const summary = {
  wallMs,
  wallSeconds: Number((wallMs / 1000).toFixed(2)),
  suites: {
    total: report.numTotalTestSuites,
    passed: report.numPassedTestSuites,
    failed: report.numFailedTestSuites,
    pending: report.numPendingTestSuites,
  },
  tests: {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
  },
  files: fileRows,
  topFiles: fileRows.slice(0, topFilesCount),
  topTests: testRows.slice(0, topTestsCount),
  vitestJsonPath: path.relative(cwd, outputFile),
};

fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

if (jsonSummaryMode) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(0);
}

console.log("\n=== Test Efficiency Report ===");
console.log(`Wall time: ${(wallMs / 1000).toFixed(2)}s`);
console.log(
  `Suites: ${report.numPassedTestSuites}/${report.numTotalTestSuites} passed | Tests: ${report.numPassedTests}/${report.numTotalTests} passed`,
);
console.log(`JSON: ${path.relative(cwd, outputFile)}`);
console.log(`Summary: ${path.relative(cwd, summaryFile)}`);

console.log(`\nTop ${topFilesCount} slowest files`);
for (const row of fileRows.slice(0, topFilesCount)) {
  console.log(
    `${row.durationMs.toFixed(0).padStart(7)} ms  ${String(row.tests).padStart(4)} tests  ${row.name}`,
  );
}

console.log(`\nTop ${topTestsCount} slowest tests`);
for (const row of testRows.slice(0, topTestsCount)) {
  console.log(
    `${row.durationMs.toFixed(0).padStart(7)} ms  ${row.file} :: ${row.fullName}`,
  );
}
