/**
 * ax/dev-live.ts — Live model scenario tests against a running server.
 *
 * Runs real HTTP requests against localhost with a real Gemini provider.
 * Each scenario validates a specific behavior: identity, tool use,
 * session continuity, error handling, and output hygiene.
 *
 * Prerequisites:
 *   - Server running: MAJEL_DEV_PROVIDER=real npm run dev
 *   - GEMINI_API_KEY set in environment (server-side)
 *
 * Usage:
 *   npm run ax -- dev:live                   # Run all scenarios
 *   npm run ax -- dev:live --scenario=greeting
 *   npm run ax -- dev:live --timeout=30000
 */

import { randomUUID } from "node:crypto";
import type { AxCommand, AxResult } from "./types.js";
import { makeResult, runCapture, getFlag } from "./runner.js";

// ─── Types ──────────────────────────────────────────────────────

interface ScenarioResult {
  name: string;
  passed: boolean;
  durationMs: number;
  detail?: Record<string, unknown>;
  error?: string;
}

interface ChatResponse {
  ok: boolean;
  status: number;
  answer?: string;
  runId?: string;
  body: Record<string, unknown>;
}

// ─── HTTP helpers ───────────────────────────────────────────────

function chatPost(
  base: string,
  message: string,
  sessionId: string,
  timeoutMs: number,
): ChatResponse {
  const result = runCapture("curl", [
    "-s",
    "-w", "\n%{http_code}",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", "X-Requested-With: majel-client",
    "-H", `X-Session-Id: ${sessionId}`,
    "--max-time", String(Math.ceil(timeoutMs / 1000)),
    `${base}/api/chat`,
    "-d", JSON.stringify({ message }),
  ], { ignoreExit: true });

  const lines = result.stdout.trim().split("\n");
  const status = parseInt(lines.pop() ?? "0", 10);
  const bodyStr = lines.join("\n");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(bodyStr); } catch { /* best-effort */ }
  const data = (body as { data?: Record<string, unknown> }).data ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    answer: typeof data.answer === "string" ? data.answer : undefined,
    runId: typeof data.runId === "string" ? data.runId : undefined,
    body,
  };
}

function healthCheck(base: string): { ok: boolean; providerMode?: string } {
  const result = runCapture("curl", [
    "-s", "-w", "\n%{http_code}",
    "--max-time", "5",
    `${base}/api/health`,
  ], { ignoreExit: true });
  const lines = result.stdout.trim().split("\n");
  const status = parseInt(lines.pop() ?? "0", 10);
  const bodyStr = lines.join("\n");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(bodyStr); } catch { /* best-effort */ }
  const data = (body as { data?: Record<string, unknown> }).data ?? body;
  return {
    ok: status >= 200 && status < 300,
    providerMode: typeof data.gemini === "string" ? data.gemini : undefined,
  };
}

// ─── Assertion helpers ──────────────────────────────────────────

function assertContains(text: string, substring: string): boolean {
  return text.toLowerCase().includes(substring.toLowerCase());
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return true;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return true;
  // Check for JSON-like field patterns (e.g. "answer": "...")
  if (/^\s*"[^"]+"\s*:/.test(trimmed)) return true;
  return false;
}

// ─── Scenarios ──────────────────────────────────────────────────

type ScenarioFn = (base: string, timeoutMs: number) => ScenarioResult;

/** Greeting: verify Aria identity */
function scenarioGreeting(base: string, timeoutMs: number): ScenarioResult {
  const start = Date.now();
  const session = `live-greeting-${randomUUID()}`;
  const resp = chatPost(base, "Hello, who are you?", session, timeoutMs);

  if (!resp.ok) {
    return { name: "greeting", passed: false, durationMs: Date.now() - start,
      detail: { status: resp.status }, error: `Chat returned ${resp.status}` };
  }
  if (!resp.answer) {
    return { name: "greeting", passed: false, durationMs: Date.now() - start,
      detail: { body: resp.body }, error: "No answer field in response" };
  }

  const hasIdentity = assertContains(resp.answer, "aria") ||
    assertContains(resp.answer, "fleet intelligence") ||
    assertContains(resp.answer, "assistant");

  return {
    name: "greeting",
    passed: hasIdentity,
    durationMs: Date.now() - start,
    detail: {
      answerLength: resp.answer.length,
      hasIdentity,
      answerPreview: resp.answer.slice(0, 200),
    },
    ...(!hasIdentity ? { error: "Response did not contain Aria identity markers" } : {}),
  };
}

