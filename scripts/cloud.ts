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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import os from "node:os";
import type { AxCommandOutput } from "../src/shared/ax.js";
import { stableJsonStringify } from "../src/server/services/effects-contract-v3.js";

// ─── Constants ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const PROJECT = "smartergpt-majel";
const REGION = "us-central1";
const SERVICE = "majel";
const REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT}/${SERVICE}`;
const IMAGE = `${REGISTRY}/${SERVICE}:latest`;
const CLOUD_SQL_INSTANCE = `${PROJECT}:${REGION}:majel-pg`;

const AUTH_FILE = resolve(ROOT, ".cloud-auth");
const AUTH_TOKEN_BYTES = 32; // 64 hex chars

// ─── Types ──────────────────────────────────────────────────────

type AuthTier = "open" | "read" | "write";
interface CommandArgDef {
  name: string;
  type: string;
  default?: string;
  description: string;
}

interface CommandDef {
  fn: () => Promise<void>;
  tier: AuthTier;
  description: string;
  alias: string;
  args?: CommandArgDef[];
}

interface DeploySmokeCheck {
  name: string;
  path: string;
  expectedStatus: number[];
  actualStatus: number | null;
  pass: boolean;
  error?: string;
}

let AX_MODE = false;

// ─── Helpers ────────────────────────────────────────────────────

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function axOutput(command: string, start: number, data: Record<string, unknown>, opts?: { errors?: string[]; hints?: string[]; success?: boolean }): void {
  const output: AxCommandOutput = {
    command: `cloud:${command}`,
    success: opts?.success ?? true,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    data,
  };
  if (opts?.errors?.length) output.errors = opts.errors;
  if (opts?.hints?.length) output.hints = opts.hints;
  console.log(JSON.stringify(output, null, 2));
}

/** Shell-safe command runner. Splits a command string into [program, ...args] and uses execFileSync to avoid shell injection. */
function run(cmd: string, opts?: { silent?: boolean; capture?: boolean }): string {
  const parts = shellSplit(cmd);
  const [program, ...args] = parts;
  try {
    const result = execFileSync(program, args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: opts?.capture ? ["pipe", "pipe", "pipe"] : (opts?.silent ? ["pipe", "pipe", "pipe"] : "inherit"),
      timeout: 300_000, // 5 min max
    });
    return typeof result === "string" ? result.trim() : "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!AX_MODE && !opts?.silent) {
      console.error(`\u274c Command failed: ${program} ${args.join(" ")}`);
      console.error(msg);
    }
    throw err;
  }
}

/** Shell-split supporting single/double quotes and backslash escaping. */
function shellSplit(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < cmd.length; index += 1) {
    const ch = cmd[index] ?? "";

    if (ch === "\\") {
      const next = cmd[index + 1];
      if (next != null) {
        current += next;
        index += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if ((ch === "'" || ch === '"')) {
      if (quote === null) {
        quote = ch;
        continue;
      }
      if (quote === ch) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (/\s/.test(ch) && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote !== null) {
    throw new Error(`Unterminated quote (${quote}) in command: ${cmd}`);
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function runCapture(cmd: string): string {
  return run(cmd, { capture: true });
}

function gcloud(args: string, opts?: { silent?: boolean; capture?: boolean }): string {
  return run(`gcloud ${args}`, opts);
}

function gcloudCapture(args: string): string {
  return gcloud(args, { capture: true });
}

function gcloudJson<T = unknown>(args: string): T {
  const raw = gcloudCapture(`${args} --format=json`);
  return JSON.parse(raw) as T;
}

function humanLog(msg: string): void {
  if (!AX_MODE) console.log(msg);
}

function humanError(msg: string): void {
  if (!AX_MODE) console.error(msg);
}

function ensureGcloud(): boolean {
  try {
    runCapture("which gcloud");
    return true;
  } catch {
    if (AX_MODE) {
      console.log(JSON.stringify({
        command: `cloud:${process.argv.slice(2).find(a => !a.startsWith("--")) ?? "unknown"}`,
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        data: {},
        errors: ["gcloud CLI not found on PATH"],
        hints: [
          "Install: https://cloud.google.com/sdk/docs/install",
          "Or run from a machine with gcloud configured",
        ],
      }, null, 2));
    } else {
      humanError("\u274c gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install");
    }
    return false;
  }
}

// ─── Auth ───────────────────────────────────────────────────────

function loadCloudToken(): string | null {
  // 1. Check env var first (CI pipelines)
  if (process.env.MAJEL_CLOUD_TOKEN) return process.env.MAJEL_CLOUD_TOKEN;

  // 2. Check .cloud-auth file exists
  if (!existsSync(AUTH_FILE)) return null;

  // 3. Verify permissions (must be 600)
  try {
    const stats = statSync(AUTH_FILE);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      humanError(`\u26a0\ufe0f  .cloud-auth has permissions ${mode.toString(8)} \u2014 expected 600. Run: chmod 600 .cloud-auth`);
      return null;
    }
  } catch { return null; }

  // 4. Parse token
  try {
    const content = readFileSync(AUTH_FILE, "utf-8");
    const match = content.match(/^MAJEL_CLOUD_TOKEN=(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch { return null; }
}

const CLOUD_TOKEN_MIN_LENGTH = 32; // reject trivially short tokens
const CLOUD_TOKEN_PATTERN = /^[a-f0-9]{32,}$/i; // hex string, 32+ chars

function requireWriteAuth(command: string): boolean {
  const token = loadCloudToken();
  if (!token || !CLOUD_TOKEN_PATTERN.test(token)) {
    const errors = !token
      ? ["Write auth required. Run `npm run cloud:init` to generate .cloud-auth token."]
      : [`Invalid cloud auth token (expected ${CLOUD_TOKEN_MIN_LENGTH}+ hex chars). Regenerate: npm run cloud:init -- --force`];
    if (AX_MODE) {
      console.log(JSON.stringify({
        command: `cloud:${command}`,
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        data: {},
        errors,
        hints: ["For CI: set MAJEL_CLOUD_TOKEN environment variable"],
      }, null, 2));
    } else {
      humanError(`\ud83d\udd12 ${errors[0]}`);
      humanError("   Or set MAJEL_CLOUD_TOKEN env var for CI.");
    }
    return false;
  }
  return true;
}

function runDeploySmokeChecks(baseUrl: string): { pass: boolean; checks: DeploySmokeCheck[] } {
  const checks: Array<Omit<DeploySmokeCheck, "actualStatus" | "pass" | "error">> = [
    { name: "health endpoint", path: "/api/health", expectedStatus: [200] },
    { name: "api discovery", path: "/api", expectedStatus: [200] },
    { name: "auth me guard", path: "/api/auth/me", expectedStatus: [200, 401] },
    { name: "catalog counts guard", path: "/api/catalog/counts", expectedStatus: [200, 401] },
  ];

  const results: DeploySmokeCheck[] = checks.map((check) => {
    try {
      const raw = runCapture(`curl -sS -o /dev/null -w '%{http_code}' ${baseUrl}${check.path} --max-time 10`);
      const actualStatus = Number.parseInt(raw, 10);
      const pass = Number.isFinite(actualStatus) && check.expectedStatus.includes(actualStatus);
      return {
        ...check,
        actualStatus: Number.isFinite(actualStatus) ? actualStatus : null,
        pass,
      };
    } catch (err) {
      return {
        ...check,
        actualStatus: null,
        pass: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return {
    pass: results.every((check) => check.pass),
    checks: results,
  };
}

// ─── Commands ───────────────────────────────────────────────────

async function cmdDeploy(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const skipSeed = args.includes("--skip-seed");
  const explicitFeed = getFlagValue(args, "seed-feed") ?? getFlagValue(args, "feed");
  const feedsRootFlag = getFlagValue(args, "feeds-root");
  const retentionKeepRunsRaw = getFlagValue(args, "retention-keep-runs");
  const retentionKeepRuns = retentionKeepRunsRaw ? Math.max(1, Number.parseInt(retentionKeepRunsRaw, 10) || 10) : 10;

  humanLog("🚀 Majel Cloud Deploy — Full Pipeline");
  humanLog("────────────────────────────────────────");

  // Step 1: Local CI
  humanLog("\n📋 Step 1/7: Running local CI...");
  try {
    run("npm run local-ci");
  } catch {
    const msg = "Local CI failed — fix issues before deploying";
    if (AX_MODE) {
      axOutput("deploy", start, { step: "local-ci", phase: "pre-flight" }, {
        success: false,
        errors: [msg],
        hints: ["Run: npm test to diagnose test failures", "Run: npm run lint to check linting", "Run: npx tsc --noEmit to check types"],
      });
    } else {
      console.error(`❌ ${msg}`);
    }
    process.exit(1);
  }

  // Step 2: Build image
  humanLog("\n📦 Step 2/7: Building container image...");
  try {
    gcloud(`builds submit --tag ${IMAGE} --quiet`);
  } catch (err) {
    if (AX_MODE) {
      axOutput("deploy", start, { step: "build", phase: "image-build", image: IMAGE }, {
        success: false,
        errors: [`Image build failed: ${err instanceof Error ? err.message : String(err)}`],
        hints: ["Check Cloud Build logs in GCP Console", "Verify Dockerfile syntax: docker build ."],
      });
    } else {
      console.error("❌ Image build failed");
    }
    process.exit(1);
  }

  // Step 3: Deploy to Cloud Run
  humanLog("\n☁️  Step 3/7: Deploying to Cloud Run...");
  try {
    gcloud(`run deploy ${SERVICE} --image ${IMAGE} --region ${REGION} --quiet`);
  } catch (err) {
    if (AX_MODE) {
      axOutput("deploy", start, { step: "deploy", phase: "cloud-run-deploy", image: IMAGE }, {
        success: false,
        errors: [`Cloud Run deploy failed: ${err instanceof Error ? err.message : String(err)}`],
        hints: ["Image was built successfully — try: npm run cloud:push", "Check service logs: npm run cloud:logs -- --ax"],
      });
    } else {
      console.error("❌ Cloud Run deploy failed (image was built)");
    }
    process.exit(1);
  }

  // Step 4: Health check
  humanLog("\n🏥 Step 4/7: Health check...");
  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);
  let healthOk = false;
  let healthData: Record<string, unknown> = {};
  try {
    const raw = runCapture(`curl -sf ${url}/api/health --max-time 10`);
    healthData = JSON.parse(raw);
    healthOk = true;
  } catch {
    /* healthOk already false */
  }

  let canonicalSeedOutput = "";
  let ingestionOutput = "";
  let seededFeedPath: string | null = null;
  let seededFeedSource: "explicit" | "auto" | "skipped" = "skipped";
  let deploySmokeChecks: DeploySmokeCheck[] = [];
  let deploySmokePass = false;

  if (healthOk && !skipSeed) {
    // Step 5: Idempotent canonical upsert seed (officers/ships)
    humanLog("\n🌱 Step 5/7: Seeding canonical reference data (idempotent upsert)...");
    const canonicalSeed = runCanonicalSeedScript(start, "deploy");
    canonicalSeedOutput = canonicalSeed.output;

    // Step 6: Idempotent crawler feed load (all entities + runtime dataset)
    humanLog("\n🧩 Step 6/7: Loading crawler feed data (idempotent add/update)...");
    const discovered = resolveDeployFeedSelection({
      explicitFeed,
      feedsRootFlag,
    });
    seededFeedPath = discovered.feedPath;
    seededFeedSource = discovered.source;
    const cloudDbUrl = getCloudDbUrl();
    const ingestion = runCrawlerFeedLoad(start, "deploy", {
      feedPath: discovered.feedPath,
      feedsRoot: discovered.feedsRoot,
      dbUrl: cloudDbUrl,
      retentionKeepRuns,
    });
    ingestionOutput = ingestion.output;
  }

  if (healthOk) {
    humanLog("\n🧪 Step 7/7: Running post-deploy smoke checklist...");
    const smokeResult = runDeploySmokeChecks(url);
    deploySmokeChecks = smokeResult.checks;
    deploySmokePass = smokeResult.pass;

    if (!AX_MODE) {
      for (const check of deploySmokeChecks) {
        const expected = check.expectedStatus.join("/");
        const actual = check.actualStatus ?? "request-failed";
        humanLog(`  ${check.pass ? "✅" : "❌"} ${check.name}: ${check.path} (expected ${expected}, got ${actual})`);
      }
    }
  }

  const deployOk = healthOk && deploySmokePass;

  if (AX_MODE) {
    const revision = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.latestReadyRevisionName)'`);
    axOutput("deploy", start, {
      url,
      revision,
      image: IMAGE,
      healthCheck: healthOk ? "pass" : "fail",
      health: healthData,
      postDeployChecklist: {
        ran: healthOk,
        status: !healthOk ? "skipped" : (deploySmokePass ? "pass" : "fail"),
        checks: deploySmokeChecks,
      },
      version: getPackageVersion(),
      seed: {
        skipped: skipSeed,
        canonicalApplied: healthOk && !skipSeed,
        feedPath: seededFeedPath,
        feedSource: seededFeedSource,
        retentionKeepRuns,
      },
      seedOutputs: {
        canonical: canonicalSeedOutput,
        ingestion: ingestionOutput,
      },
    }, {
      success: deployOk,
      errors: deployOk
        ? undefined
        : [
          ...(healthOk ? [] : ["Post-deploy health check failed"]),
          ...(healthOk && !deploySmokePass ? ["Post-deploy smoke checklist failed"] : []),
        ],
      hints: deployOk ? undefined : [`Check logs: npm run cloud:logs`, `Rollback: npm run cloud:rollback`, `Run: npm run cloud:health`],
    });
  } else {
    humanLog("\n────────────────────────────────────────");
    if (!healthOk) {
      humanLog(`⚠️  Deployed but health check failed. Check: npm run cloud:logs`);
      process.exitCode = 1;
      return;
    }
    if (!deploySmokePass) {
      humanLog(`⚠️  Deploy completed but post-deploy smoke checklist failed. Check: npm run cloud:logs`);
      process.exitCode = 1;
      return;
    }
    if (skipSeed) {
      humanLog(`✅ Deploy complete (seed skipped). ${url}`);
      return;
    }
    humanLog(`✅ Deploy + idempotent data sync complete! ${url}`);
    if (seededFeedPath) {
      humanLog(`   Feed loaded: ${seededFeedPath} (${seededFeedSource})`);
    }
  }
}

