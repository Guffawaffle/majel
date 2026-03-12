#!/usr/bin/env tsx
/**
 * cloud.ts — Majel Cloud Operations CLI
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Unified CLI for all cloud deploy/ops commands.
 * Supports --ax flag for AI-agent-friendly structured JSON output.
 * Auth-tiered: read-only commands need gcloud, mutating commands need .cloud-auth token.
 *
 * Usage:
 *   npx tsx scripts/cloud.ts <command> [--ax] [--flags]
 *
 * Tiers:
 *   open   — help, init (no auth needed)
 *   read   — status, health, logs, env, secrets, sql, revisions, diff, metrics, costs, warm
 *   write  — deploy, build, push, rollback, scale, canary, promote, ssh (requires .cloud-auth)
 *
 * Setup:
 *   npm run cloud:init              # Generate .cloud-auth token (one-time)
 *   npm run cloud:deploy            # Full build → push → deploy pipeline
 *   npm run cloud:status -- --ax    # AI-agent structured JSON
 *
 * @see docs/ADR-018-cloud-deployment.md
 */

import {
  type AuthTier,
  type CommandDef,
  AX_MODE,
  IMAGE,
  PROJECT,
  REGION,
  SERVICE,
  axOutput,
  ensureGcloud,
  humanError,
  humanLog,
  setAxMode,
} from "./lib/cloud-cli.js";
import { cmdInit, requireWriteAuth } from "./lib/cloud-auth.js";
import { cmdBuild, cmdDeploy, cmdPush } from "./lib/cloud-deploy.js";
import { cmdLogs, cmdTriage, cmdTriageBundle } from "./lib/cloud-logs.js";
import {
  cmdDbAuth,
  cmdDbCount,
  cmdDbResetCanonical,
  cmdDbSeed,
  cmdDbSeedAll,
  cmdDbSeedCanonical,
  cmdDbSeedEffects,
  cmdDbWipe,
  cmdSql,
} from "./lib/cloud-sql.js";
import {
  cmdCanary,
  cmdPromote,
  cmdRevisions,
  cmdRollback,
  cmdScale,
} from "./lib/cloud-traffic.js";
import {
  cmdCosts,
  cmdDiff,
  cmdEnv,
  cmdHealth,
  cmdMetrics,
  cmdSecrets,
  cmdSsh,
  cmdStatus,
  cmdWarm,
} from "./lib/cloud-monitoring.js";

// ─── Help ───────────────────────────────────────────────────────