/** JSON leak: verify no raw JSON in conversational answer */
function scenarioJsonLeak(base: string, timeoutMs: number): ScenarioResult {
  const start = Date.now();
  const session = `live-jsonleak-${randomUUID()}`;

  // Send a message that could trigger tool use + structured output
  const resp = chatPost(base, "What can you help me with? Give me a brief overview.", session, timeoutMs);

  if (!resp.ok) {
    return { name: "json-leak", passed: false, durationMs: Date.now() - start,
      detail: { status: resp.status }, error: `Chat returned ${resp.status}` };
  }
  if (!resp.answer) {
    return { name: "json-leak", passed: false, durationMs: Date.now() - start,
      detail: { body: resp.body }, error: "No answer field in response" };
  }

  const isJsonLeak = looksLikeJson(resp.answer);

  return {
    name: "json-leak",
    passed: !isJsonLeak,
    durationMs: Date.now() - start,
    detail: {
      answerLength: resp.answer.length,
      looksLikeJson: isJsonLeak,
      answerPreview: resp.answer.slice(0, 200),
    },
    ...(isJsonLeak ? { error: "Answer appears to be raw JSON — possible leak" } : {}),
  };
}

/** Fleet query: verify tool call triggers data retrieval */
function scenarioFleetQuery(base: string, timeoutMs: number): ScenarioResult {
  const start = Date.now();
  const session = `live-fleet-${randomUUID()}`;
  const resp = chatPost(base, "Show me my fleet. What ships do I have?", session, timeoutMs);

  if (!resp.ok) {
    return { name: "fleet-query", passed: false, durationMs: Date.now() - start,
      detail: { status: resp.status }, error: `Chat returned ${resp.status}` };
  }
  if (!resp.answer) {
    return { name: "fleet-query", passed: false, durationMs: Date.now() - start,
      detail: { body: resp.body }, error: "No answer field in response" };
  }

  // The response should reference ships/fleet/vessels and not be raw JSON
  const mentionsFleet = assertContains(resp.answer, "ship") ||
    assertContains(resp.answer, "fleet") ||
    assertContains(resp.answer, "vessel");
  const isJsonLeak = looksLikeJson(resp.answer);
  const passed = mentionsFleet && !isJsonLeak;

  return {
    name: "fleet-query",
    passed,
    durationMs: Date.now() - start,
    detail: {
      answerLength: resp.answer.length,
      mentionsFleet,
      looksLikeJson: isJsonLeak,
      hasRunId: !!resp.runId,
      answerPreview: resp.answer.slice(0, 300),
    },
    ...(!passed ? { error: !mentionsFleet ? "No fleet/ship mentions in response" : "Raw JSON in answer" } : {}),
  };
}

/** Multi-turn: verify session continuity across 3 turns */
function scenarioMultiTurn(base: string, timeoutMs: number): ScenarioResult {
  const start = Date.now();
  const session = `live-multiturn-${randomUUID()}`;
  const perTurnTimeout = Math.floor(timeoutMs / 3);

  // Turn 1: establish context
  const t1 = chatPost(base, "My favorite ship is the Enterprise. Remember that.", session, perTurnTimeout);
  if (!t1.ok || !t1.answer) {
    return { name: "multi-turn", passed: false, durationMs: Date.now() - start,
      detail: { turn: 1, status: t1.status }, error: `Turn 1 failed: ${t1.status}` };
  }

  // Turn 2: ask about something else (maintain session)
  const t2 = chatPost(base, "What's your role as a fleet intelligence system?", session, perTurnTimeout);
  if (!t2.ok || !t2.answer) {
    return { name: "multi-turn", passed: false, durationMs: Date.now() - start,
      detail: { turn: 2, status: t2.status }, error: `Turn 2 failed: ${t2.status}` };
  }

  // Turn 3: recall from turn 1
  const t3 = chatPost(base, "What's my favorite ship? (the one I told you about)", session, perTurnTimeout);
  if (!t3.ok || !t3.answer) {
    return { name: "multi-turn", passed: false, durationMs: Date.now() - start,
      detail: { turn: 3, status: t3.status }, error: `Turn 3 failed: ${t3.status}` };
  }

  const recalledShip = assertContains(t3.answer, "enterprise");

  return {
    name: "multi-turn",
    passed: recalledShip,
    durationMs: Date.now() - start,
    detail: {
      turns: 3,
      recalledShip,
      turn1Preview: t1.answer.slice(0, 100),
      turn3Preview: t3.answer.slice(0, 200),
    },
    ...(!recalledShip ? { error: "Turn 3 did not recall 'Enterprise' from turn 1" } : {}),
  };
}