function getCloudDbUrl(): string {
  const password = encodeURIComponent(getCloudDbPassword());
  const publicIp = getCloudSqlPrimaryIp();
  return `postgresql://postgres:${password}@${publicIp}:5432/majel`;
}

function findLatestFeedRun(feedsRoot: string): string | null {
  if (!existsSync(feedsRoot)) return null;

  const runDirs: Array<{ path: string; mtimeMs: number }> = [];
  const firstLevel = readdirSync(feedsRoot, { withFileTypes: true });

  for (const entry of firstLevel) {
    if (!entry.isDirectory()) continue;
    const dayOrFeedDir = join(feedsRoot, entry.name);
    const directFeed = join(dayOrFeedDir, "feed.json");
    if (existsSync(directFeed)) {
      runDirs.push({ path: dayOrFeedDir, mtimeMs: statSync(directFeed).mtimeMs });
      continue;
    }

    for (const runEntry of readdirSync(dayOrFeedDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      const runDir = join(dayOrFeedDir, runEntry.name);
      const feedPath = join(runDir, "feed.json");
      if (!existsSync(feedPath)) continue;
      runDirs.push({ path: runDir, mtimeMs: statSync(feedPath).mtimeMs });
    }
  }

  if (runDirs.length === 0) return null;
  runDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return runDirs[0]?.path ?? null;
}

function resolveDeployFeedSelection(input: {
  explicitFeed?: string;
  feedsRootFlag?: string;
}): { feedPath: string; feedsRoot: string; source: "explicit" | "auto" } {
  const explicit = input.explicitFeed?.trim();
  const explicitFeedsRoot = input.feedsRootFlag?.trim();

  if (explicit) {
    const explicitPath = resolve(explicit);
    if (existsSync(join(explicitPath, "feed.json"))) {
      return {
        feedPath: explicitPath,
        feedsRoot: explicitFeedsRoot ?? dirname(explicitPath),
        source: "explicit",
      };
    }
    const rootForExplicit = resolve(explicitFeedsRoot ?? ".");
    const rootedPath = resolve(rootForExplicit, explicit);
    if (existsSync(join(rootedPath, "feed.json"))) {
      return {
        feedPath: rootedPath,
        feedsRoot: rootForExplicit,
        source: "explicit",
      };
    }
    return {
      feedPath: explicit,
      feedsRoot: rootForExplicit,
      source: "explicit",
    };
  }

  const candidateRoots = [
    explicitFeedsRoot,
    process.env.MAJEL_FEEDS_ROOT,
    resolve(ROOT, "data", "feeds"),
    "/srv/crawlers/stfc.space/data/feeds",
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  for (const root of candidateRoots) {
    const resolvedRoot = resolve(root);
    const latestRun = findLatestFeedRun(resolvedRoot);
    if (latestRun) {
      return {
        feedPath: latestRun,
        feedsRoot: resolvedRoot,
        source: "auto",
      };
    }
  }

  throw new Error("No crawler feed found for deploy sync. Provide --seed-feed <feedId-or-path> and optionally --feeds-root <path>.");
}

function runCrawlerFeedLoad(
  start: number,
  commandName: string,
  options: {
    feedPath: string;
    feedsRoot: string;
    dbUrl: string;
    retentionKeepRuns: number;
  }
): { output: string } {
  const args = [
    "tsx",
    "scripts/data-ingestion.ts",
    "load",
    "--feed",
    options.feedPath,
    "--feeds-root",
    options.feedsRoot,
    "--db-url",
    options.dbUrl,
    "--activate-runtime-dataset",
    "--retention-keep-runs",
    String(options.retentionKeepRuns),
  ];

  const result = spawnSync("npx", args, {
    cwd: process.cwd(),
    stdio: AX_MODE ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    if (AX_MODE) {
      axOutput(commandName, start, {
        step: "crawler-feed-load",
        feedPath: options.feedPath,
        feedsRoot: options.feedsRoot,
      }, {
        success: false,
        errors: ["Crawler feed load failed", result.stderr || "Unknown error"],
        hints: [
          "Verify feed path has feed.json",
          "Try explicit feed: npm run cloud:deploy -- --seed-feed <feedId-or-path> --feeds-root <path>",
        ],
      });
    } else {
      humanError("❌ Crawler feed load failed");
      humanError(`   feed=${options.feedPath}`);
      humanError(`   feedsRoot=${options.feedsRoot}`);
    }
    process.exit(1);
  }

  return { output: result.stdout || "" };
}

async function cmdBuild(): Promise<void> {
  const start = Date.now();
  humanLog("📦 Building container image via Cloud Build...");
  gcloud(`builds submit --tag ${IMAGE} --quiet`);

  if (AX_MODE) {
    axOutput("build", start, {
      image: IMAGE,
      registry: REGISTRY,
    }, { hints: [`Deploy with: npm run cloud:push`] });
  } else {
    humanLog(`✅ Image built: ${IMAGE}`);
    humanLog(`   Deploy with: npm run cloud:push`);
  }
}

async function cmdPush(): Promise<void> {
  const start = Date.now();
  humanLog("☁️  Deploying to Cloud Run...");
  gcloud(`run deploy ${SERVICE} --image ${IMAGE} --region ${REGION} --quiet`);

  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);
  const revision = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.latestReadyRevisionName)'`);

  if (AX_MODE) {
    axOutput("push", start, { url, revision, image: IMAGE });
  } else {
    humanLog(`✅ Deployed revision: ${revision}`);
    humanLog(`   URL: ${url}`);
  }
}

async function cmdLogs(): Promise<void> {
  const start = Date.now();
  const limit = AX_MODE ? "50" : "100";

  if (AX_MODE) {
    // Structured log fetch for AI agents
    try {
      const raw = gcloudCapture(`run services logs read ${SERVICE} --region ${REGION} --limit ${limit} --format=json`);
      const logs = JSON.parse(raw);
      axOutput("logs", start, {
        count: logs.length,
        entries: logs.map((entry: Record<string, unknown>) => ({
          timestamp: entry.timestamp,
          severity: entry.severity,
          message: entry.textPayload ?? (entry.jsonPayload as Record<string, unknown>)?.message ?? "",
          resource: (entry.resource as Record<string, unknown>)?.labels,
        })),
      });
    } catch {
      axOutput("logs", start, { count: 0, entries: [] }, {
        success: false,
        errors: ["Failed to fetch logs"],
        hints: ["Ensure gcloud is authenticated: gcloud auth login", "Check service exists: npm run cloud:status -- --ax", "Verify permissions: roles/logging.viewer required"],
      });
    }
  } else {
    // Interactive streaming for humans
    humanLog(`📜 Tailing Cloud Run logs (Ctrl+C to stop)...`);
    const child = spawn("gcloud", [
      "run", "services", "logs", "tail", SERVICE,
      "--region", REGION,
    ], { stdio: "inherit" });
    // M7: Graceful cleanup on SIGINT/SIGTERM
    const cleanup = () => { child.kill(); process.exit(0); };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    child.on("exit", (code) => process.exit(code ?? 0));
    // Keep process alive for streaming
    await new Promise(() => {});
  }
}

async function cmdStatus(): Promise<void> {
  const start = Date.now();

  interface ServiceDesc {
    status?: { url?: string; latestReadyRevisionName?: string; conditions?: Array<{ type?: string; status?: string }> };
    spec?: { template?: { spec?: { containerConcurrency?: number; timeoutSeconds?: number; containers?: Array<{ image?: string; resources?: { limits?: Record<string, string> } }> }; metadata?: { annotations?: Record<string, string> } } };
    metadata?: { annotations?: Record<string, string> };
  }

  const svc = gcloudJson<ServiceDesc>(`run services describe ${SERVICE} --region ${REGION}`);
  const url = svc.status?.url ?? "unknown";
  const revision = svc.status?.latestReadyRevisionName ?? "unknown";
  const image = svc.spec?.template?.spec?.containers?.[0]?.image ?? "unknown";
  const memory = svc.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? "unknown";
  const cpu = svc.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? "unknown";
  const annotations = svc.spec?.template?.metadata?.annotations ?? {};
  const minScale = annotations["autoscaling.knative.dev/minScale"] ?? "0";
  const maxScale = annotations["autoscaling.knative.dev/maxScale"] ?? "unknown";
  const conditions = svc.status?.conditions ?? [];

  // Get revisions list
  interface RevisionItem { metadata?: { name?: string; creationTimestamp?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }
  let revisions: RevisionItem[] = [];
  try {
    revisions = gcloudJson<RevisionItem[]>(`run revisions list --service ${SERVICE} --region ${REGION} --limit 5`);
  } catch { /* ignore */ }

  if (AX_MODE) {
    axOutput("status", start, {
      service: SERVICE,
      project: PROJECT,
      region: REGION,
      url,
      activeRevision: revision,
      image,
      scaling: { min: parseInt(minScale, 10), max: parseInt(maxScale, 10) },
      resources: { memory, cpu },
      conditions: conditions.map((c: Record<string, unknown>) => ({ type: c.type, status: c.status })),
      revisions: revisions.map((r) => ({
        name: r.metadata?.name,
        created: r.metadata?.creationTimestamp,
        ready: r.status?.conditions?.find((c) => c.type === "Ready")?.status === "True",
      })),
      version: getPackageVersion(),
    });
  } else {
    humanLog("📊 Majel Cloud Status");
    humanLog("────────────────────────────────────────");
    humanLog(`  Service:   ${SERVICE}`);
    humanLog(`  Project:   ${PROJECT}`);
    humanLog(`  Region:    ${REGION}`);
    humanLog(`  URL:       ${url}`);
    humanLog(`  Revision:  ${revision}`);
    humanLog(`  Image:     ${image}`);
    humanLog(`  Memory:    ${memory}`);
    humanLog(`  CPU:       ${cpu}`);
    humanLog(`  Scaling:   ${minScale}–${maxScale} instances`);
    humanLog(`  Version:   ${getPackageVersion()}`);
    if (revisions.length > 1) {
      humanLog(`\n  Recent revisions:`);
      for (const r of revisions.slice(0, 5)) {
        const ready = r.status?.conditions?.find((c) => c.type === "Ready")?.status === "True" ? "✅" : "❌";
        humanLog(`    ${ready} ${r.metadata?.name} (${r.metadata?.creationTimestamp})`);
      }
    }
  }
}

async function cmdHealth(): Promise<void> {
  const start = Date.now();
  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);

  try {
    const raw = runCapture(`curl -sf ${url}/api/health --max-time 10`);
    const data = JSON.parse(raw);

    if (AX_MODE) {
      axOutput("health", start, {
        url: `${url}/api/health`,
        status: "healthy",
        response: data,
      });
    } else {
      humanLog("🏥 Production Health Check");
      humanLog("────────────────────────────────────────");
      humanLog(`  URL:     ${url}/api/health`);
      humanLog(`  Status:  ✅ healthy`);
      humanLog(`  Response:`);
      console.log(JSON.stringify(data, null, 2));
    }
  } catch {
    if (AX_MODE) {
      axOutput("health", start, { url: `${url}/api/health`, status: "unhealthy" }, { success: false, errors: ["Health check failed or timed out"], hints: ["Check logs: npm run cloud:logs"] });
    } else {
      humanError(`❌ Health check failed: ${url}/api/health`);
      humanError("   Check: npm run cloud:logs");
    }
    process.exit(1);
  }
}

async function cmdSecrets(): Promise<void> {
  const start = Date.now();

  interface SecretItem { name?: string; createTime?: string; labels?: Record<string, string> }
  const secrets = gcloudJson<SecretItem[]>(`secrets list --project ${PROJECT}`);

  if (AX_MODE) {
    axOutput("secrets", start, {
      project: PROJECT,
      count: secrets.length,
      secrets: secrets.map((s) => ({
        name: s.name?.split("/").pop(),
        created: s.createTime,
        labels: s.labels,
      })),
    }, { hints: ["Secret values are never exposed via this command"] });
  } else {
    humanLog("🔐 Secret Manager Secrets");
    humanLog("────────────────────────────────────────");
    for (const s of secrets) {
      const name = s.name?.split("/").pop() ?? "unknown";
      humanLog(`  🔑 ${name} (created: ${s.createTime})`);
    }
    humanLog(`\n  Total: ${secrets.length} secret(s)`);
    humanLog("  ℹ️  Values are NOT shown. Use GCP Console to view/update.");
  }
}

async function cmdSsh(): Promise<void> {
  const start = Date.now();
  humanLog("🔌 Starting Cloud SQL Auth Proxy...");
  humanLog("────────────────────────────────────────");
  humanLog(`  Instance: ${CLOUD_SQL_INSTANCE}`);
  humanLog(`  Connect:  psql -h 127.0.0.1 -p 5433 -U postgres -d majel`);
  humanLog(`  (Ctrl+C to stop proxy)\n`);

  if (AX_MODE) {
    axOutput("ssh", start, {
      instance: CLOUD_SQL_INSTANCE,
      localPort: 5433,
      connectCommand: "psql -h 127.0.0.1 -p 5433 -U postgres -d majel",
      proxyRunning: false,
      note: "AX mode returns metadata only — proxy requires interactive terminal",
    }, { hints: ["Run the connectCommand in another terminal while the proxy is active", "Start proxy interactively: npx tsx scripts/cloud.ts ssh"] });
    return;
  }

  // Resolve cloud-sql-proxy binary (PATH first, then ~/.local/bin fallback)
  let proxyBin = "cloud-sql-proxy";
  try {
    runCapture("which cloud-sql-proxy");
  } catch {
    const localBin = resolve(os.homedir(), ".local", "bin", "cloud-sql-proxy");
    if (existsSync(localBin)) {
      proxyBin = localBin;
    } else {
      humanError("❌ cloud-sql-proxy not found.");
      humanError("   Install: https://cloud.google.com/sql/docs/postgres/sql-proxy");
      humanError("   Or: gcloud components install cloud-sql-proxy");
      process.exit(1);
    }
  }

  const child = spawn(proxyBin, [
    CLOUD_SQL_INSTANCE,
    "--port", "5433",
  ], { stdio: "inherit" });
  // M7: Graceful cleanup on SIGINT/SIGTERM
  const cleanup = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}

async function cmdRollback(): Promise<void> {
  const start = Date.now();

  // Get revision list
  interface RevisionItem { metadata?: { name?: string; creationTimestamp?: string }; status?: { conditions?: Array<{ type?: string; status?: string }> } }
  const revisions = gcloudJson<RevisionItem[]>(`run revisions list --service ${SERVICE} --region ${REGION} --limit 5`);

  if (revisions.length < 2) {
    const msg = "Only one revision exists — nothing to roll back to";
    if (AX_MODE) {
      axOutput("rollback", start, { revisionCount: revisions.length }, { success: false, errors: [msg] });
    } else {
      humanError(`❌ ${msg}`);
    }
    process.exit(1);
  }

  // Second revision is the previous one
  const previous = revisions[1].metadata?.name;
  if (!previous) {
    const msg = "Could not determine previous revision";
    if (AX_MODE) {
      axOutput("rollback", start, {}, { success: false, errors: [msg] });
    } else {
      humanError(`❌ ${msg}`);
    }
    process.exit(1);
  }

  humanLog(`⏪ Rolling back to: ${previous}`);
  gcloud(`run services update-traffic ${SERVICE} --region ${REGION} --to-revisions ${previous}=100`);

  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);

  if (AX_MODE) {
    axOutput("rollback", start, {
      rolledBackTo: previous,
      url,
      currentRevision: revisions[0].metadata?.name,
    }, { hints: ["Re-deploy with: npm run cloud:deploy"] });
  } else {
    humanLog(`✅ Traffic routed to: ${previous}`);
    humanLog(`   Re-deploy: npm run cloud:deploy`);
  }
}

