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

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

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

interface AxOutput {
  command: string;
  success: boolean;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  errors?: string[];
  hints?: string[];
}

type AuthTier = "open" | "read" | "write";

interface CommandDef {
  fn: () => Promise<void>;
  tier: AuthTier;
  description: string;
  alias: string;
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
  const output: AxOutput = {
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

/** Naive shell-split: respects single-quotes (for gcloud format flags). */
function shellSplit(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  for (const ch of cmd) {
    if (ch === "'" && !inSingleQuote) { inSingleQuote = true; continue; }
    if (ch === "'" && inSingleQuote) { inSingleQuote = false; continue; }
    if (ch === " " && !inSingleQuote) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
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

// ─── Commands ───────────────────────────────────────────────────

async function cmdDeploy(): Promise<void> {
  const start = Date.now();
  humanLog("🚀 Majel Cloud Deploy — Full Pipeline");
  humanLog("────────────────────────────────────────");

  // Step 1: Local CI
  humanLog("\n📋 Step 1/4: Running local CI...");
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
  humanLog("\n📦 Step 2/4: Building container image...");
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
  humanLog("\n☁️  Step 3/4: Deploying to Cloud Run...");
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
  humanLog("\n🏥 Step 4/4: Health check...");
  const url = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.url)'`);
  let healthOk = false;
  let healthData: Record<string, unknown> = {};
  try {
    const raw = runCapture(`curl -sf ${url}/api/health --max-time 10`);
    healthData = JSON.parse(raw);
    healthOk = true;
  } catch {
    healthOk = false;
  }

  if (AX_MODE) {
    const revision = gcloudCapture(`run services describe ${SERVICE} --region ${REGION} --format='value(status.latestReadyRevisionName)'`);
    axOutput("deploy", start, {
      url,
      revision,
      image: IMAGE,
      healthCheck: healthOk ? "pass" : "fail",
      health: healthData,
      version: getPackageVersion(),
    }, {
      success: healthOk,
      errors: healthOk ? undefined : ["Post-deploy health check failed"],
      hints: healthOk ? undefined : [`Check logs: npm run cloud:logs`, `Rollback: npm run cloud:rollback`],
    });
  } else {
    humanLog("\n────────────────────────────────────────");
    humanLog(healthOk ? `✅ Deploy complete! ${url}` : `⚠️  Deployed but health check failed. Check: npm run cloud:logs`);
  }
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

  // Check if cloud-sql-proxy is installed
  try {
    runCapture("which cloud-sql-proxy");
  } catch {
    humanError("❌ cloud-sql-proxy not found.");
    humanError("   Install: https://cloud.google.com/sql/docs/postgres/sql-proxy");
    humanError("   Or: gcloud components install cloud-sql-proxy");
    process.exit(1);
  }

  const child = spawn("cloud-sql-proxy", [
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
    const COMMAND_ARGS: Record<string, Array<{ name: string; type: string; default?: string; description: string }>> = {
      deploy: [],
      build: [],
      push: [],
      rollback: [],
      scale: [
        { name: "--min", type: "integer", default: "0", description: "Minimum instances (0 = scale to zero)" },
        { name: "--max", type: "integer", default: "cloud default", description: "Maximum instances" },
      ],
      canary: [
        { name: "--percent", type: "integer", default: "10", description: "Traffic percentage for canary revision" },
      ],
      promote: [
        { name: "<revision>", type: "string", description: "Revision name to route 100% traffic to" },
      ],
      ssh: [],
      status: [],
      health: [],
      logs: [],
      env: [],
      secrets: [],
      sql: [],
      revisions: [],
      diff: [],
      metrics: [],
      costs: [],
      warm: [
        { name: "-n", type: "integer", default: "3", description: "Number of warmup requests" },
      ],
      init: [
        { name: "--force", type: "boolean", description: "Overwrite existing .cloud-auth file" },
      ],
    };

    const commands = Object.entries(COMMANDS)
      .filter(([name]) => name !== "help")
      .map(([name, def]) => ({
        name,
        alias: def.alias,
        tier: def.tier,
        description: def.description,
        args: COMMAND_ARGS[name] ?? [],
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
  init:      { fn: cmdInit,      tier: "open",  alias: "cloud:init",      description: "Generate .cloud-auth token (chmod 600, gitignored)" },
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
  warm:      { fn: cmdWarm,      tier: "read",  alias: "cloud:warm",      description: "Send warmup pings to detect cold starts" },
  // Tier: write (requires .cloud-auth)
  deploy:    { fn: cmdDeploy,    tier: "write", alias: "cloud:deploy",    description: "Full pipeline: local-ci \u2192 build \u2192 deploy \u2192 health check" },
  build:     { fn: cmdBuild,     tier: "write", alias: "cloud:build",     description: "Build container image via Cloud Build" },
  push:      { fn: cmdPush,      tier: "write", alias: "cloud:push",      description: "Deploy already-built image to Cloud Run" },
  rollback:  { fn: cmdRollback,  tier: "write", alias: "cloud:rollback",  description: "Roll back to previous Cloud Run revision" },
  scale:     { fn: cmdScale,     tier: "write", alias: "cloud:scale",     description: "View/set min-max instance scaling" },
  canary:    { fn: cmdCanary,    tier: "write", alias: "cloud:canary",    description: "Deploy with partial traffic (default 10%)" },
  promote:   { fn: cmdPromote,   tier: "write", alias: "cloud:promote",   description: "Route 100% traffic to a specific revision" },
  ssh:       { fn: cmdSsh,       tier: "write", alias: "cloud:ssh",       description: "Start Cloud SQL Auth Proxy for local psql" },
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
