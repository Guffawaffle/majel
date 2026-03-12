/**
 * cloud-monitoring.ts — Status, health, env, secrets, diff, metrics, costs, warm, ssh
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import {
  AX_MODE,
  CLOUD_SQL_INSTANCE,
  PROJECT,
  REGION,
  ROOT,
  SERVICE,
  axOutput,
  gcloudCapture,
  gcloudJson,
  getPackageVersion,
  humanError,
  humanLog,
  runCapture,
} from "./cloud-cli.js";

// ─── Commands ───────────────────────────────────────────────────

export async function cmdStatus(): Promise<void> {
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

export async function cmdHealth(): Promise<void> {
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

export async function cmdEnv(): Promise<void> {
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

export async function cmdSecrets(): Promise<void> {
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

export async function cmdSsh(): Promise<void> {
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
  const cleanup = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}

export async function cmdDiff(): Promise<void> {
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

export async function cmdMetrics(): Promise<void> {
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

export async function cmdCosts(): Promise<void> {
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

export async function cmdWarm(): Promise<void> {
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
