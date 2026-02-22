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
  "effects:review-pack": effectsReviewPack,
  "effects:apply-decisions": effectsApplyDecisions,
  "effects:budgets": effectsBudgets,
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
