#!/usr/bin/env tsx
/**
 * cloud.ts — Majel Cloud Operations CLI
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Unified CLI for all cloud deploy/ops commands.
 * Supports --ax flag for AI-agent-friendly structured JSON output.
 *
 * Usage:
 *   npx tsx scripts/cloud.ts <command> [--ax] [--flags]
 *   npm run cloud:deploy          # Full build → push → deploy pipeline
 *   npm run cloud:build           # Build container image only
 *   npm run cloud:push            # Deploy already-built image to Cloud Run
 *   npm run cloud:logs            # Tail production logs
 *   npm run cloud:status          # Service status + revision info
 *   npm run cloud:health          # Hit production /api/health
 *   npm run cloud:secrets         # List Secret Manager secrets
 *   npm run cloud:ssh             # Open Cloud SQL proxy for psql
 *   npm run cloud:rollback        # Roll back to previous revision
 *   npm run cloud:env             # Show Cloud Run env + secret bindings
 *
 * @see docs/ADR-018-cloud-deployment.md
 */

import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// ─── Helpers ────────────────────────────────────────────────────

interface AxOutput {
  command: string;
  success: boolean;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  errors?: string[];
  hints?: string[];
}

let AX_MODE = false;

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

function run(cmd: string, opts?: { silent?: boolean; capture?: boolean }): string {
  try {
    const result = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: opts?.capture ? ["pipe", "pipe", "pipe"] : (opts?.silent ? ["pipe", "pipe", "pipe"] : "inherit"),
      timeout: 300_000, // 5 min max
    });
    return typeof result === "string" ? result.trim() : "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!AX_MODE && !opts?.silent) {
      console.error(`❌ Command failed: ${cmd}`);
      console.error(msg);
    }
    throw err;
  }
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
    humanError("❌ gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install");
    return false;
  }
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
      axOutput("deploy", start, { step: "local-ci", phase: "pre-flight" }, { success: false, errors: [msg] });
    } else {
      console.error(`❌ ${msg}`);
    }
    process.exit(1);
  }

  // Step 2: Build image
  humanLog("\n📦 Step 2/4: Building container image...");
  gcloud(`builds submit --tag ${IMAGE} --quiet`);

  // Step 3: Deploy to Cloud Run
  humanLog("\n☁️  Step 3/4: Deploying to Cloud Run...");
  gcloud(`run deploy ${SERVICE} --image ${IMAGE} --region ${REGION} --quiet`);

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
      axOutput("logs", start, { count: 0, entries: [] }, { errors: ["Failed to fetch logs"] });
    }
  } else {
    // Interactive streaming for humans
    humanLog(`📜 Tailing Cloud Run logs (Ctrl+C to stop)...`);
    const child = spawn("gcloud", [
      "run", "services", "logs", "tail", SERVICE,
      "--region", REGION,
    ], { stdio: "inherit" });
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
    }, { hints: ["Run the connectCommand in another terminal while the proxy is active"] });
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

async function cmdHelp(): Promise<void> {
  const start = Date.now();
  const commands = [
    { name: "deploy",   alias: "cloud:deploy",   description: "Full pipeline: local-ci → build → deploy → health check" },
    { name: "build",    alias: "cloud:build",     description: "Build container image via Cloud Build" },
    { name: "push",     alias: "cloud:push",      description: "Deploy already-built image to Cloud Run" },
    { name: "logs",     alias: "cloud:logs",      description: "Tail production logs (streaming for humans, batch for --ax)" },
    { name: "status",   alias: "cloud:status",    description: "Service status: URL, revision, scaling, resources" },
    { name: "health",   alias: "cloud:health",    description: "Hit production /api/health endpoint" },
    { name: "secrets",  alias: "cloud:secrets",   description: "List Secret Manager secrets (values never exposed)" },
    { name: "ssh",      alias: "cloud:ssh",       description: "Start Cloud SQL Auth Proxy for local psql access" },
    { name: "rollback", alias: "cloud:rollback",  description: "Roll back to previous Cloud Run revision" },
    { name: "env",      alias: "cloud:env",       description: "Show Cloud Run env vars and secret bindings" },
  ];

  if (AX_MODE) {
    axOutput("help", start, {
      service: SERVICE,
      project: PROJECT,
      region: REGION,
      image: IMAGE,
      commands,
      flags: [
        { name: "--ax", description: "Output structured JSON for AI agent consumption" },
        { name: "--json", description: "Alias for --ax" },
      ],
      usage: "npm run cloud:<command> [-- --ax]",
    });
  } else {
    humanLog("☁️  Majel Cloud Operations CLI");
    humanLog("────────────────────────────────────────");
    humanLog(`  Project: ${PROJECT}  |  Region: ${REGION}  |  Service: ${SERVICE}\n`);
    for (const cmd of commands) {
      humanLog(`  npm run ${cmd.alias.padEnd(16)} ${cmd.description}`);
    }
    humanLog(`\n  Flags:`);
    humanLog(`    --ax, --json    Output structured JSON for AI agents`);
    humanLog(`\n  Examples:`);
    humanLog(`    npm run cloud:deploy`);
    humanLog(`    npm run cloud:status -- --ax`);
    humanLog(`    npm run cloud:health -- --json | jq .data.response`);
  }
}

// ─── Main ───────────────────────────────────────────────────────

const COMMANDS: Record<string, () => Promise<void>> = {
  deploy: cmdDeploy,
  build: cmdBuild,
  push: cmdPush,
  logs: cmdLogs,
  status: cmdStatus,
  health: cmdHealth,
  secrets: cmdSecrets,
  ssh: cmdSsh,
  rollback: cmdRollback,
  env: cmdEnv,
  help: cmdHelp,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  AX_MODE = args.includes("--ax") || args.includes("--json");

  if (!command || command === "--help" || command === "-h" || command === "help") {
    await cmdHelp();
    return;
  }

  if (!COMMANDS[command]) {
    humanError(`❌ Unknown command: ${command}`);
    humanError(`   Run: npx tsx scripts/cloud.ts help`);
    process.exit(1);
  }

  if (!ensureGcloud()) {
    process.exit(1);
  }

  await COMMANDS[command]();
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
    }, null, 2));
  } else {
    console.error("💥 Unexpected error:", err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
