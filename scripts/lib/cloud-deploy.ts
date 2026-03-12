/**
 * cloud-deploy.ts — Deploy pipeline, build, push, smoke checks, feed discovery
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AX_MODE,
  type DeploySmokeCheck,
  IMAGE,
  REGION,
  ROOT,
  SERVICE,
  axOutput,
  gcloud,
  gcloudCapture,
  getFlagValue,
  getPackageVersion,
  humanError,
  humanLog,
  run,
  runCapture,
} from "./cloud-cli.js";
import { getCloudDbUrl, runCanonicalSeedScript } from "./cloud-sql.js";

// ─── Smoke Checks ───────────────────────────────────────────────

export function runDeploySmokeChecks(baseUrl: string): { pass: boolean; checks: DeploySmokeCheck[] } {
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

// ─── Feed Discovery ─────────────────────────────────────────────

export function findLatestFeedRun(feedsRoot: string): string | null {
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

export function resolveDeployFeedSelection(input: {
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

  throw new Error("No feed export found for deploy ingest. Provide --seed-feed <feedId-or-path> and optionally --feeds-root <path>.");
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
        step: "feed-ingest",
        feedPath: options.feedPath,
        feedsRoot: options.feedsRoot,
      }, {
        success: false,
        errors: ["Feed ingest failed", result.stderr || "Unknown error"],
        hints: [
          "Verify feed path has feed.json",
          "Try explicit feed: npm run cloud:deploy -- --seed-feed <feedId-or-path> --feeds-root <path>",
        ],
      });
    } else {
      humanError("❌ Feed ingest failed");
      humanError(`   feed=${options.feedPath}`);
      humanError(`   feedsRoot=${options.feedsRoot}`);
    }
    process.exit(1);
  }

  return { output: result.stdout || "" };
}

// ─── Commands ───────────────────────────────────────────────────

export async function cmdDeploy(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const skipSeed = args.includes("--skip-seed");
  const runCanonicalSeed = args.includes("--run-canonical-seed") || args.includes("--run-cdn");
  const skipIngest = args.includes("--skip-ingest");
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
    // Step 5: Optional canonical snapshot seed
    if (runCanonicalSeed) {
      humanLog("\n🌱 Step 5/7: Seeding canonical reference data (idempotent upsert)...");
      const canonicalSeed = runCanonicalSeedScript(start, "deploy");
      canonicalSeedOutput = canonicalSeed.output;
    } else {
      humanLog("\n⏭️  Step 5/7: Skipped canonical snapshot seed (pass --run-canonical-seed to enable)");
    }

    // Step 6: Ingest latest feed export
    if (!skipIngest) {
      humanLog("\n🧩 Step 6/7: Ingesting latest feed export (idempotent add/update)...");
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
    } else {
      humanLog("\n⏭️  Step 6/7: Skipped feed ingest (pass no flag, or remove --skip-ingest, to enable)");
    }
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
        canonicalApplied: healthOk && !skipSeed && runCanonicalSeed,
        ingestApplied: healthOk && !skipSeed && !skipIngest,
        canonicalSeedFlagPassed: runCanonicalSeed,
        ingestSkipped: skipIngest,
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
    if (skipIngest && !runCanonicalSeed) {
      humanLog(`✅ Deploy complete (post-deploy ingest skipped). ${url}`);
      humanLog(`   Feed ingest runs by default; use --run-canonical-seed if you also want snapshot seed.`);
      return;
    }
    humanLog(`✅ Deploy + requested data sync complete! ${url}`);
    if (seededFeedPath) {
      humanLog(`   Feed loaded: ${seededFeedPath} (${seededFeedSource})`);
    }
  }
}

export async function cmdBuild(): Promise<void> {
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

export async function cmdPush(): Promise<void> {
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
