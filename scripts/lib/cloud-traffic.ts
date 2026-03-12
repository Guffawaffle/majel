/**
 * cloud-traffic.ts — Traffic management: revisions, scaling, rollback, canary, promote
 */

import {
  AX_MODE,
  IMAGE,
  REGION,
  SERVICE,
  axOutput,
  gcloud,
  gcloudCapture,
  gcloudJson,
  humanError,
  humanLog,
} from "./cloud-cli.js";

// ─── Commands ───────────────────────────────────────────────────

export async function cmdRevisions(): Promise<void> {
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

export async function cmdScale(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const minIdx = args.indexOf("--min");
  const maxIdx = args.indexOf("--max");
  const minArg = minIdx >= 0 ? args[minIdx + 1] : undefined;
  const maxArg = maxIdx >= 0 ? args[maxIdx + 1] : undefined;

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

export async function cmdRollback(): Promise<void> {
  const start = Date.now();

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

export async function cmdCanary(): Promise<void> {
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

export async function cmdPromote(): Promise<void> {
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
