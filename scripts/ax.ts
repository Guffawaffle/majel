#!/usr/bin/env tsx
/**
 * ax.ts — Majel Ax Router (Agent-Experience Toolkit)
 *
 * Thin command router. All logic lives in scripts/ax/ modules.
 * Every command returns an AxResult — the router emits it and exits.
 *
 * Usage:
 *   npx tsx scripts/ax.ts <command> [options]
 *   npm run ax -- <command> [options]
 *
 * Commands:
 *   test       Run tests with structured failure output
 *   typecheck  TypeScript compilation check
 *   lint       ESLint with structured error output
 *   ci         Lint → typecheck → test pipeline (short-circuits on failure)
 *   affected   Run only tests affected by uncommitted changes
 *   status     Project health: git, postgres, server, build
 *   coverage   Per-file coverage sorted by lowest
 *   diff       Uncommitted changes with structured summary
 *   data:ingestion  Feed ingestion validate/load/diff wrapper
 *   feed:validate   Validate ingestion feed package
 *   feed:load       Load ingestion feed package
 *   feed:diff       Compare two ingestion feed packages
 *   effects:gates   Evaluate activation gates against artifact
 *   effects:activation:smoke Runtime activation smoke checks (local/cloud)
 *   effects:promote:db Promote effects contract artifact into DB
 *   canonical:preflight Validate canonical feed before apply
 *   canonical:postcheck Verify runtime canonical status after apply
 *   effects:coverage Full-feed effects coverage threshold check
 *   tmp        Workspace temp-file helper (stdin/content/read)
 */

import type { AxCommand } from "./ax/types.js";
import { emitResult, makeResult } from "./ax/runner.js";

import test from "./ax/test.js";
import typecheck from "./ax/typecheck.js";
import lint from "./ax/lint.js";
import ci from "./ax/ci.js";
import affected from "./ax/affected.js";
import status from "./ax/status.js";
import coverage from "./ax/coverage.js";
import diff from "./ax/diff.js";
import effectsBuild from "./ax/effects-build.js";
import effectsReviewPack from "./ax/effects-review-pack.js";
import effectsApplyDecisions from "./ax/effects-apply-decisions.js";
import effectsBudgets from "./ax/effects-budgets.js";
import dataHygiene from "./ax/data-hygiene.js";
import effectsSnapshotExport from "./ax/effects-snapshot-export.js";
import effectsSnapshotVerify from "./ax/effects-snapshot-verify.js";
import effectsCoverage from "./ax/effects-coverage.js";
import effectsGates from "./ax/effects-gates.js";
import effectsActivationSmoke from "./ax/effects-activation-smoke.js";
import dataIngestion from "./ax/data-ingestion.js";
import effectsPromoteDb from "./ax/effects-promote-db.js";
import tmp from "./ax/tmp.js";
import { runCapture } from "./ax/runner.js";

const feedValidate: AxCommand = {
  name: "feed:validate",
  description: "Validate ingestion feed package",
  run: async (args) => dataIngestion.run([...args, "--mode", "validate"]),
};

const feedLoad: AxCommand = {
  name: "feed:load",
  description: "Load ingestion feed package",
  run: async (args) => dataIngestion.run([...args, "--mode", "load"]),
};

const feedDiff: AxCommand = {
  name: "feed:diff",
  description: "Compare ingestion feed packages",
  run: async (args) => dataIngestion.run([...args, "--mode", "diff"]),
};

const canonicalPreflight: AxCommand = {
  name: "canonical:preflight",
  description: "Preflight canonical feed validation before production apply",
  run: async (args) => dataIngestion.run([...args, "--mode", "validate"]),
};

const canonicalPostcheck: AxCommand = {
  name: "canonical:postcheck",
  description: "Post-apply canonical runtime verification",
  run: async (args) => dataIngestion.run([...args, "--mode", "status"]),
};

const canonicalMigrate: AxCommand = {
  name: "canonical:migrate",
  description: "Apply canonical schema migrations",
  run: async (args) => {
    const start = Date.now();
    const exec = runCapture("tsx", ["scripts/canonical-migrate.ts", ...args], { ignoreExit: true });
    return makeResult("canonical:migrate", start, {
      command: `tsx scripts/canonical-migrate.ts ${args.join(" ")}`.trim(),
      exitCode: exec.exitCode,
      stdout: exec.stdout.trim(),
      stderr: exec.stderr.trim(),
    }, {
      success: exec.exitCode === 0,
      errors: exec.exitCode === 0 ? undefined : ["canonical migration failed"],
    });
  },
};

// ─── Command table ──────────────────────────────────────────────

const COMMANDS: Record<string, AxCommand> = {
  test:      test,
  typecheck: typecheck,
  lint:      lint,
  ci:        ci,
  affected:  affected,
  status:    status,
  coverage:  coverage,
  diff:      diff,
  "effects:build": effectsBuild,
  "effects:snapshot:export": effectsSnapshotExport,
  "effects:snapshot:verify": effectsSnapshotVerify,
  "effects:coverage": effectsCoverage,
  "effects:gates": effectsGates,
  "effects:activation:smoke": effectsActivationSmoke,
  "effects:promote:db": effectsPromoteDb,
  "effects:review-pack": effectsReviewPack,
  "effects:apply-decisions": effectsApplyDecisions,
  "effects:budgets": effectsBudgets,
  "data:hygiene": dataHygiene,
  "data:ingestion": dataIngestion,
  "feed:validate": feedValidate,
  "feed:load": feedLoad,
  "feed:diff": feedDiff,
  "canonical:preflight": canonicalPreflight,
  "canonical:postcheck": canonicalPostcheck,
  "canonical:migrate": canonicalMigrate,
  "tmp": tmp,
};

// ─── Arg parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
const positionalArgs = args.filter(a => !a.startsWith("--"));
const commandName = positionalArgs[0] === "majel" ? positionalArgs[1] : positionalArgs[0];

// ─── Router ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Help
  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    const cmds = Object.values(COMMANDS).map(c => ({ name: c.name, description: c.description }));
    const result = makeResult("help", Date.now(), {
      commands: cmds,
      usage: "npm run ax -- <command> [options]",
    });
    emitResult(result);
    return;
  }

  // Dispatch
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    const result = makeResult("unknown", Date.now(), {}, {
      success: false,
      errors: [`Unknown command: ${commandName}`],
      hints: [`Valid commands: ${Object.keys(COMMANDS).join(", ")}`],
    });
    emitResult(result);
    process.exit(1);
  }

  const result = await cmd.run(args);
  emitResult(result);
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  const result = makeResult(commandName ?? "unknown", Date.now(), {}, {
    success: false,
    errors: [err instanceof Error ? err.message : String(err)],
  });
  emitResult(result);
  process.exit(1);
});