async function cmdEnv(): Promise<void> {
  const start = Date.now();

  interface ContainerSpec {
    env?: Array<{ name: string; value?: string; valueFrom?: { secretKeyRef?: { key?: string; name?: string } } }>;
    image?: string;
  }
  interface ServiceSpec {
    spec?: { template?: { spec?: { containers?: ContainerSpec[] } } };
  }

  const svc = gcloudJson<ServiceSpec>(`run services describe ${SERVICE} --region ${REGION}`);
  const container = svc.spec?.template?.spec?.containers?.[0];
  const envVars = container?.env ?? [];

  const plain: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  for (const v of envVars) {
    if (v.valueFrom?.secretKeyRef) {
      secrets[v.name] = `${v.valueFrom.secretKeyRef.name}:${v.valueFrom.secretKeyRef.key}`;
    } else {
      plain[v.name] = v.value ?? "(empty)";
    }
  }

  if (AX_MODE) {
    axOutput("env", start, {
      service: SERVICE,
      image: container?.image,
      envVars: plain,
      secretBindings: secrets,
      totalVars: Object.keys(plain).length,
      totalSecrets: Object.keys(secrets).length,
    }, { hints: ["Secret values are bound at runtime from Secret Manager. Use cloud:secrets to list them."] });
  } else {
    humanLog("🔧 Cloud Run Environment");
    humanLog("────────────────────────────────────────");
    humanLog("\n  Environment Variables:");
    for (const [k, v] of Object.entries(plain)) {
      humanLog(`    ${k}=${v}`);
    }
    humanLog("\n  Secret Bindings:");
    for (const [k, v] of Object.entries(secrets)) {
      humanLog(`    ${k} ← 🔐 ${v}`);
    }
    humanLog(`\n  ${Object.keys(plain).length} env var(s), ${Object.keys(secrets).length} secret(s)`);
  }
}