async function cmdHelp(): Promise<void> {
  const start = Date.now();

  if (AX_MODE) {
    const commands = Object.entries(COMMANDS)
      .filter(([name]) => name !== "help")
      .map(([name, def]) => ({
        name,
        alias: def.alias,
        tier: def.tier,
        description: def.description,
        args: def.args ?? [],
      }));

    axOutput("help", start, {
      service: SERVICE,
      project: PROJECT,
      region: REGION,
      image: IMAGE,
      tiers: {
        open: "No authentication required",
        read: "Requires gcloud authentication (read-only)",
        write: "Requires .cloud-auth token (mutating operations)",
      },
      commands,
      flags: [
        { name: "--ax", description: "Output structured JSON for AI agent consumption" },
        { name: "--json", description: "Alias for --ax" },
      ],
      usage: "npm run cloud:<command> [-- --ax]",
      authSetup: "npm run cloud:init",
    });
  } else {
    const tier = (t: AuthTier) => t === "open" ? "     " : t === "read" ? " \ud83d\udc41\ufe0f  " : " \ud83d\udd12 ";

    humanLog("\u2601\ufe0f  Majel Cloud Operations CLI");
    humanLog("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    humanLog(`  Project: ${PROJECT}  |  Region: ${REGION}  |  Service: ${SERVICE}\n`);
    humanLog("  \ud83d\udc41\ufe0f  = read-only (gcloud auth)   \ud83d\udd12 = write (requires .cloud-auth)\n");

    const groups: Record<AuthTier, Array<[string, CommandDef]>> = { open: [], read: [], write: [] };
    for (const [name, def] of Object.entries(COMMANDS)) {
      if (name === "help") continue;
      groups[def.tier].push([name, def]);
    }

    if (groups.open.length) {
      humanLog("  Setup:");
      for (const [, def] of groups.open) {
        humanLog(`  ${tier(def.tier)} npm run ${def.alias.padEnd(20)} ${def.description}`);
      }
    }

    humanLog("\n  Read-only:");
    for (const [, def] of groups.read) {
      humanLog(`  ${tier(def.tier)} npm run ${def.alias.padEnd(20)} ${def.description}`);
    }

    humanLog("\n  Mutating (\ud83d\udd12 requires cloud:init):");
    for (const [, def] of groups.write) {
      humanLog(`  ${tier(def.tier)} npm run ${def.alias.padEnd(20)} ${def.description}`);
    }

    humanLog(`\n  Flags:`);
    humanLog(`    --ax, --json        Structured JSON for AI agents`);
    humanLog(`    --force             Force overwrite (cloud:init)`);
    humanLog(`    --percent <n>       Canary traffic % (cloud:canary, default 10)`);
    humanLog(`    --min <n> --max <n> Set scaling (cloud:scale)`);
    humanLog(`    --run-canonical-seed  Run canonical snapshot seed during deploy`);
    humanLog(`    --skip-ingest         Skip feed ingest during deploy (ingest runs by default)`);
    humanLog(`    --ip <addr|cidr>    Cloud SQL authorized IP/CIDR (cloud:db:auth)`);
    humanLog(`    -n <count>          Warmup requests (cloud:warm, default 3)`);
    humanLog(`\n  Examples:`);
    humanLog(`    npm run cloud:init                    # One-time auth setup`);
    humanLog(`    npm run cloud:deploy                  # Full deploy pipeline`);
    humanLog(`    npm run cloud:deploy -- --run-canonical-seed  # Deploy + explicit snapshot seed`);
    humanLog(`    npm run cloud:deploy -- --skip-ingest         # Deploy without feed ingest`);
    humanLog(`    npm run cloud:db:auth                 # Allow current public IP in Cloud SQL`);
    humanLog(`    npm run cloud:canary -- --percent 20  # 20% canary deploy`);
    humanLog(`    npm run cloud:status -- --ax          # Structured JSON`);
    humanLog(`    npm run cloud:warm -- -n 5            # 5 warmup pings`);
    humanLog(`    npm run cloud:costs -- --ax | jq .data.totalEstimate`);
  }
}

// ─── Command Registry ───────────────────────────────────────────

const COMMANDS: Record<string, CommandDef> = {
  // Tier: open
  help:      { fn: cmdHelp,      tier: "open",  alias: "cloud",           description: "Show all commands, tiers, and usage" },
  init:      {
    fn: cmdInit,
    tier: "open",
    alias: "cloud:init",
    description: "Generate .cloud-auth token (chmod 600, gitignored)",
    args: [{ name: "--force", type: "boolean", description: "Overwrite existing .cloud-auth file" }],
  },
  // Tier: read
  status:    { fn: cmdStatus,    tier: "read",  alias: "cloud:status",    description: "Service status: URL, revision, scaling, resources" },
  health:    { fn: cmdHealth,    tier: "read",  alias: "cloud:health",    description: "Hit production /api/health endpoint" },
  logs:      { fn: cmdLogs,      tier: "read",  alias: "cloud:logs",      description: "Tail production logs (streaming/batch)" },
  triage:    {
    fn: cmdTriage,
    tier: "read",
    alias: "cloud:triage",
    description: "Cost-aware failure triage by runId/traceId/requestId",
    args: [
      { name: "--run-id", type: "string", description: "Chat run ID (crun_...)" },
      { name: "--trace-id", type: "string", description: "Trace ID from API/status payload" },
      { name: "--request-id", type: "string", description: "Request ID from envelope/header" },
      { name: "--minutes", type: "integer", default: "60", description: "Freshness window (5-360)" },
      { name: "--limit", type: "integer", default: "200", description: "Max log rows (20-500)" },
    ],
  },
  "triage:bundle": {
    fn: cmdTriageBundle,
    tier: "read",
    alias: "cloud:triage:bundle",
    description: "Generate markdown-ready incident triage bundle by runId/traceId/requestId",
    args: [
      { name: "--run-id", type: "string", description: "Chat run ID (crun_...)" },
      { name: "--trace-id", type: "string", description: "Trace ID from API/status payload" },
      { name: "--request-id", type: "string", description: "Request ID from envelope/header" },
      { name: "--minutes", type: "integer", default: "60", description: "Freshness window (5-360)" },
      { name: "--limit", type: "integer", default: "200", description: "Max log rows (20-500)" },
    ],
  },
  env:       { fn: cmdEnv,       tier: "read",  alias: "cloud:env",       description: "Show Cloud Run env vars and secret bindings" },
  secrets:   { fn: cmdSecrets,   tier: "read",  alias: "cloud:secrets",   description: "List Secret Manager secrets (values never exposed)" },
  sql:       { fn: cmdSql,       tier: "read",  alias: "cloud:sql",       description: "Cloud SQL instance status and configuration" },
  revisions: { fn: cmdRevisions, tier: "read",  alias: "cloud:revisions", description: "List revisions with traffic split percentages" },
  diff:      { fn: cmdDiff,      tier: "read",  alias: "cloud:diff",      description: "Compare local vs deployed (version, SHA, env drift)" },
  metrics:   { fn: cmdMetrics,   tier: "read",  alias: "cloud:metrics",   description: "Log-based metrics: latency, errors, status codes (1h)" },
  costs:     { fn: cmdCosts,     tier: "read",  alias: "cloud:costs",     description: "Estimated monthly costs (Cloud Run + Cloud SQL)" },
  warm:      {
    fn: cmdWarm,
    tier: "read",
    alias: "cloud:warm",
    description: "Send warmup pings to detect cold starts",
    args: [{ name: "-n", type: "integer", default: "3", description: "Number of warmup requests" }],
  },
  // Tier: write (requires .cloud-auth)
  deploy:    {
    fn: cmdDeploy,
    tier: "write",
    alias: "cloud:deploy",
    description: "Full pipeline: local-ci → build → deploy → health → default feed ingest + optional canonical seed",
    args: [
      { name: "--skip-seed", type: "boolean", description: "Skip all post-deploy DB sync steps" },
      { name: "--run-canonical-seed", type: "boolean", description: "Run canonical snapshot seed (officers/ships) — skipped by default" },
      { name: "--run-cdn", type: "boolean", description: "Backward-compatible alias for --run-canonical-seed" },
      { name: "--skip-ingest", type: "boolean", description: "Skip feed ingest during deploy (ingest runs by default)" },
      { name: "--seed-feed", type: "string", description: "Feed ID/path for ingest (auto-discovered if omitted)" },
      { name: "--feeds-root", type: "string", description: "Feeds root when using feed IDs (default auto-detect)" },
      { name: "--retention-keep-runs", type: "integer", default: "10", description: "Runtime dataset retention window for feed ingest" },
    ],
  },
  build:     { fn: cmdBuild,     tier: "write", alias: "cloud:build",     description: "Build container image via Cloud Build" },
  push:      { fn: cmdPush,      tier: "write", alias: "cloud:push",      description: "Deploy already-built image to Cloud Run" },
  rollback:  { fn: cmdRollback,  tier: "write", alias: "cloud:rollback",  description: "Roll back to previous Cloud Run revision" },
  scale:     {
    fn: cmdScale,
    tier: "write",
    alias: "cloud:scale",
    description: "View/set min-max instance scaling",
    args: [
      { name: "--min", type: "integer", default: "0", description: "Minimum instances (0 = scale to zero)" },
      { name: "--max", type: "integer", default: "cloud default", description: "Maximum instances" },
    ],
  },
  canary:    {
    fn: cmdCanary,
    tier: "write",
    alias: "cloud:canary",
    description: "Deploy with partial traffic (default 10%)",
    args: [{ name: "--percent", type: "integer", default: "10", description: "Traffic percentage for canary revision" }],
  },
  promote:   {
    fn: cmdPromote,
    tier: "write",
    alias: "cloud:promote",
    description: "Route 100% traffic to a specific revision",
    args: [{ name: "<revision>", type: "string", description: "Revision name to route 100% traffic to" }],
  },
  ssh:       { fn: cmdSsh,       tier: "write", alias: "cloud:ssh",       description: "Start Cloud SQL Auth Proxy for local psql" },
  // DB operations (requires IP authorization)
  "db:auth":          {
    fn: cmdDbAuth,
    tier: "write",
    alias: "cloud:db:auth",
    description: "Add the current public IP (or --ip) to the Cloud SQL authorized network list",
    args: [{ name: "--ip", type: "string", description: "Optional IPv4 or CIDR to allow; defaults to current public IPv4/32" }],
  },
  "db:seed":           { fn: cmdDbSeed,          tier: "write", alias: "cloud:db:seed",           description: "Seed Cloud DB from CDN snapshot (alias for db:seed:canonical)" },
  "db:seed:canonical": { fn: cmdDbSeedCanonical, tier: "write", alias: "cloud:db:seed:canonical", description: "Seed Cloud DB from CDN snapshot" },
  "db:seed:effects":   {
    fn: cmdDbSeedEffects,
    tier: "write",
    alias: "cloud:db:seed:effects",
    description: "Run effects:build for seed prep (--mode=deterministic|hybrid, default hybrid)",
    args: [
      { name: "--mode", type: "string", default: "hybrid", description: "effects:build mode: deterministic | hybrid" },
      { name: "--input", type: "string", description: "Optional snapshot export path for effects:build" },
      { name: "--snapshot", type: "string", description: "Optional snapshot label passed to effects:build" },
    ],
  },
  "db:seed:all":       {
    fn: cmdDbSeedAll,
    tier: "write",
    alias: "cloud:db:seed:all",
    description: "Run effects generation then canonical Cloud DB seed",
    args: [
      { name: "--mode", type: "string", default: "hybrid", description: "effects:build mode: deterministic | hybrid" },
      { name: "--input", type: "string", description: "Optional snapshot export path for effects:build" },
      { name: "--snapshot", type: "string", description: "Optional snapshot label passed to effects:build" },
    ],
  },
  "db:wipe":           { fn: cmdDbWipe,          tier: "write", alias: "cloud:db:wipe",           description: "Delete all officers (--force required)" },
  "db:reset:canonical": {
    fn: cmdDbResetCanonical,
    tier: "write",
    alias: "cloud:db:reset:canonical",
    description: "Truncate canonical/reference/effects data while preserving user/auth/player tables",
    args: [
      { name: "--force", type: "boolean", description: "Required safety flag" },
      { name: "--apply", type: "boolean", description: "Required execution flag" },
      { name: "--confirm", type: "string", description: "Must equal RESET_CANONICAL" },
    ],
  },
  "db:count":          { fn: cmdDbCount,         tier: "read",  alias: "cloud:db:count",          description: "Show officer/ship counts in Cloud DB" },
};

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find(a => !a.startsWith("--"));
  setAxMode(args.includes("--ax") || args.includes("--json"));

  if (!command || command === "--help" || command === "-h" || command === "help") {
    await cmdHelp();
    return;
  }

  const def = COMMANDS[command];
  if (!def) {
    if (AX_MODE) {
      console.log(JSON.stringify({
        command: `cloud:${command}`,
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        data: {},
        errors: [`Unknown command: ${command}`],
        hints: [`Valid commands: ${Object.keys(COMMANDS).join(", ")}`, "Run: cloud help --ax"],
      }, null, 2));
    } else {
      humanError(`\u274c Unknown command: ${command}`);
      humanError(`   Run: npx tsx scripts/cloud.ts help`);
    }
    process.exit(1);
  }

  // Open tier: no gcloud needed (help, init)
  if (def.tier !== "open") {
    if (!ensureGcloud()) process.exit(1);
  }

  // Write tier: require .cloud-auth token
  if (def.tier === "write") {
    if (!requireWriteAuth(command)) process.exit(1);
  }

  await def.fn();
}

main().catch((err) => {
  if (AX_MODE) {
    console.log(JSON.stringify({
      command: `cloud:${process.argv[2] ?? "unknown"}`,
      success: false,
      timestamp: new Date().toISOString(),
      durationMs: 0,
      data: {},
      errors: [err instanceof Error ? err.message : String(err)],
      hints: ["Check gcloud auth: gcloud auth list", "Verify project: gcloud config get-value project", "Run cloud:help --ax for command reference"],
    }, null, 2));
  } else {
    console.error("\ud83d\udca5 Unexpected error:", err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