/** Error boundary: verify graceful handling of edge-case input */
function scenarioErrorBoundary(base: string, timeoutMs: number): ScenarioResult {
  const start = Date.now();
  const session = `live-error-${randomUUID()}`;

  // Send an extremely long repetitive message (but within the 10k limit)
  const longMsg = "Tell me about this: " + "x".repeat(9000);
  const resp = chatPost(base, longMsg, session, timeoutMs);

  // We accept 200 (graceful response) or 400 (validation rejection) - both are correct
  const isGraceful = resp.status === 200 || resp.status === 400;
  const hasStructuredError = !resp.ok && typeof (resp.body as { error?: unknown }).error === "object";
  const passed = isGraceful && (resp.ok || hasStructuredError);

  return {
    name: "error-boundary",
    passed,
    durationMs: Date.now() - start,
    detail: {
      status: resp.status,
      isGraceful,
      hasAnswer: !!resp.answer,
      hasStructuredError,
    },
    ...(!passed ? { error: `Unexpected response: status=${resp.status}, structured=${hasStructuredError}` } : {}),
  };
}

// ─── Scenario registry ─────────────────────────────────────────

const SCENARIOS: Record<string, ScenarioFn> = {
  "greeting": scenarioGreeting,
  "json-leak": scenarioJsonLeak,
  "fleet-query": scenarioFleetQuery,
  "multi-turn": scenarioMultiTurn,
  "error-boundary": scenarioErrorBoundary,
};

// ─── Command ────────────────────────────────────────────────────

const command: AxCommand = {
  name: "dev:live",
  description: "Live model scenario tests against a running server (requires real Gemini)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const port = process.env.MAJEL_PORT ?? "3000";
    const base = `http://localhost:${port}`;
    const timeoutMs = parseInt(getFlag(args, "timeout") ?? "60000", 10);
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      return makeResult("dev:live", start, {}, {
        success: false,
        errors: [`Invalid timeout value: ${getFlag(args, "timeout")}`],
        hints: ["Use: --timeout=60000 (milliseconds)"],
      });
    }
    const scenarioFilter = getFlag(args, "scenario");

    // ─── Gate: server must be reachable ───────────────────
    const health = healthCheck(base);
    if (!health.ok) {
      return makeResult("dev:live", start, {}, {
        success: false,
        errors: [`Server not reachable at ${base}`],
        hints: ["Start with: MAJEL_DEV_PROVIDER=real npm run dev"],
      });
    }

    // ─── Gate: provider must be connected (real Gemini) ───
    if (health.providerMode !== "connected") {
      return makeResult("dev:live", start, { providerMode: health.providerMode }, {
        success: false,
        errors: [`Gemini engine not connected (status: "${health.providerMode}") — dev:live requires a live engine`],
        hints: ["Start with: MAJEL_DEV_PROVIDER=real npm run dev"],
      });
    }

    // ─── Select scenarios ─────────────────────────────────
    let scenarioNames = Object.keys(SCENARIOS);
    if (scenarioFilter) {
      if (!SCENARIOS[scenarioFilter]) {
        return makeResult("dev:live", start, {
          available: Object.keys(SCENARIOS),
        }, {
          success: false,
          errors: [`Unknown scenario: "${scenarioFilter}"`],
          hints: [`Available: ${Object.keys(SCENARIOS).join(", ")}`],
        });
      }
      scenarioNames = [scenarioFilter];
    }

    // ─── Run scenarios sequentially ───────────────────────
    const results: ScenarioResult[] = [];
    for (const name of scenarioNames) {
      const fn = SCENARIOS[name];
      try {
        const result = fn(base, timeoutMs);
        results.push(result);
      } catch (err) {
        results.push({
          name,
          passed: false,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ─── Summary ──────────────────────────────────────────
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    const allPassed = passed === total;
    const totalDurationMs = results.reduce((acc, r) => acc + r.durationMs, 0);

    return makeResult("dev:live", start, {
      scenarios: results,
      summary: `${passed}/${total} passed`,
      totalScenarioDurationMs: totalDurationMs,
      providerMode: health.providerMode,
    }, {
      success: allPassed,
      ...(!allPassed ? {
        errors: results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.error}`),
      } : {}),
    });
  },
};

export default command;