// ─── New Commands ───────────────────────────────────────────────

async function cmdInit(): Promise<void> {
  const start = Date.now();

  if (existsSync(AUTH_FILE) && !process.argv.includes("--force")) {
    const token = loadCloudToken();
    if (AX_MODE) {
      axOutput("init", start, { exists: true, valid: !!token }, {
        success: false,
        errors: [".cloud-auth already exists. Use --force to regenerate."],
      });
    } else {
      humanError("\u26a0\ufe0f  .cloud-auth already exists. Use --force to regenerate.");
    }
    return;
  }

  const token = randomBytes(AUTH_TOKEN_BYTES).toString("hex");
  const content = [
    "# Majel Cloud Auth Token",
    `# Generated: ${new Date().toISOString()}`,
    "# chmod 600 \u2014 do NOT commit this file",
    "#",
    "# This token gates mutating cloud commands (deploy, rollback, scale, etc.)",
    "# Set MAJEL_CLOUD_TOKEN env var for CI pipelines.",
    `MAJEL_CLOUD_TOKEN=${token}`,
    "",
  ].join("\n");

  writeFileSync(AUTH_FILE, content, { mode: 0o600 });

  if (AX_MODE) {
    axOutput("init", start, {
      file: ".cloud-auth",
      permissions: "600",
      tokenPreview: `${token.slice(0, 8)}...${token.slice(-8)}`,
    }, { hints: ["Mutating commands now require this token", "Set MAJEL_CLOUD_TOKEN env var for CI"] });
  } else {
    humanLog("\ud83d\udd10 Cloud auth initialized");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  File:   .cloud-auth (chmod 600, gitignored)`);
    humanLog(`  Token:  ${token.slice(0, 8)}...${token.slice(-8)}`);
    humanLog("\n  Mutating commands (deploy, rollback, scale, etc.) now require this token.");
    humanLog("  Set MAJEL_CLOUD_TOKEN env var for CI pipelines.");
  }
}

async function cmdSql(): Promise<void> {
  const start = Date.now();

  interface SqlInstance {
    state?: string;
    databaseVersion?: string;
    settings?: {
      tier?: string;
      dataDiskSizeGb?: string;
      dataDiskType?: string;
      backupConfiguration?: { enabled?: boolean; startTime?: string };
      availabilityType?: string;
    };
    ipAddresses?: Array<{ type?: string; ipAddress?: string }>;
    connectionName?: string;
    createTime?: string;
    serverCaCert?: { expirationTime?: string };
  }

  const instance = gcloudJson<SqlInstance>(`sql instances describe majel-pg --project ${PROJECT}`);

  if (AX_MODE) {
    axOutput("sql", start, {
      instance: "majel-pg",
      project: PROJECT,
      state: instance.state,
      version: instance.databaseVersion,
      tier: instance.settings?.tier,
      diskSizeGb: instance.settings?.dataDiskSizeGb,
      diskType: instance.settings?.dataDiskType,
      availability: instance.settings?.availabilityType,
      backups: instance.settings?.backupConfiguration?.enabled,
      backupWindow: instance.settings?.backupConfiguration?.startTime,
      connectionName: instance.connectionName,
      created: instance.createTime,
      ipAddresses: instance.ipAddresses,
      certExpires: instance.serverCaCert?.expirationTime,
    });
  } else {
    humanLog("\ud83d\udc18 Cloud SQL Instance");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  Instance:     majel-pg`);
    humanLog(`  State:        ${instance.state}`);
    humanLog(`  Version:      ${instance.databaseVersion}`);
    humanLog(`  Tier:         ${instance.settings?.tier}`);
    humanLog(`  Disk:         ${instance.settings?.dataDiskSizeGb} GB (${instance.settings?.dataDiskType})`);
    humanLog(`  Availability: ${instance.settings?.availabilityType}`);
    humanLog(`  Backups:      ${instance.settings?.backupConfiguration?.enabled ? "\u2705 enabled" : "\u274c disabled"} (window: ${instance.settings?.backupConfiguration?.startTime ?? "unset"})`);
    humanLog(`  Connection:   ${instance.connectionName}`);
    humanLog(`  Created:      ${instance.createTime}`);
    if (instance.ipAddresses?.length) {
      humanLog("\n  IP Addresses:");
      for (const ip of instance.ipAddresses) {
        humanLog(`    ${ip.type}: ${ip.ipAddress}`);
      }
    }
  }
}

// ─── DB Operations ──────────────────────────────────────────────

async function cmdDbSeed(): Promise<void> {
  await cmdDbSeedCanonical();
}

function getFlagValue(args: string[], name: string): string | undefined {
  const key = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === key) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) return next;
      return "";
    }
    if (arg.startsWith(`${key}=`)) {
      return arg.slice(key.length + 1);
    }
  }
  return undefined;
}

function getCloudDbPassword(): string {
  return runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
}

function getCloudSqlPrimaryIp(): string {
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;
  if (!publicIp) {
    throw new Error("Could not find Cloud SQL public IP");
  }
  return publicIp;
}

