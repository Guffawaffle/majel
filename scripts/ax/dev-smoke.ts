/**
 * ax/dev-smoke.ts — Smoke test against a running local server (ADR-050)
 *
 * Exercises key endpoints to verify the local stack is healthy.
 * Requires the dev server to be running with dev_local profile.
 */

import type { AxCommand, AxResult } from "./types.js";
import { makeResult, runCapture } from "./runner.js";

interface SmokeCheck {
  name: string;
  passed: boolean;
  detail?: Record<string, unknown>;
  error?: string;
}

async function httpGet(url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const result = runCapture("curl", ["-s", "-w", "\n%{http_code}", url], { ignoreExit: true });
  const lines = result.stdout.trim().split("\n");
  const status = parseInt(lines.pop() ?? "0", 10);
  const bodyStr = lines.join("\n");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(bodyStr); } catch { /* best-effort */ }
  return { ok: status >= 200 && status < 300, status, body };
}

async function httpPost(url: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const result = runCapture("curl", ["-s", "-w", "\n%{http_code}", "-X", "POST", "-H", "X-Requested-With: majel-client", url], { ignoreExit: true });
  const lines = result.stdout.trim().split("\n");
  const status = parseInt(lines.pop() ?? "0", 10);
  const bodyStr = lines.join("\n");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(bodyStr); } catch { /* best-effort */ }
  return { ok: status >= 200 && status < 300, status, body };
}

const command: AxCommand = {
  name: "dev:smoke",
  description: "Smoke test against a running local dev server",

  async run(_args): Promise<AxResult> {
    const start = Date.now();
    const port = process.env.MAJEL_PORT ?? "3000";
    const base = `http://localhost:${port}`;
    const checks: SmokeCheck[] = [];

    // ─── 1. Health check ──────────────────────────────────
    try {
      const { ok, status, body } = await httpGet(`${base}/api/health`);
      const data = (body as { data?: Record<string, unknown> }).data ?? body;
      checks.push({
        name: "health",
        passed: ok,
        detail: { status, profile: data.profile, gemini: data.gemini },
        ...(!ok ? { error: `Health returned ${status}` } : {}),
      });
    } catch {
      checks.push({ name: "health", passed: false, error: `Server not reachable at ${base}` });
      // If health fails, the rest will too — bail early
      return makeResult("dev:smoke", start, { checks, summary: "0/1 passed" }, {
        success: false,
        errors: ["Server not reachable — start with: npm run dev"],
      });
    }

    // ─── 2. Dev state ─────────────────────────────────────
    {
      const { ok, status, body } = await httpGet(`${base}/api/dev/state`);
      const data = (body as { data?: Record<string, unknown> }).data ?? body;
      checks.push({
        name: "dev:state",
        passed: ok,
        detail: { status, profile: data.profile, startupComplete: data.startupComplete },
        ...(!ok ? { error: `Dev state returned ${status}` } : {}),
      });
    }

    // ─── 3. Dev seed ──────────────────────────────────────
    {
      const { ok, status, body } = await httpPost(`${base}/api/dev/seed`);
      const data = (body as { data?: Record<string, unknown> }).data ?? body;
      checks.push({
        name: "dev:seed",
        passed: ok,
        detail: { status, seeded: data.seeded },
        ...(!ok ? { error: `Dev seed returned ${status}` } : {}),
      });
    }

    // ─── 4. Overlay read ──────────────────────────────────
    {
      const { ok, status, body } = await httpGet(`${base}/api/dev/overlay/local`);
      const data = (body as { data?: Record<string, unknown> }).data ?? body;
      checks.push({
        name: "dev:overlay",
        passed: ok,
        detail: { status, userId: data.userId },
        ...(!ok ? { error: `Overlay read returned ${status}` } : {}),
      });
    }

    // ─── 5. Chat/stub echo ────────────────────────────────
    {
      const chatResult = runCapture("curl", [
        "-s", "-w", "\n%{http_code}",
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-H", "X-Requested-With: majel-client",
        `${base}/api/chat`,
        "-d", JSON.stringify({ message: "smoke test" }),
      ], { ignoreExit: true });
      const lines = chatResult.stdout.trim().split("\n");
      const status = parseInt(lines.pop() ?? "0", 10);
      const bodyStr = lines.join("\n");
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(bodyStr); } catch { /* best-effort */ }
      const data = (body as { data?: Record<string, unknown> }).data ?? body;
      const passed = status === 200 || status === 503; // 503 is expected when provider=off
      checks.push({
        name: "chat",
        passed,
        detail: { status, hasAnswer: !!data.answer, providerOff: status === 503 },
        ...(!passed ? { error: `Chat returned ${status}` } : {}),
      });
    }

    // ─── Summary ──────────────────────────────────────────
    const passed = checks.filter((c) => c.passed).length;
    const total = checks.length;
    const allPassed = passed === total;

    return makeResult("dev:smoke", start, {
      checks,
      summary: `${passed}/${total} passed`,
    }, {
      success: allPassed,
      ...(!allPassed ? {
        errors: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.error}`),
      } : {}),
    });
  },
};

export default command;
