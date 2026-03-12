/**
 * cloud-logs.ts — Log triage, streaming, and bundle generation
 */

import { spawn } from "node:child_process";
import {
  AX_MODE,
  PROJECT,
  REGION,
  SERVICE,
  axOutput,
  clampInt,
  gcloudCapture,
  getFlagValue,
  humanError,
  humanLog,
} from "./cloud-cli.js";

// ─── Types ──────────────────────────────────────────────────────

interface TriageEntry {
  timestamp?: string;
  severity?: string;
  message: string;
  event?: string;
  subsystem?: string;
  runId?: string;
  traceId?: string;
  requestId?: string;
}

interface TriageInput {
  traceId?: string;
  runId?: string;
  requestId?: string;
  minutes: number;
  limit: number;
}

interface TriageReport {
  query: string;
  input: TriageInput;
  entries: TriageEntry[];
  severityCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  nextActions: string[];
}

// ─── Helpers ────────────────────────────────────────────────────

function parseTriageInput(args: string[]): TriageInput {
  const traceId = getFlagValue(args, "trace-id") || getFlagValue(args, "trace") || undefined;
  const runId = getFlagValue(args, "run-id") || getFlagValue(args, "run") || undefined;
  const requestId = getFlagValue(args, "request-id") || getFlagValue(args, "request") || undefined;
  const minutesRaw = parseInt(getFlagValue(args, "minutes") || "60", 10);
  const limitRaw = parseInt(getFlagValue(args, "limit") || "200", 10);

  return {
    traceId,
    runId,
    requestId,
    minutes: clampInt(Number.isNaN(minutesRaw) ? 60 : minutesRaw, 5, 360),
    limit: clampInt(Number.isNaN(limitRaw) ? 200 : limitRaw, 20, 500),
  };
}