function runCanonicalSeedScript(start: number, commandName: string): { output: string } {
  const password = getCloudDbPassword();
  const publicIp = getCloudSqlPrimaryIp();

  humanLog(`   Connecting to ${publicIp}:5432...`);

  const env = {
    ...process.env,
    CLOUD_DB_HOST: publicIp,
    CLOUD_DB_PORT: "5432",
    CLOUD_DB_PASSWORD: password,
  };

  const result = spawnSync("npx", ["tsx", "scripts/seed-cloud-db.ts"], {
    cwd: process.cwd(),
    env,
    stdio: AX_MODE ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    if (AX_MODE) {
      axOutput(commandName, start, { status: "failed" }, {
        success: false,
        errors: ["Seed script failed", result.stderr || "Unknown error"],
        hints: ["Ensure IP is authorized: npm run cloud:db:auth", "Check CDN snapshot exists: data/.stfc-snapshot/"],
      });
    } else {
      humanError("❌ Seed failed");
    }
    process.exit(1);
  }

  return { output: result.stdout || "" };
}

interface CdnAbilityRef {
  id?: number | null;
  loca_id?: number | null;
  value_is_percentage?: boolean;
}

interface CdnOfficerSummaryItem {
  id: number;
  captain_ability?: CdnAbilityRef | null;
  ability?: CdnAbilityRef | null;
  below_decks_ability?: CdnAbilityRef | null;
}

interface TranslationEntry {
  id: number | null;
  key: string;
  text: string;
}

interface EffectsSnapshotExportOfficer {
  officerId: string;
  abilities: Array<{
    abilityId: string;
    slot: "cm" | "oa" | "bda";
    name: string | null;
    rawText: string;
    isInert: boolean;
    sourceRef: string;
  }>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripColorTags(text: string): string {
  return text.replace(/<\/?color[^>]*>/gi, "").replace(/<\/?size[^>]*>/gi, "").replace(/<\/?sprite[^>]*>/gi, "");
}

function sanitizeSnapshotText(text: string | undefined): string {
  if (!text) return "";
  return stripColorTags(text)
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTranslationMap(entries: TranslationEntry[], key: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const entry of entries) {
    if (entry.id != null && entry.key === key) {
      map.set(entry.id, entry.text);
    }
  }
  return map;
}

function buildEffectsSnapshotFromCdn(): { path: string; officerCount: number; abilityCount: number; snapshotVersion: string } {
  const snapshotRoot = resolve(ROOT, "data", ".stfc-snapshot");
  const summaryPath = resolve(snapshotRoot, "officer", "summary.json");
  const versionPath = resolve(snapshotRoot, "version.txt");
  const buffsPath = resolve(snapshotRoot, "translations", "en", "officer_buffs.json");

  if (!existsSync(summaryPath)) {
    throw new Error("Missing CDN officer summary: data/.stfc-snapshot/officer/summary.json");
  }
  if (!existsSync(versionPath)) {
    throw new Error("Missing CDN snapshot version file: data/.stfc-snapshot/version.txt");
  }
  if (!existsSync(buffsPath)) {
    throw new Error("Missing CDN translations file: data/.stfc-snapshot/translations/en/officer_buffs.json");
  }

  const snapshotVersion = readFileSync(versionPath, "utf-8").trim() || "unknown";
  const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as CdnOfficerSummaryItem[];
  const buffEntries = JSON.parse(readFileSync(buffsPath, "utf-8")) as TranslationEntry[];

  const abilityNameMap = buildTranslationMap(buffEntries, "officer_ability_name");
  const abilityDescMap = buildTranslationMap(buffEntries, "officer_ability_desc");

  const officers: EffectsSnapshotExportOfficer[] = [];
  const slots: Array<{ key: "captain_ability" | "ability" | "below_decks_ability"; slot: "cm" | "oa" | "bda" }> = [
    { key: "captain_ability", slot: "cm" },
    { key: "ability", slot: "oa" },
    { key: "below_decks_ability", slot: "bda" },
  ];

  for (const officer of summary) {
    const officerId = `cdn:officer:${officer.id}`;
    const abilities: EffectsSnapshotExportOfficer["abilities"] = [];

    for (const slotDef of slots) {
      const abilityRef = officer[slotDef.key];
      const abilityLocaId = abilityRef?.loca_id ?? null;
      const abilityGameId = abilityRef?.id ?? null;
      if (!abilityLocaId || !abilityGameId) continue;

      const name = abilityNameMap.get(abilityLocaId) ?? null;
      const rawText = sanitizeSnapshotText(abilityDescMap.get(abilityLocaId));
      const isInert = rawText.length === 0 || /^unknown/i.test(rawText);

      abilities.push({
        abilityId: `${officerId}:${slotDef.slot}:${abilityGameId}`,
        slot: slotDef.slot,
        name,
        rawText,
        isInert,
        sourceRef: `data/.stfc-snapshot/officer/summary.json#/officerId/${officer.id}/${slotDef.key}`,
      });
    }

    officers.push({ officerId, abilities });
  }

  officers.sort((left, right) => left.officerId.localeCompare(right.officerId));
  for (const officer of officers) {
    officer.abilities.sort((left, right) => left.abilityId.localeCompare(right.abilityId));
  }

  const schemaDescriptor = {
    schemaVersion: "1.0.0",
    snapshot: {
      snapshotId: "string",
      source: "cdn-snapshot",
      sourceVersion: "string",
      generatedAt: "iso8601",
      schemaHash: "sha256",
      contentHash: "sha256",
    },
    officers: [{
      officerId: "string",
      abilities: [{
        abilityId: "string",
        slot: "cm|oa|bda",
        name: "string|null",
        rawText: "string",
        isInert: "boolean",
        sourceRef: "string",
      }],
    }],
  } as const;

  const generatedAt = new Date().toISOString();
  const schemaHash = sha256Hex(stableJsonStringify(schemaDescriptor));
  const snapshotId = `cdn-${snapshotVersion}`;
  const contentHash = sha256Hex(stableJsonStringify({
    schemaVersion: "1.0.0",
    snapshot: {
      snapshotId,
      source: "cdn-snapshot",
      sourceVersion: snapshotVersion,
      schemaHash,
    },
    officers,
  }));

  const payload = {
    schemaVersion: "1.0.0" as const,
    snapshot: {
      snapshotId,
      source: "cdn-snapshot",
      sourceVersion: snapshotVersion,
      generatedAt,
      schemaHash,
      contentHash,
    },
    officers,
  };

  const outDir = resolve(ROOT, "tmp", "effects", "exports");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `effects-snapshot.cdn-${snapshotVersion}.json`);
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  const abilityCount = officers.reduce((sum, officer) => sum + officer.abilities.length, 0);
  return {
    path: outPath,
    officerCount: officers.length,
    abilityCount,
    snapshotVersion,
  };
}

function runEffectsBuild(start: number, commandName: string): { mode: "deterministic" | "hybrid"; inputPath?: string; snapshotVersion?: string; axData: Record<string, unknown> } {
  const args = process.argv.slice(2);
  const modeRaw = getFlagValue(args, "mode") || "hybrid";
  if (modeRaw !== "deterministic" && modeRaw !== "hybrid") {
    if (AX_MODE) {
      axOutput(commandName, start, { status: "failed" }, {
        success: false,
        errors: [`Invalid mode '${modeRaw}'`],
        hints: ["Use --mode=deterministic or --mode=hybrid"],
      });
    } else {
      humanError(`❌ Invalid mode '${modeRaw}'. Use --mode=deterministic or --mode=hybrid`);
    }
    process.exit(1);
  }

  const mode = modeRaw;
  let inputPath = getFlagValue(args, "input") || undefined;
  const snapshotVersion = getFlagValue(args, "snapshot") || undefined;

  let generatedInput: { path: string; officerCount: number; abilityCount: number; snapshotVersion: string } | undefined;
  if (!inputPath) {
    try {
      generatedInput = buildEffectsSnapshotFromCdn();
      inputPath = generatedInput.path;
      if (!AX_MODE) {
        humanLog(`   📦 Using CDN snapshot export: ${inputPath}`);
        humanLog(`   👥 Officers parsed: ${generatedInput.officerCount}, abilities parsed: ${generatedInput.abilityCount}`);
      }
    } catch (error) {
      if (AX_MODE) {
        axOutput(commandName, start, { status: "failed" }, {
          success: false,
          errors: [error instanceof Error ? `CDN snapshot export failed: ${error.message}` : "CDN snapshot export failed"],
          hints: ["Ensure data/.stfc-snapshot contains officer summary + translations", "Or provide --input=<snapshot export path>"],
        });
      } else {
        humanError(error instanceof Error ? `❌ ${error.message}` : "❌ CDN snapshot export failed");
      }
      process.exit(1);
    }
  }

  const buildArgs = ["tsx", "scripts/ax.ts", "effects:build", `--mode=${mode}`];
  if (inputPath) buildArgs.push(`--input=${inputPath}`);
  if (snapshotVersion) buildArgs.push(`--snapshot=${snapshotVersion}`);

  const result = spawnSync("npx", buildArgs, {
    cwd: process.cwd(),
    stdio: AX_MODE ? "pipe" : "inherit",
    encoding: "utf-8",
  });

  const raw = result.stdout?.trim() || "";
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { rawOutput: raw };
    }
  }

  if (result.status !== 0) {
    if (AX_MODE) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors.map(String) : [result.stderr || "effects:build failed"];
      const hints = Array.isArray(parsed.hints) ? parsed.hints.map(String) : ["Run: npm run ax -- effects:build --mode=hybrid"];
      axOutput(commandName, start, {
        status: "failed",
        mode,
        inputPath: inputPath ?? null,
        snapshotVersion: snapshotVersion ?? null,
        generatedInput: generatedInput ?? null,
      }, {
        success: false,
        errors,
        hints,
      });
    } else {
      humanError("❌ Effects generation failed");
    }
    process.exit(1);
  }

  if (!AX_MODE) {
    const data = (parsed.data && typeof parsed.data === "object") ? parsed.data as Record<string, unknown> : {};
    const runId = typeof data.runId === "string" ? data.runId : "unknown";
    const receiptPath = typeof data.receiptPath === "string" ? data.receiptPath : "(not reported)";
    humanLog(`   ✅ effects:build ${mode} complete (runId: ${runId})`);
    humanLog(`   📄 Receipt: ${receiptPath}`);
  }

  return {
    mode,
    inputPath,
    snapshotVersion,
    axData: {
      ...parsed,
      generatedInput,
    },
  };
}

async function cmdDbSeedCanonical(): Promise<void> {
  const start = Date.now();

  humanLog("🌱 Seeding Cloud DB from CDN snapshot...");
  humanLog("────────────────────────────────────────");

  const result = runCanonicalSeedScript(start, "db:seed:canonical");

  if (AX_MODE) {
    axOutput("db:seed:canonical", start, { status: "completed", output: result.output });
  }
}

async function cmdDbSeedEffects(): Promise<void> {
  const start = Date.now();

  humanLog("🧬 Building effects artifacts for cloud seed...");
  humanLog("──────────────────────────────────────────────");

  const build = runEffectsBuild(start, "db:seed:effects");

  if (AX_MODE) {
    axOutput("db:seed:effects", start, {
      status: "completed",
      mode: build.mode,
      inputPath: build.inputPath ?? null,
      snapshotVersion: build.snapshotVersion ?? null,
      effectsBuild: build.axData,
    });
  }
}

async function cmdDbSeedAll(): Promise<void> {
  const start = Date.now();

  humanLog("🚀 Running effects generation + canonical cloud DB seed...");
  humanLog("────────────────────────────────────────────────────────────");

  const build = runEffectsBuild(start, "db:seed:all");
  const seed = runCanonicalSeedScript(start, "db:seed:all");

  if (AX_MODE) {
    axOutput("db:seed:all", start, {
      status: "completed",
      mode: build.mode,
      inputPath: build.inputPath ?? null,
      snapshotVersion: build.snapshotVersion ?? null,
      effectsBuild: build.axData,
      canonicalSeedOutput: seed.output,
    });
  }
}

async function cmdDbWipe(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");
  
  if (!force) {
    humanError("⚠️  This will DELETE ALL officers from the cloud database!");
    humanError("   Add --force to confirm");
    process.exit(1);
  }
  
  humanLog("🗑️  Wiping reference_officers table...");
  
  // Get password from Secret Manager
  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  
  // Get Cloud SQL IP
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;
  
  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }
  
  // Create temp script to wipe
  const wipeScript = `
import pg from "pg";
const pool = new pg.Pool({
  host: "${publicIp}",
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});
const result = await pool.query("DELETE FROM reference_officers");
console.log(JSON.stringify({ deleted: result.rowCount }));
await pool.end();
`;

  // Write to temp file (tsx -e doesn't support top-level await)
  const tmpFile = resolve(process.cwd(), ".tmp-db-wipe.mts");
  writeFileSync(tmpFile, wipeScript);
  
  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });
  
  // Clean up temp file
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
  
  let deleted = 0;
  try {
    const output = JSON.parse(result.stdout);
    deleted = output.deleted || 0;
  } catch { /* ignore */ }
  
  if (AX_MODE) {
    axOutput("db:wipe", start, { deleted, status: result.status === 0 ? "completed" : "failed" });
  } else {
    humanLog(`✅ Deleted ${deleted} officers`);
  }
}

async function cmdDbCount(): Promise<void> {
  const start = Date.now();
  
  // Get password from Secret Manager
  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  
  // Get Cloud SQL IP
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(`sql instances describe majel-pg --project ${PROJECT}`);
  const publicIp = instance.ipAddresses?.find(ip => ip.type === "PRIMARY")?.ipAddress;
  
  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }
  
  // Write temp script (avoids tsx -e top-level await issues)
  const countScript = `
import pg from "pg";
const pool = new pg.Pool({
  host: "${publicIp}",
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});
const result = await pool.query(\`
  SELECT 
    (SELECT COUNT(*) FROM reference_officers) as officers,
    (SELECT COUNT(*) FROM reference_ships) as ships
\`);
console.log(JSON.stringify(result.rows[0]));
await pool.end();
`;

  // Write to temp file (tsx -e doesn't support top-level await)
  const tmpFile = resolve(process.cwd(), ".tmp-db-count.mts");
  writeFileSync(tmpFile, countScript);
  
  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });
  
  // Clean up temp file
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
  
  let counts = { officers: 0, ships: 0 };
  try {
    counts = JSON.parse(result.stdout);
  } catch { /* ignore */ }
  
  if (AX_MODE) {
    axOutput("db:count", start, counts);
  } else {
    humanLog("📊 Cloud DB Counts");
    humanLog("────────────────────────────────────────");
    humanLog(`   Officers: ${counts.officers}`);
    humanLog(`   Ships:    ${counts.ships}`);
  }
}

async function cmdDbResetCanonical(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");
  const apply = args.includes("--apply");
  const confirmIndex = args.findIndex((value) => value === "--confirm");
  const confirmValue = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;

  if (!force || !apply || confirmValue !== "RESET_CANONICAL") {
    humanError("⚠️  Canonical reset is protected.");
    humanError("   Required flags:");
    humanError("   --force --apply --confirm RESET_CANONICAL");
    humanError("   Example:");
    humanError("   npm run cloud:db:reset:canonical -- --force --apply --confirm RESET_CANONICAL");
    process.exit(1);
  }

  humanLog("🧨 Resetting canonical/reference/effects data on Cloud SQL (preserving user/player/auth tables)...");

  const password = runCapture(`gcloud secrets versions access latest --secret=cloudsql-password --project ${PROJECT}`);
  const instance = gcloudJson<{ ipAddresses?: Array<{ type?: string; ipAddress?: string }> }>(
    `sql instances describe majel-pg --project ${PROJECT}`,
  );
  const publicIp = instance.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress;

  if (!publicIp) {
    humanError("❌ Could not find Cloud SQL public IP");
    process.exit(1);
  }

  const resetScript = `
import pg from "pg";

const PRESERVE_TABLES = new Set([
  "users",
  "user_sessions",
  "email_tokens",
  "invite_codes",
  "tenant_sessions",
  "auth_audit_log",
  "user_settings",
  "inventory_items",
  "officer_overlay",
  "ship_overlay",
  "targets",
  "intent_catalog",
  "bridge_cores",
  "bridge_core_members",
  "below_deck_policies",
  "loadouts",
  "loadout_variants",
  "docks",
  "fleet_presets",
  "fleet_preset_slots",
  "plan_items",
  "officer_reservations",
  "mutation_proposals",
  "behavior_rules",
  "lex_frames"
]);

const pool = new pg.Pool({
  host: ${JSON.stringify(publicIp)},
  port: 5432,
  user: "postgres",
  password: process.env.CLOUD_DB_PASSWORD,
  database: "majel",
});

try {
  const rows = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );

  const allTables = rows.rows.map((row) => String(row.tablename));
  const preserve = allTables.filter((tableName) => PRESERVE_TABLES.has(tableName));
  const truncate = allTables.filter((tableName) => !PRESERVE_TABLES.has(tableName));

  if (truncate.length > 0) {
    const quoted = truncate.map((tableName) => '"' + tableName + '"').join(", ");
    await pool.query("BEGIN");
    await pool.query("TRUNCATE TABLE " + quoted + " RESTART IDENTITY CASCADE");
    await pool.query("COMMIT");
  }

  console.log(JSON.stringify({
    preserved: preserve,
    truncated: truncate,
    preservedCount: preserve.length,
    truncatedCount: truncate.length,
  }));
} catch (error) {
  try { await pool.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  await pool.end();
}
`;

  const tmpFile = resolve(process.cwd(), ".tmp-db-reset-canonical.mts");
  writeFileSync(tmpFile, resetScript);

  const result = spawnSync("npx", ["tsx", tmpFile], {
    cwd: process.cwd(),
    env: { ...process.env, CLOUD_DB_PASSWORD: password },
    stdio: "pipe",
    encoding: "utf-8",
  });

  try { unlinkSync(tmpFile); } catch { /* ignore */ }

  let payload: {
    preserved?: string[];
    truncated?: string[];
    preservedCount?: number;
    truncatedCount?: number;
  } = {};

  try {
    payload = JSON.parse(result.stdout || "{}");
  } catch {
    payload = {};
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "Unknown canonical reset failure";
    if (AX_MODE) {
      axOutput("db:reset:canonical", start, {
        status: "failed",
        stderr,
        ...payload,
      }, { success: false, errors: [stderr] });
    } else {
      humanError("❌ Canonical reset failed");
      if (stderr) humanError(stderr);
    }
    process.exit(1);
  }

  if (AX_MODE) {
    axOutput("db:reset:canonical", start, {
      status: "completed",
      ...payload,
    });
  } else {
    const truncated = payload.truncated ?? [];
    const preserved = payload.preserved ?? [];
    humanLog("✅ Canonical reset complete");
    humanLog(`   Truncated tables: ${payload.truncatedCount ?? truncated.length}`);
    humanLog(`   Preserved tables: ${payload.preservedCount ?? preserved.length}`);
    if (truncated.length > 0) {
      humanLog(`   Truncated list: ${truncated.join(", ")}`);
    }
  }
}

async function cmdRevisions(): Promise<void> {
  const start = Date.now();

  interface TrafficEntry { revisionName?: string; percent?: number }
  interface ServiceTraffic { status?: { traffic?: TrafficEntry[] } }
  const svc = gcloudJson<ServiceTraffic>(`run services describe ${SERVICE} --region ${REGION}`);
  const trafficEntries = svc.status?.traffic ?? [];
  const trafficMap: Record<string, number> = {};
  for (const t of trafficEntries) {
    if (t.revisionName) trafficMap[t.revisionName] = t.percent ?? 0;
  }

  interface RevisionItem {
    metadata?: { name?: string; creationTimestamp?: string };
    status?: { conditions?: Array<{ type?: string; status?: string }> };
    spec?: { containers?: Array<{ image?: string }> };
  }
  const revisions = gcloudJson<RevisionItem[]>(`run revisions list --service ${SERVICE} --region ${REGION} --limit 10`);

  if (AX_MODE) {
    axOutput("revisions", start, {
      service: SERVICE,
      count: revisions.length,
      revisions: revisions.map((r) => ({
        name: r.metadata?.name,
        created: r.metadata?.creationTimestamp,
        ready: r.status?.conditions?.find((c) => c.type === "Ready")?.status === "True",
        traffic: trafficMap[r.metadata?.name ?? ""] ?? 0,
        image: r.spec?.containers?.[0]?.image,
      })),
    });
  } else {
    humanLog("\ud83d\udccb Cloud Run Revisions");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    for (const r of revisions) {
      const name = r.metadata?.name ?? "unknown";
      const ready = r.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
      const traffic = trafficMap[name] ?? 0;
      const icon = ready ? "\u2705" : "\u274c";
      const trafficStr = traffic > 0 ? ` \u2190 ${traffic}% traffic` : "";
      humanLog(`  ${icon} ${name}  (${r.metadata?.creationTimestamp})${trafficStr}`);
    }
    humanLog(`\n  ${revisions.length} revision(s)`);
  }
}