function buildTriageMarkdown(report: TriageReport): string {
  const { input, entries, severityCounts, eventCounts, nextActions } = report;
  const lines: string[] = [];
  lines.push("# Majel Cloud Triage Bundle");
  lines.push("");
  lines.push(`- Window: last ${input.minutes} minute(s)`);
  lines.push(`- Limit: ${input.limit}`);
  lines.push(`- Matches: ${entries.length}${entries.length >= input.limit ? " (limit reached)" : ""}`);
  if (input.traceId) lines.push(`- traceId: ${input.traceId}`);
  if (input.runId) lines.push(`- runId: ${input.runId}`);
  if (input.requestId) lines.push(`- requestId: ${input.requestId}`);
  lines.push("");
  lines.push("## Severity");
  for (const [k, v] of Object.entries(severityCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("");
  lines.push("## Top Events");
  for (const [event, count] of Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    lines.push(`- ${event}: ${count}`);
  }
  lines.push("");
  lines.push("## Recent Entries");
  for (const entry of entries.slice(0, 20)) {
    lines.push(`- [${entry.timestamp ?? "unknown"}] ${entry.severity ?? "INFO"} ${entry.subsystem ?? "-"} ${entry.event ?? "-"} ${entry.message}`);
  }
  lines.push("");
  lines.push("## Next Actions");
  for (const step of nextActions) {
    lines.push(`- ${step}`);
  }
  return lines.join("\n");
}

function buildTriageReport(input: TriageInput): TriageReport {
  const baseFilter = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${SERVICE}"`,
  ];

  const idFilters: string[] = [];
  if (input.traceId) {
    idFilters.push(`jsonPayload.traceId="${input.traceId}"`);
  }
  if (input.requestId) {
    idFilters.push(`jsonPayload.requestId="${input.requestId}"`);
  }
  if (input.runId) {
    idFilters.push(`jsonPayload.runId="${input.runId}"`);
    idFilters.push(`jsonPayload.operationId="${input.runId}"`);
    idFilters.push(`jsonPayload.id="${input.runId}"`);
  }

  const query = `${baseFilter.join(" AND ")} AND (${idFilters.join(" OR ")})`;
  const escapedQuery = query.replace(/'/g, `'"'"'`);

  type RawLog = {
    timestamp?: string;
    severity?: string;
    textPayload?: string;
    jsonPayload?: Record<string, unknown>;
  };

  const raw = gcloudCapture(
    `logging read '${escapedQuery}' --project ${PROJECT} --freshness=${input.minutes}m --limit ${input.limit} --order=desc --format=json`,
  );
  const rawEntries = JSON.parse(raw) as RawLog[];

  const entries: TriageEntry[] = rawEntries.map((entry) => {
    const payload = entry.jsonPayload ?? {};
    const message = (payload.message as string | undefined) ?? entry.textPayload ?? "";
    return {
      timestamp: entry.timestamp,
      severity: entry.severity,
      message,
      event: payload.event as string | undefined,
      subsystem: payload.subsystem as string | undefined,
      runId: (payload.runId as string | undefined) ?? (payload.operationId as string | undefined),
      traceId: payload.traceId as string | undefined,
      requestId: payload.requestId as string | undefined,
    };
  });

  const severityCounts = entries.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.severity || "UNKNOWN";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const eventCounts = entries.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.event || "(none)";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const hasErrors = entries.some((entry) => ["ERROR", "CRITICAL"].includes(entry.severity ?? ""));
  const nextActions = hasErrors
    ? [
        "Inspect top ERROR/CRITICAL entries first",
        "Follow traceId/requestId through app + worker events",
        "If claim loop errors repeat, check chat_run.requeue_stale + Cloud SQL health",
      ]
    : [
        "No high-severity logs in current window",
        "Expand window gradually: --minutes 120 then 240",
        "Keep limit <= 500 to control query/read overhead",
      ];

  return { query, input, entries, severityCounts, eventCounts, nextActions };
}

// ─── Commands ───────────────────────────────────────────────────

export async function cmdLogs(): Promise<void> {
  const start = Date.now();
  const limit = AX_MODE ? "50" : "100";

  if (AX_MODE) {
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
    humanLog(`📜 Tailing Cloud Run logs (Ctrl+C to stop)...`);
    const child = spawn("gcloud", [
      "run", "services", "logs", "tail", SERVICE,
      "--region", REGION,
    ], { stdio: "inherit" });
    const cleanup = () => { child.kill(); process.exit(0); };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    child.on("exit", (code) => process.exit(code ?? 0));
    await new Promise(() => {});
  }
}

export async function cmdTriage(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const input = parseTriageInput(args);
  const { traceId, runId, requestId, minutes, limit } = input;

  if (!traceId && !runId && !requestId) {
    const hints = [
      "Pass at least one identifier: --run-id, --trace-id, or --request-id",
      "Example: npm run cloud:triage -- --run-id crun_...",
      "Use small windows first (default 60m) to reduce query cost and noise",
    ];
    if (AX_MODE) {
      axOutput("triage", start, {}, { success: false, errors: ["Missing triage identifier"], hints });
    } else {
      humanError("❌ Missing triage identifier");
      for (const hint of hints) humanError(`   - ${hint}`);
    }
    return;
  }

  let report: TriageReport;
  try {
    report = buildTriageReport(input);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (AX_MODE) {
      axOutput("triage", start, { minutes, limit }, {
        success: false,
        errors: ["Failed to read Cloud Logging entries", errMessage],
        hints: ["Ensure roles/logging.viewer", "Check gcloud auth and project access", `Try a wider window: --minutes ${Math.min(360, minutes * 2)}`],
      });
    } else {
      humanError("❌ Failed to read Cloud Logging entries");
      humanError(`   ${errMessage}`);
    }
    return;
  }
  const { query, entries, severityCounts: bySeverity, eventCounts: byEvent, nextActions } = report;

  if (AX_MODE) {
    axOutput("triage", start, {
      query,
      inputs: { traceId: traceId ?? null, runId: runId ?? null, requestId: requestId ?? null },
      windowMinutes: minutes,
      limit,
      count: entries.length,
      maxResultsHit: entries.length >= limit,
      severityCounts: bySeverity,
      eventCounts: byEvent,
      entries: entries.slice(0, 100),
      costGuardrails: {
        defaultWindowMinutes: 60,
        maxWindowMinutes: 360,
        defaultLimit: 200,
        maxLimit: 500,
        note: "Cloud Logging read volume/noise increases with broader windows and higher limits; start narrow and widen only if needed.",
      },
      nextActions,
    }, {
      hints: entries.length >= limit ? ["Result limit reached; refine IDs or increase --limit carefully"] : undefined,
    });
    return;
  }

  humanLog("🔎 Cloud Triage");
  humanLog("────────────────────────────────────────");
  humanLog(`  Window:    last ${minutes} minute(s)`);
  humanLog(`  Limit:     ${limit}`);
  humanLog(`  Matches:   ${entries.length}${entries.length >= limit ? " (limit reached)" : ""}`);
  if (traceId) humanLog(`  traceId:   ${traceId}`);
  if (runId) humanLog(`  runId:     ${runId}`);
  if (requestId) humanLog(`  requestId: ${requestId}`);
  humanLog(`  Severity:  ${Object.entries(bySeverity).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}`);

  humanLog("\n  Top events:");
  for (const [event, count] of Object.entries(byEvent).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    humanLog(`    - ${event}: ${count}`);
  }

  humanLog("\n  Recent entries:");
  for (const entry of entries.slice(0, 12)) {
    humanLog(`    [${entry.timestamp ?? "unknown"}] ${entry.severity ?? "INFO"} ${entry.subsystem ?? "-"} ${entry.event ?? "-"} ${entry.message}`);
  }

  humanLog("\n  Next actions:");
  for (const step of nextActions) {
    humanLog(`    - ${step}`);
  }
}

export async function cmdTriageBundle(): Promise<void> {
  const start = Date.now();
  const args = process.argv.slice(2);
  const input = parseTriageInput(args);

  if (!input.traceId && !input.runId && !input.requestId) {
    const hints = [
      "Pass at least one identifier: --run-id, --trace-id, or --request-id",
      "Example: npm run cloud:triage:bundle -- --run-id crun_...",
      "Use small windows first (default 60m) to reduce query cost and noise",
    ];
    if (AX_MODE) {
      axOutput("triage:bundle", start, {}, { success: false, errors: ["Missing triage identifier"], hints });
    } else {
      humanError("❌ Missing triage identifier");
      for (const hint of hints) humanError(`   - ${hint}`);
    }
    return;
  }

  let report: TriageReport;
  try {
    report = buildTriageReport(input);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (AX_MODE) {
      axOutput("triage:bundle", start, { input }, {
        success: false,
        errors: ["Failed to build triage bundle", errMessage],
        hints: ["Ensure roles/logging.viewer", "Check gcloud auth and project access"],
      });
    } else {
      humanError("❌ Failed to build triage bundle");
      humanError(`   ${errMessage}`);
    }
    return;
  }

  const markdown = buildTriageMarkdown(report);

  if (AX_MODE) {
    axOutput("triage:bundle", start, {
      query: report.query,
      input: report.input,
      count: report.entries.length,
      severityCounts: report.severityCounts,
      eventCounts: report.eventCounts,
      nextActions: report.nextActions,
      markdown,
      costGuardrails: {
        defaultWindowMinutes: 60,
        maxWindowMinutes: 360,
        defaultLimit: 200,
        maxLimit: 500,
      },
    });
    return;
  }

  humanLog(markdown);
}