async function cmdScale(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const minIdx = args.indexOf("--min");
  const maxIdx = args.indexOf("--max");
  const minArg = minIdx >= 0 ? args[minIdx + 1] : undefined;
  const maxArg = maxIdx >= 0 ? args[maxIdx + 1] : undefined;

  // Validate numeric args to prevent injection
  if (minArg !== undefined && (!Number.isInteger(Number(minArg)) || Number(minArg) < 0)) {
    if (AX_MODE) {
      axOutput("scale", start, {}, { success: false, errors: ["--min must be a non-negative integer"], hints: ["Example: npm run cloud:scale -- --min 1 --max 5 --ax"] });
    } else {
      humanError("\u274c --min must be a non-negative integer");
    }
    process.exit(1);
  }
  if (maxArg !== undefined && (!Number.isInteger(Number(maxArg)) || Number(maxArg) < 1)) {
    if (AX_MODE) {
      axOutput("scale", start, {}, { success: false, errors: ["--max must be a positive integer"], hints: ["Example: npm run cloud:scale -- --min 1 --max 5 --ax"] });
    } else {
      humanError("\u274c --max must be a positive integer");
    }
    process.exit(1);
  }

  if (minArg !== undefined || maxArg !== undefined) {
    const flags: string[] = [];
    if (minArg) flags.push(`--min-instances=${Number(minArg)}`);
    if (maxArg) flags.push(`--max-instances=${Number(maxArg)}`);
    gcloud(`run services update ${SERVICE} --region ${REGION} ${flags.join(" ")} --quiet`);

    interface ServiceDesc { spec?: { template?: { metadata?: { annotations?: Record<string, string> } } } }
    const svc = gcloudJson<ServiceDesc>(`run services describe ${SERVICE} --region ${REGION}`);
    const annotations = svc.spec?.template?.metadata?.annotations ?? {};
    const newMin = annotations["autoscaling.knative.dev/minScale"] ?? "0";
    const newMax = annotations["autoscaling.knative.dev/maxScale"] ?? "unknown";

    if (AX_MODE) {
      axOutput("scale", start, { min: parseInt(newMin, 10), max: parseInt(newMax, 10), updated: true }, {
        hints: ["Run cloud:status --ax for full service state"],
      });
    } else {
      humanLog(`\u2705 Scaling updated: ${newMin}\u2013${newMax} instances`);
    }
  } else {
    interface ServiceDesc { spec?: { template?: { metadata?: { annotations?: Record<string, string> } } } }
    const svc = gcloudJson<ServiceDesc>(`run services describe ${SERVICE} --region ${REGION}`);
    const annotations = svc.spec?.template?.metadata?.annotations ?? {};
    const min = annotations["autoscaling.knative.dev/minScale"] ?? "0";
    const max = annotations["autoscaling.knative.dev/maxScale"] ?? "unknown";

    if (AX_MODE) {
      axOutput("scale", start, { min: parseInt(min, 10), max: parseInt(max, 10), updated: false }, {
        hints: ["Set scaling: npm run cloud:scale -- --min 1 --max 5"],
      });
    } else {
      humanLog("\u2696\ufe0f  Cloud Run Scaling");
      humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      humanLog(`  Min instances: ${min}`);
      humanLog(`  Max instances: ${max}`);
      humanLog(`\n  Set: npm run cloud:scale -- --min 1 --max 5`);
    }
  }
}

async function cmdCanary(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const pctIdx = args.indexOf("--percent");
  const pct = pctIdx >= 0 ? parseInt(args[pctIdx + 1] ?? "10", 10) : 10;

  if (pct < 1 || pct > 99) {
    const msg = "Canary percent must be 1\u201399";
    if (AX_MODE) {
      axOutput("canary", start, {}, { success: false, errors: [msg] });
    } else {
      humanError(`\u274c ${msg}`);
    }
    process.exit(1);
  }

  humanLog(`\ud83d\udc24 Canary deploy: ${pct}% traffic to new revision`);

  humanLog("\n  Building + deploying (no traffic)...");
  gcloud(`builds submit --tag ${IMAGE} --quiet`);
  gcloud(`run deploy ${SERVICE} --image ${IMAGE} --region ${REGION} --no-traffic --quiet`);

  const newRevision = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.latestCreatedRevisionName)'`);

  humanLog(`  Routing ${pct}% to ${newRevision}...`);
  gcloud(`run services update-traffic ${SERVICE} --region ${REGION} --to-revisions ${newRevision}=${pct} --quiet`);

  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);

  if (AX_MODE) {
    axOutput("canary", start, {
      canaryRevision: newRevision,
      canaryPercent: pct,
      url,
      image: IMAGE,
    }, { hints: [`Promote: npm run cloud:promote -- ${newRevision}`, "Rollback: npm run cloud:rollback"] });
  } else {
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`\u2705 Canary live: ${newRevision} (${pct}%)`);
    humanLog(`   Promote: npm run cloud:promote -- ${newRevision}`);
    humanLog(`   Rollback: npm run cloud:rollback`);
  }
}

async function cmdPromote(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2).filter(a => a !== "promote" && !a.startsWith("--"));
  let revision = args[0];

  if (!revision) {
    revision = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.latestReadyRevisionName)'`);
  }

  // Validate revision name format (Cloud Run revision names: lowercase alphanum + hyphens)
  if (!/^[a-z][a-z0-9-]{0,95}$/.test(revision)) {
    const msg = `Invalid revision name: ${revision}`;
    if (AX_MODE) { axOutput("promote", start, {}, { success: false, errors: [msg] }); }
    else { humanError(`\u274c ${msg}`); }
    process.exit(1);
  }

  humanLog(`\ud83d\ude80 Promoting ${revision} to 100% traffic...`);
  gcloud(`run services update-traffic ${SERVICE} --region ${REGION} --to-revisions ${revision}=100 --quiet`);

  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);

  if (AX_MODE) {
    axOutput("promote", start, { revision, url, trafficPercent: 100 });
  } else {
    humanLog(`\u2705 ${revision} now serving 100% traffic`);
    humanLog(`   URL: ${url}`);
  }
}

async function cmdDiff(): Promise<void> {
  const start = Date.now();

  const localVersion = getPackageVersion();
  let localSha = "unknown";
  let localBranch = "unknown";
  let localDirty = false;
  try {
    localSha = runCapture("git rev-parse --short HEAD");
    localBranch = runCapture("git rev-parse --abbrev-ref HEAD");
    localDirty = runCapture("git status --porcelain").length > 0;
  } catch { /* not a git repo */ }

  interface ServiceDesc {
    status?: { url?: string; latestReadyRevisionName?: string };
    spec?: { template?: { spec?: { containers?: Array<{ image?: string; env?: Array<{ name: string; value?: string; valueFrom?: unknown }> }> } } };
  }
  const svc = gcloudJson<ServiceDesc>(`run services describe ${SERVICE} --region ${REGION}`);
  const deployedImage = svc.spec?.template?.spec?.containers?.[0]?.image ?? "unknown";
  const deployedRevision = svc.status?.latestReadyRevisionName ?? "unknown";
  const url = svc.status?.url ?? "unknown";

  const deployedPlainEnv = (svc.spec?.template?.spec?.containers?.[0]?.env ?? [])
    .filter((v) => !v.valueFrom)
    .reduce((acc, v) => { acc[v.name] = v.value ?? ""; return acc; }, {} as Record<string, string>);

  const localEnv: Record<string, string> = {};
  try {
    const envContent = readFileSync(resolve(ROOT, ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) localEnv[match[1].trim()] = match[2].trim();
    }
  } catch { /* no .env file */ }

  // I7: Show only keys that drift, never expose values (may contain secrets)
  const drifts: string[] = [];
  for (const key of Object.keys(deployedPlainEnv)) {
    if (localEnv[key] !== undefined && localEnv[key] !== deployedPlainEnv[key]) {
      drifts.push(key);
    }
  }

  if (AX_MODE) {
    axOutput("diff", start, {
      local: { version: localVersion, gitSha: localSha, branch: localBranch, dirty: localDirty },
      deployed: { revision: deployedRevision, image: deployedImage, url },
      envDriftKeys: drifts,
      envDriftCount: drifts.length,
    }, {
      hints: drifts.length > 0 ? ["Environment variable drift detected \u2014 review before deploying", "Drifting keys (values masked): " + drifts.join(", ")] : undefined,
    });
  } else {
    humanLog("\ud83d\udd0d Local vs Deployed Diff");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog("  Local:");
    humanLog(`    Version:  ${localVersion}`);
    humanLog(`    Git SHA:  ${localSha}${localDirty ? " (dirty)" : ""}`);
    humanLog(`    Branch:   ${localBranch}`);
    humanLog("  Deployed:");
    humanLog(`    Revision: ${deployedRevision}`);
    humanLog(`    Image:    ${deployedImage}`);
    humanLog(`    URL:      ${url}`);
    if (drifts.length > 0) {
      humanLog("\n  \u26a0\ufe0f  Environment Drift (values masked):");
      for (const d of drifts) humanLog(`    ${d}: local=**** vs deployed=****`);
    } else {
      humanLog("\n  \u2705 No environment variable drift detected");
    }
  }
}

async function cmdMetrics(): Promise<void> {
  const start = Date.now();

  try {
    const raw = gcloudCapture(
      `logging read 'resource.type="cloud_run_revision" resource.labels.service_name="${SERVICE}" resource.labels.location="${REGION}"' --limit 500 --format=json --freshness=1h --project ${PROJECT}`
    );
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>;

    const severityCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    let httpRequests = 0;
    const latencies: number[] = [];

    for (const entry of entries) {
      const sev = (entry.severity as string) ?? "DEFAULT";
      severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;

      const httpReq = entry.httpRequest as Record<string, unknown> | undefined;
      if (httpReq) {
        httpRequests++;
        const status = String(httpReq.status ?? "0");
        const bucket = `${status[0]}xx`;
        statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
        const lat = httpReq.latency;
        if (typeof lat === "string") {
          const ms = parseFloat(lat) * 1000;
          if (!isNaN(ms)) latencies.push(ms);
        }
      }
    }

    latencies.sort((a, b) => a - b);
    const percentile = (arr: number[], p: number) => arr[Math.floor(arr.length * p)] ?? 0;

    if (AX_MODE) {
      axOutput("metrics", start, {
        window: "1h",
        totalLogEntries: entries.length,
        httpRequests,
        severity: severityCounts,
        statusCodes: statusCounts,
        latencyMs: latencies.length > 0 ? {
          p50: Math.round(percentile(latencies, 0.5)),
          p95: Math.round(percentile(latencies, 0.95)),
          p99: Math.round(percentile(latencies, 0.99)),
          max: Math.round(latencies[latencies.length - 1] ?? 0),
        } : null,
        errorRate: httpRequests > 0
          ? `${(((statusCounts["5xx"] ?? 0) / httpRequests) * 100).toFixed(1)}%`
          : "0%",
      });
    } else {
      humanLog("\ud83d\udcc8 Metrics (last 1 hour)");
      humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      humanLog(`  Log entries:    ${entries.length}`);
      humanLog(`  HTTP requests:  ${httpRequests}`);
      if (Object.keys(statusCounts).length) {
        humanLog(`  Status codes:   ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      if (Object.keys(severityCounts).length) {
        humanLog(`  Severity:       ${Object.entries(severityCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      if (latencies.length > 0) {
        humanLog(`  Latency (ms):   p50=${Math.round(percentile(latencies, 0.5))} p95=${Math.round(percentile(latencies, 0.95))} p99=${Math.round(percentile(latencies, 0.99))} max=${Math.round(latencies[latencies.length - 1])}`);
        humanLog(`  Error rate:     ${(((statusCounts["5xx"] ?? 0) / httpRequests) * 100).toFixed(1)}%`);
      } else {
        humanLog("  (no HTTP request data in the window)");
      }
    }
  } catch {
    if (AX_MODE) {
      axOutput("metrics", start, {}, {
        success: false,
        errors: ["Failed to fetch metrics"],
        hints: ["Ensure Cloud Logging API is enabled", "Verify you have roles/logging.viewer permission", "Check gcloud auth: gcloud auth list"],
      });
    } else {
      humanError("\u274c Failed to fetch metrics");
      humanError("   Ensure logging API is enabled and you have logging.read permission.");
    }
  }
}

async function cmdCosts(): Promise<void> {
  const start = Date.now();

  interface ServiceDesc {
    spec?: { template?: {
      spec?: { containers?: Array<{ resources?: { limits?: Record<string, string> } }> };
      metadata?: { annotations?: Record<string, string> };
    } };
  }
  const svc = gcloudJson<ServiceDesc>(`run services describe ${SERVICE} --region ${REGION}`);
  const limits = svc.spec?.template?.spec?.containers?.[0]?.resources?.limits ?? {};
  const annotations = svc.spec?.template?.metadata?.annotations ?? {};
  const cpu = parseFloat(limits.cpu ?? "1");
  const memoryRaw = limits.memory ?? "512Mi";
  const memoryMi = parseInt(memoryRaw);
  const memoryGiB = memoryMi / 1024;
  const minInstances = parseInt(annotations["autoscaling.knative.dev/minScale"] ?? "0", 10);
  const maxInstances = parseInt(annotations["autoscaling.knative.dev/maxScale"] ?? "3", 10);

  interface SqlInstance { settings?: { tier?: string; dataDiskSizeGb?: string }; state?: string }
  let sqlTier = "unknown";
  let sqlDiskGb = "0";
  try {
    const sql = gcloudJson<SqlInstance>(`sql instances describe majel-pg --project ${PROJECT}`);
    sqlTier = sql.settings?.tier ?? "unknown";
    sqlDiskGb = sql.settings?.dataDiskSizeGb ?? "0";
  } catch { /* ignore */ }

  // Cloud Run pricing (us-central1, Tier 1)
  const CR_CPU_PER_SEC = 0.00002400;
  const CR_MEM_PER_GIB_SEC = 0.00000250;
  const HOURS_PER_MONTH = 730;

  const alwaysOnCpuCost = minInstances * cpu * HOURS_PER_MONTH * 3600 * CR_CPU_PER_SEC;
  const alwaysOnMemCost = minInstances * memoryGiB * HOURS_PER_MONTH * 3600 * CR_MEM_PER_GIB_SEC;
  const alwaysOnTotal = alwaysOnCpuCost + alwaysOnMemCost;

  const SQL_TIERS: Record<string, number> = {
    "db-f1-micro": 7.67,
    "db-g1-small": 25.55,
    "db-n1-standard-1": 51.10,
  };
  const sqlEstimate = SQL_TIERS[sqlTier] ?? 0;
  const sqlStorageCost = parseInt(sqlDiskGb) * 0.17;

  if (AX_MODE) {
    axOutput("costs", start, {
      cloudRun: {
        cpu, memoryMi, memoryGiB: +memoryGiB.toFixed(2),
        minInstances, maxInstances,
        alwaysOnEstimate: `$${alwaysOnTotal.toFixed(2)}/month`,
        note: minInstances === 0 ? "Scale-to-zero: $0 when idle" : `${minInstances} instance(s) always on`,
        pricing: { cpuPerSec: CR_CPU_PER_SEC, memPerGiBSec: CR_MEM_PER_GIB_SEC },
      },
      cloudSql: {
        tier: sqlTier,
        diskGb: parseInt(sqlDiskGb),
        instanceEstimate: `$${sqlEstimate.toFixed(2)}/month`,
        storageEstimate: `$${sqlStorageCost.toFixed(2)}/month`,
      },
      totalEstimate: `$${(alwaysOnTotal + sqlEstimate + sqlStorageCost).toFixed(2)}/month`,
      note: "Estimates based on published GCP pricing. Actual costs depend on request volume and execution time.",
    });
  } else {
    humanLog("\ud83d\udcb0 Cost Estimates");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog("  Cloud Run:");
    humanLog(`    CPU: ${cpu} vCPU  |  Memory: ${memoryRaw}`);
    humanLog(`    Scaling: ${minInstances}\u2013${maxInstances} instances`);
    if (minInstances === 0) {
      humanLog("    \ud83d\udca4 Scale-to-zero: $0.00/month when idle");
    } else {
      humanLog(`    Always-on (${minInstances} inst): ~$${alwaysOnTotal.toFixed(2)}/month`);
    }
    humanLog("  Cloud SQL:");
    humanLog(`    Tier: ${sqlTier}  |  Disk: ${sqlDiskGb} GB`);
    humanLog(`    Instance: ~$${sqlEstimate.toFixed(2)}/month  |  Storage: ~$${sqlStorageCost.toFixed(2)}/month`);
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  Estimated total: ~$${(alwaysOnTotal + sqlEstimate + sqlStorageCost).toFixed(2)}/month`);
    humanLog("  \u2139\ufe0f  + request-based Cloud Run costs, network egress, Cloud Build minutes");
  }
}

async function cmdWarm(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const nIdx = args.indexOf("-n");
  const count = nIdx >= 0 ? parseInt(args[nIdx + 1] ?? "3", 10) : 3;

  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);

  humanLog(`\ud83d\udd25 Warming ${count} request(s) to ${url}/api/health`);

  const results: Array<{ attempt: number; status: string; latencyMs: number }> = [];
  for (let i = 0; i < count; i++) {
    const t0 = Date.now();
    try {
      const code = runCapture(`curl -sf -o /dev/null -w '%{http_code}' ${url}/api/health --max-time 15`);
      results.push({ attempt: i + 1, status: code, latencyMs: Date.now() - t0 });
    } catch {
      results.push({ attempt: i + 1, status: "failed", latencyMs: Date.now() - t0 });
    }
    if (!AX_MODE) {
      const r = results[results.length - 1];
      humanLog(`  #${r.attempt}: ${r.status === "200" ? "\u2705" : "\u274c"} ${r.latencyMs}ms`);
    }
  }

  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length);
  const coldStart = results.length >= 2 && results[0].latencyMs > results[1].latencyMs * 3;

  if (AX_MODE) {
    axOutput("warm", start, {
      url: `${url}/api/health`,
      requests: results,
      avgLatencyMs: avgLatency,
      coldStartDetected: coldStart,
    }, {
      hints: coldStart ? ["Cold start detected \u2014 first request was 3x+ slower", "Set min-instances=1 to avoid: npm run cloud:scale -- --min 1"] : undefined,
    });
  } else {
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  Avg: ${avgLatency}ms${coldStart ? "  \u26a0\ufe0f  Cold start detected (first request 3x+ slower)" : ""}`);
    if (coldStart) {
      humanLog("  Tip: npm run cloud:scale -- --min 1");
    }
  }
}

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
    humanLog(`    -n <count>          Warmup requests (cloud:warm, default 3)`);
    humanLog(`\n  Examples:`);
    humanLog(`    npm run cloud:init                    # One-time auth setup`);
    humanLog(`    npm run cloud:deploy                  # Full deploy pipeline`);
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
    description: "Full pipeline: local-ci → build → deploy → health → idempotent canonical+crawler sync",
    args: [
      { name: "--skip-seed", type: "boolean", description: "Skip post-deploy DB sync steps" },
      { name: "--seed-feed", type: "string", description: "Feed ID/path for crawler sync (auto-discovered if omitted)" },
      { name: "--feeds-root", type: "string", description: "Feeds root when using feed IDs (default auto-detect)" },
      { name: "--retention-keep-runs", type: "integer", default: "10", description: "Runtime dataset retention window for feed load" },
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
  AX_MODE = args.includes("--ax") || args.includes("--json");

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
