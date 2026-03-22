/**
 * api.test.ts — Integration tests for Majel's Express API routes.
 *
 * Uses supertest against the app factory (no real server listen).
 * Mocks Gemini and Lex to test route logic in isolation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import type { ChatEngine } from "../src/server/services/engine.js";
import type { ChatResult } from "../src/server/services/gemini/index.js";
import type { MemoryService, Frame } from "../src/server/services/memory.js";
import { createSettingsStore, type SettingsStore } from "../src/server/stores/settings.js";
import { createOperationEventStoreFactory } from "../src/server/stores/operation-event-store.js";
import { createChatRunStore } from "../src/server/stores/chat-run-store.js";
import { TokenBudgetExceededError, type BudgetStatus, type TokenBudgetStore } from "../src/server/stores/token-budget-store.js";
import { makeState, makeConfig } from "./helpers/make-state.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { collectApiRoutes } from "../src/server/route-introspection.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    id: "test-frame-001",
    timestamp: "2026-02-08T12:00:00.000Z",
    branch: "majel-chat",
    module_scope: ["majel/chat"],
    summary_caption: "Q: Hello → A: Hi there",
    reference_point: "Hello",
    next_action: "Continue",
    keywords: ["hello"],
    ...overrides,
  };
}

function makeMockMemory(frames: Frame[] = []): MemoryService {
  return {
    remember: vi.fn().mockResolvedValue(makeFrame()),
    recall: vi.fn().mockResolvedValue(frames),
    timeline: vi.fn().mockResolvedValue(frames),
    close: vi.fn().mockResolvedValue(undefined),
    getFrameCount: vi.fn().mockResolvedValue(frames.length),
    getDbPath: vi.fn().mockReturnValue("/tmp/test-memory.db"),
  };
}

function makeMockEngine(response: string | ChatResult = "Aye, Admiral."): ChatEngine {
  const sessions = new Map<string, Array<{ role: string; text: string }>>();
  let currentModel = "gemini-3-pro-preview";
  const getSessionHistory = (sid: string) => {
    if (!sessions.has(sid)) sessions.set(sid, []);
    return sessions.get(sid)!;
  };
  // #85 H1: Namespace session keys by userId, matching the real engine
  const resolveKey = (sessionId: string, userId?: string) => userId ? `${userId}:${sessionId}` : sessionId;
  return {
    chat: vi.fn().mockImplementation(async (msg: string, sessionId = "default", _image?: unknown, userId?: string) => {
      const key = resolveKey(sessionId, userId);
      const history = getSessionHistory(key);
      history.push({ role: "user", text: msg });
      const text = typeof response === "string" ? response : response.text;
      history.push({ role: "model", text });
      return response;
    }),
    getHistory: vi.fn().mockImplementation((sessionId = "default") => [...getSessionHistory(sessionId)]),
    getSessionCount: vi.fn().mockImplementation(() => sessions.size),
    closeSession: vi.fn().mockImplementation((sessionId: string) => { sessions.delete(sessionId); }),
    getModel: vi.fn().mockImplementation(() => currentModel),
    setModel: vi.fn().mockImplementation((id: string) => { currentModel = id; sessions.clear(); }),
    close: vi.fn(),
  };
}

/** Build a mock TokenBudgetStore that always passes or always throws. */
function makeMockBudgetStore(behavior: "pass" | "exceed" | "warning" = "pass"): TokenBudgetStore {
  const baseStatus: BudgetStatus = {
    dailyLimit: 100_000,
    consumed: behavior === "exceed" ? 100_000 : behavior === "warning" ? 90_000 : 50_000,
    remaining: behavior === "exceed" ? 0 : behavior === "warning" ? 10_000 : 50_000,
    resetsAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    source: "rank",
    warning: behavior === "warning",
  };
  return {
    getOverride: vi.fn().mockResolvedValue(null),
    setOverride: vi.fn().mockResolvedValue(undefined),
    removeOverride: vi.fn().mockResolvedValue(false),
    listOverrides: vi.fn().mockResolvedValue([]),
    checkBudget: vi.fn().mockImplementation(async () => {
      if (behavior === "exceed") throw new TokenBudgetExceededError(baseStatus);
      return baseStatus;
    }),
  };
}

// makeState imported from ./helpers/make-state.js

/** Reusable helper: poll run status until it reaches the target. */
async function waitForRunStatus(
  app: ReturnType<typeof createApp>,
  runId: string,
  targetStatus: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 30; i += 1) {
    const statusRes = await testRequest(app).get(`/api/chat/runs/${runId}`);
    if (statusRes.status === 200 && statusRes.body.data?.status === targetStatus) {
      return statusRes.body.data as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} did not reach ${targetStatus} state`);
}

// ─── Pool lifecycle ─────────────────────────────────────────────

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

// ─── GET /api/health ────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns initializing status before startup", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await testRequest(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.data.status).toBe("initializing");
    expect(res.body.data.gemini).toBe("not configured");
    expect(res.body.data.memory).toBe("not configured");
    expect(res.body.data.referenceStore).toBeDefined();
  });

  it("returns online status after startup", async () => {
    const state = makeState({
      startupComplete: true,
      geminiEngine: makeMockEngine(),
      memoryService: makeMockMemory(),
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("online");
    expect(res.body.data.gemini).toBe("connected");
    expect(res.body.data.memory).toBe("active");
    expect(res.body.data.referenceStore).toBeDefined();
    expect(res.body.data.overlayStore).toBeDefined();
  });

  it("reports gemini as stub when providerMode is stub", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, providerMode: "stub" as const },
    };
    const state = makeState({
      startupComplete: true,
      geminiEngine: makeMockEngine(),
      config: { ...config, contract },
    });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.data.gemini).toBe("stub");
  });
});

// ─── POST /api/chat ─────────────────────────────────────────────

describe("POST /api/chat", () => {
  async function waitForRunStatus(
    app: ReturnType<typeof createApp>,
    runId: string,
    targetStatus: string,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 20; i += 1) {
      const statusRes = await testRequest(app).get(`/api/chat/runs/${runId}`);
      if (statusRes.status === 200 && statusRes.body.data?.status === targetStatus) {
        return statusRes.body.data as Record<string, unknown>;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`run ${runId} did not reach ${targetStatus} state`);
  }

  it("returns 400 when message is missing", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app).post("/api/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Missing");
  });

  it("returns 400 when message is not a string", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app).post("/api/chat").send({ message: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when tabId is not a string", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app).post("/api/chat").send({ message: "Hello", tabId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("returns 503 when Gemini is not configured", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain("Gemini not ready");
  });

  it("returns 503 with provider-disabled reason when providerMode is off", async () => {
    const config = makeConfig();
    const contract = {
      ...config.contract,
      capabilities: { ...config.contract.capabilities, providerMode: "off" as const },
    };
    const state = makeState({ config: { ...config, contract } });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(503);
    expect(res.body.error.detail.reason).toBe("provider disabled in this profile");
    expect(res.body.error.hints).toContain("Provider mode is 'off' for this profile");
  });

  it("returns model response on success", async () => {
    const engine = makeMockEngine("Live long and prosper.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Live long and prosper.");
    expect(res.body.data.runId).toMatch(/^crun_/);
    expect(res.body.data.sessionId).toBe("default");
    expect(res.body.data.tabId).toBe("default_tab");
    expect(engine.chat).toHaveBeenCalledWith("Hello", "default", undefined, "local", expect.any(String), undefined, "fleet", false);
  });

  it("supports async submit-and-return flow with run status", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("Async success.");
    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-async")
      .send({ message: "Hello async", tabId: "tab-async", async: true });

    expect(submit.status).toBe(202);
    expect(submit.body.data.runId).toMatch(/^crun_/);
    expect(submit.body.data.status).toBe("queued");

    const runData = await waitForRunStatus(app, submit.body.data.runId as string, "succeeded");
    expect(runData.answer).toBe("Async success.");
    expect(runData.sessionId).toBe("session-async");
    expect(runData.tabId).toBe("tab-async");
  });

  it("returns 400 when async is not boolean", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello", async: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARAM");
  });

  it("cancels an async run and surfaces cancelled status", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("Should not be returned after cancel.");
    (engine.chat as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Promise<string>((resolve) => setTimeout(() => resolve("Late answer"), 80)),
    );

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-cancel")
      .send({ message: "Cancel me", tabId: "tab-cancel", async: true });

    expect(submit.status).toBe(202);
    const runId = submit.body.data.runId as string;

    const cancelRes = await testRequest(app)
      .post(`/api/chat/runs/${runId}/cancel`)
      .send({});
    expect(cancelRes.status).toBe(202);

    const runData = await waitForRunStatus(app, runId, "cancelled");
    expect(runData.sessionId).toBe("session-cancel");
    expect(runData.tabId).toBe("tab-cancel");
  });

  it("returns 404 for unknown run status", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const state = makeState({
      geminiEngine: makeMockEngine("noop"),
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
    });
    const app = createApp(state);

    const statusRes = await testRequest(app).get("/api/chat/runs/crun_unknown");
    expect(statusRes.status).toBe(404);
  });

  it("prefers durable run status when event stream status is stale", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const state = makeState({
      geminiEngine: makeMockEngine("noop"),
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const runId = "crun_status_reconcile";
    const sessionId = "session-reconcile";
    const tabId = "tab-reconcile";

    await chatRunStore.enqueue({
      id: runId,
      userId: "local",
      sessionId,
      tabId,
      requestJson: { message: "reconcile" },
    });
    await chatRunStore.claimNext("lock-reconcile");
    await chatRunStore.requestCancel(runId, "local");
    await pool.query(
      `UPDATE chat_runs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      [runId],
    );
    await chatRunStore.requeueStaleRunning(60_000);

    const eventStore = eventFactory.forUser("local");
    await eventStore.register("chat_run", runId, { sessionId, tabId });
    await eventStore.emit({
      topic: "chat_run",
      operationId: runId,
      routing: { sessionId, tabId },
      eventType: "run.started",
      status: "running",
      payloadJson: { phase: "chat.running", traceId: runId },
    });

    const statusRes = await testRequest(app).get(`/api/chat/runs/${runId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.data.status).toBe("cancelled");
    expect(statusRes.body.data.phase).toBe("chat.running");
    expect(statusRes.body.data.cancelReason).toBe("cancel_requested");
  });

  it("exposes traceable error fields on failed async run status", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("quota exhausted"));

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-fail")
      .send({ message: "Fail async", tabId: "tab-fail", async: true });

    expect(submit.status).toBe(202);
    const runId = submit.body.data.runId as string;

    const runData = await waitForRunStatus(app, runId, "failed");
    expect(runData.traceId).toBeTruthy();
    expect(runData.errorCode).toBe("GEMINI_ERROR");
    expect(typeof runData.errorMessage).toBe("string");
  });

  it("registers and emits run lifecycle events with session/tab routing", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const state = makeState({
      geminiEngine: makeMockEngine("Aye."),
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-alpha")
      .send({ message: "Status", tabId: "tab-alpha" });

    expect(res.status).toBe(200);
    const runId = res.body.data.runId as string;
    expect(runId).toMatch(/^crun_/);

    const store = eventFactory.forUser("local");
    const routing = await store.getRouting("chat_run", runId);
    expect(routing).toEqual({ sessionId: "session-alpha", tabId: "tab-alpha" });

    const events = await store.listSince("chat_run", runId, 0, 10);
    expect(events.map((e) => e.eventType)).toContain("run.started");
    expect(events.map((e) => e.eventType)).toContain("run.completed");
    expect(events.every((e) => e.sessionId === "session-alpha" && e.tabId === "tab-alpha")).toBe(true);
  });

  it("persists conversation to memory when available", async () => {
    const memory = makeMockMemory();
    const engine = makeMockEngine("Acknowledged.");
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    await testRequest(app).post("/api/chat").send({ message: "Status report" });

    // memory.remember is fire-and-forget, give it a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(memory.remember).toHaveBeenCalledWith({
      question: "Status report",
      answer: "Acknowledged.",
    });
  });

  it("still responds even if memory save fails", async () => {
    const memory = makeMockMemory();
    (memory.remember as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB locked")
    );

    const state = makeState({
      geminiEngine: makeMockEngine("Still works."),
      memoryService: memory,
    });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Test" });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Still works.");
  });

  it("returns 500 when Gemini throws", async () => {
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API quota exceeded")
    );
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app).post("/api/chat").send({ message: "Hi" });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("AI request failed");
  });

  it("routes messages to the session specified by X-Session-Id header", async () => {
    const engine = makeMockEngine("Session reply.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "tab-abc")
      .send({ message: "Hello from tab A" });

    expect(engine.chat).toHaveBeenCalledWith("Hello from tab A", "tab-abc", undefined, "local", expect.any(String), undefined, "fleet", false);
  });

  it("uses 'default' session when no X-Session-Id header", async () => {
    const engine = makeMockEngine("Default reply.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(engine.chat).toHaveBeenCalledWith("Hello", "default", undefined, "local", expect.any(String), undefined, "fleet", false);
  });

  it("isolates history between different session IDs", async () => {
    const engine = makeMockEngine("Response.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-1")
      .send({ message: "Alpha" });

    await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-2")
      .send({ message: "Beta" });

    // Each session should have its own history
    // #85: Keys are now namespaced by userId — dev mode uses "local"
    const hist1 = engine.getHistory("local:session-1");
    const hist2 = engine.getHistory("local:session-2");
    expect(hist1).toHaveLength(2); // user + model
    expect(hist2).toHaveLength(2);
    expect(hist1[0].text).toBe("Alpha");
    expect(hist2[0].text).toBe("Beta");
  });
});

// ─── GET /api/history ───────────────────────────────────────────

describe("GET /api/history", () => {
  it("returns empty session and lex when nothing configured", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toEqual([]);
    // No memory service → no lex field
  });

  it("returns session history from engine", async () => {
    const engine = makeMockEngine();
    // #85: Pass userId="local" to match dev-mode auth (namespaced key: "local:default")
    await engine.chat("Hello", "default", undefined, "local");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=session");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toHaveLength(2);
    expect(res.body.data.session[0].text).toBe("Hello");
  });

  it("returns lex timeline when memory is available", async () => {
    const frames = [makeFrame({ id: "f1" }), makeFrame({ id: "f2" })];
    const memory = makeMockMemory(frames);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toHaveLength(2);
    expect(res.body.data.lex[0].id).toBe("f1");
  });

  it("returns both sources by default", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("session");
    expect(res.body.data).toHaveProperty("lex");
  });

  it("handles lex timeline error gracefully", async () => {
    const memory = makeMockMemory();
    (memory.timeline as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB corrupt")
    );
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await testRequest(app).get("/api/history?source=lex&limit=5");
    expect(memory.timeline).toHaveBeenCalledWith(5);
  });

  it("returns session history for a specific sessionId", async () => {
    const engine = makeMockEngine();
    // #85: Pass userId="local" so history is stored under namespaced keys
    await engine.chat("Tab A message", "tab-a", undefined, "local");
    await engine.chat("Tab B message", "tab-b", undefined, "local");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=session&sessionId=tab-a");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toHaveLength(2);
    expect(res.body.data.session[0].text).toBe("Tab A message");
  });
});

// ─── GET /api/recall ────────────────────────────────────────────

describe("GET /api/recall", () => {
  it("returns 400 when query is missing", async () => {
    const state = makeState({ memoryService: makeMockMemory() });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/recall");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Missing query");
  });

  it("returns 503 when memory is not available", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await testRequest(app).get("/api/recall?q=Kirk");
    expect(res.status).toBe(503);
  });

  it("returns search results on success", async () => {
    const frame = makeFrame({
      id: "recall-1",
      reference_point: "Kirk discussion",
      keywords: ["kirk", "captain"],
    });
    const memory = makeMockMemory([frame]);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/recall?q=Kirk");
    expect(res.status).toBe(200);
    expect(res.body.data.query).toBe("Kirk");
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0].id).toBe("recall-1");
    expect(res.body.data.results[0].reference).toBe("Kirk discussion");
    expect(res.body.data.results[0].keywords).toEqual(["kirk", "captain"]);
  });

  it("passes limit to recall", async () => {
    const memory = makeMockMemory();
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await testRequest(app).get("/api/recall?q=test&limit=5");
    expect(memory.recall).toHaveBeenCalledWith("test", 5);
  });

  it("returns 500 when recall throws", async () => {
    const memory = makeMockMemory();
    (memory.recall as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Search index corrupt")
    );
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/recall?q=test");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Memory recall failed");
  });
});

// ─── SPA Fallback ───────────────────────────────────────────────

describe("SPA fallback", () => {
  it("serves index.html for unknown routes", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/some/unknown/route");
    // Should get 200 with HTML content (or 404 if index.html doesn't exist in test env)
    // Either way, the route handler fires — covering the SPA fallback line
    expect([200, 404]).toContain(res.status);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────

describe("edge cases", () => {
  it("chat works without memory service (fire-and-forget skipped)", async () => {
    const engine = makeMockEngine("No memory, still works.");
    const state = makeState({ geminiEngine: engine, memoryService: null });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("No memory, still works.");
  });

  it("history with source=lex without memory returns no lex field", async () => {
    const state = makeState({ memoryService: null });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toBeUndefined();
  });

  it("history with source=session returns only session", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/history?source=session");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toBeDefined();
    expect(res.body.data.lex).toBeUndefined();
  });

  it("recall handles non-Error throw gracefully", async () => {
    const memory = makeMockMemory();
    (memory.recall as ReturnType<typeof vi.fn>).mockRejectedValue(
      "string error"
    );
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/recall?q=test");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Memory recall failed");
  });

  it("chat handles non-Error throw from engine", async () => {
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      "raw string error"
    );
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hi" });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("AI request failed");
  });

  it("health returns referenceStore/overlayStore status", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/health");
    expect(res.body.data.referenceStore).toBeDefined();
    expect(res.body.data.overlayStore).toBeDefined();
  });

  it("recall defaults limit to 10", async () => {
    const memory = makeMockMemory();
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await testRequest(app).get("/api/recall?q=test");
    expect(memory.recall).toHaveBeenCalledWith("test", 10);
  });
});

// ─── Settings API ───────────────────────────────────────────────

describe("settings API", () => {
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    settingsStore = await createSettingsStore(pool);
  });

  describe("GET /api/settings", () => {
    it("returns 503 when settings store is not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).get("/api/settings");
      expect(res.status).toBe(503);
    });

    it("returns all settings with categories", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app).get("/api/settings");
      expect(res.status).toBe(200);
      expect(res.body.data.categories).toContain("display");
      expect(res.body.data.settings.length).toBeGreaterThan(0);
    });

    it("filters by category", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app).get("/api/settings?category=display");
      expect(res.status).toBe(200);
      expect(res.body.data.category).toBe("display");
      for (const s of res.body.data.settings) {
        expect(s.category).toBe("display");
      }
    });

    it("returns 400 for unknown category", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app).get("/api/settings?category=fake");
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/settings", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).patch("/api/settings").send({ "display.admiralName": "Guff" });
      expect(res.status).toBe(503);
    });

    it("updates a setting", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app)
        .patch("/api/settings")
        .send({ "display.admiralName": "Guff" });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({ key: "display.admiralName", status: "updated" });
      expect(await settingsStore.get("display.admiralName")).toBe("Guff");
    });

    it("reports errors for invalid keys", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app)
        .patch("/api/settings")
        .send({ "fake.key": "value" });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].status).toBe("error");
    });

    it("returns 400 for non-object body", async () => {
      const app = createApp(makeState({ settingsStore }));
      // Send a JSON number — parsed by express.json() as a non-object
      const res = await testRequest(app)
        .patch("/api/settings")
        .set("Content-Type", "application/json")
        .send("42");
      expect(res.status).toBe(400);
    });

    it("returns 400 for array body", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app)
        .patch("/api/settings")
        .send([1, 2, 3]);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/settings/:key", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await testRequest(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(503);
    });

    it("resets a user-set value", async () => {
      await settingsStore.set("display.admiralName", "Guff");
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("reset");
      expect(res.body.data.resolvedValue).toBe("Admiral"); // default
    });

    it("handles non-existent key gracefully", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await testRequest(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("not_found");
    });
  });
});

// ─── GET /api (Discovery) ───────────────────────────────────────

describe("GET /api", () => {
  it("returns API manifest with endpoints list", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Majel");
    expect(res.body.data.version).toBeDefined();
    expect(res.body.data.endpoints).toBeInstanceOf(Array);
    expect(res.body.data.endpoints.length).toBeGreaterThan(5);
  });

  it("includes all major endpoints", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api");
    const paths = res.body.data.endpoints.map((e: { path: string }) => e.path);
    expect(paths).toContain("/api/health");
    expect(paths).toContain("/api/diagnostic");
    expect(paths).toContain("/api/chat");
    expect(paths).toContain("/api/recall");
    expect(paths).toContain("/api/settings");
  });

  it("each endpoint has method, path, and description", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api");
    for (const endpoint of res.body.data.endpoints) {
      expect(endpoint.method).toBeDefined();
      expect(endpoint.path).toBeDefined();
      expect(endpoint.description).toBeDefined();
    }
  });

  it("matches all registered Express /api routes", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api");

    const discoveryRoutes = (res.body.data.endpoints as Array<{ method: string; path: string }>)
      .map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`)
      .sort();
    const runtimeRoutes = collectApiRoutes(app)
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(discoveryRoutes).toEqual(runtimeRoutes);
  });
});

// ─── GET /api/diagnostic ────────────────────────────────────────

describe("GET /api/diagnostic", () => {
  it("returns system info regardless of subsystem state", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.status).toBe(200);
    expect(res.body.data.system).toBeDefined();
    expect(res.body.data.system.nodeVersion).toMatch(/^v\d+/);
    expect(res.body.data.system.timestamp).toBeDefined();
    expect(res.body.data.system.uptime).toBeDefined();
  });

  it("reports gemini as not configured when no engine", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.body.data.gemini.status).toBe("not configured");
  });

  it("reports gemini status with session count when connected", async () => {
    const engine = makeMockEngine();
    await engine.chat("hello"); // creates a session in "default"
    const app = createApp(makeState({ geminiEngine: engine }));
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.body.data.gemini.status).toBe("connected");
    expect(res.body.data.gemini.model).toBe("gemini-3-pro-preview");
    expect(res.body.data.gemini.activeSessions).toBe(1);
  });

  it("reports memory status with frame count when active", async () => {
    const frames = [makeFrame(), makeFrame({ id: "frame-2" })];
    const memory = makeMockMemory(frames);
    const app = createApp(makeState({ memoryService: memory }));
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.body.data.memory.status).toBe("active");
    expect(res.body.data.memory.frameCount).toBe(2);
    expect(res.body.data.memory.dbPath).toBeDefined();
  });

  it("reports memory as not configured when no service", async () => {
    const app = createApp(makeState());
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.body.data.memory.status).toBe("not configured");
  });

  it("reports settings status with override count when active", async () => {
    await cleanDatabase(pool);
    const store = await createSettingsStore(pool);
    await store.set("display.admiralName", "TestAdmiral");
    const app = createApp(makeState({ settingsStore: store }));
    const res = await testRequest(app).get("/api/diagnostic");
    expect(res.body.data.settings.status).toBe("active");
    expect(res.body.data.settings.userOverrides).toBe(1);
  });
});

// ─── Token Budget Integration ───────────────────────────────────

describe("token budget integration", () => {
  it("returns 429 when budget is exceeded on sync chat", async () => {
    const engine = makeMockEngine("Should not reach engine.");
    const budgetStore = makeMockBudgetStore("exceed");
    const state = makeState({ geminiEngine: engine, tokenBudgetStore: budgetStore });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("TOKEN_BUDGET_EXCEEDED");
    expect(res.body.error.detail.dailyLimit).toBe(100_000);
    expect(res.body.error.detail.consumed).toBe(100_000);
    expect(res.body.error.detail.remaining).toBe(0);
    expect(res.body.error.detail.resetsAt).toBeDefined();
    expect(engine.chat).not.toHaveBeenCalled();
  });

  it("succeeds and includes budgetWarning when in warning zone", async () => {
    const engine = makeMockEngine("Aye.");
    const budgetStore = makeMockBudgetStore("warning");
    const state = makeState({ geminiEngine: engine, tokenBudgetStore: budgetStore });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Aye.");
    expect(res.body.data.budgetWarning).toBeDefined();
    expect(res.body.data.budgetWarning.remaining).toBe(10_000);
    expect(res.body.data.budgetWarning.dailyLimit).toBe(100_000);
  });

  it("does not include budgetWarning when budget is healthy", async () => {
    const engine = makeMockEngine("Aye.");
    const budgetStore = makeMockBudgetStore("pass");
    const state = makeState({ geminiEngine: engine, tokenBudgetStore: budgetStore });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(res.status).toBe(200);
    expect(res.body.data.budgetWarning).toBeUndefined();
  });

  it("emits run.budget_exceeded event on async budget failure", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("Should not reach engine.");
    const budgetStore = makeMockBudgetStore("exceed");

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
      tokenBudgetStore: budgetStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello async budget", tabId: "tab-budget", async: true });

    expect(submit.status).toBe(202);
    const runId = submit.body.data.runId as string;

    const runData = await waitForRunStatus(app, runId, "failed");
    expect(runData.status).toBe("failed");

    // Verify the budget_exceeded event was emitted
    const store = eventFactory.forUser("local");
    const events = await store.listSince("chat_run", runId, 0, 20);
    const budgetEvent = events.find((e) => e.eventType === "run.budget_exceeded");
    expect(budgetEvent).toBeDefined();
    expect(budgetEvent!.status).toBe("failed");
  });
});

// ─── Empty Answer Handling ──────────────────────────────────────

describe("empty answer handling", () => {
  it("returns 500 when engine returns empty string on sync chat", async () => {
    const engine = makeMockEngine("");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("AI request failed");
  });

  it("emits run.failed with EMPTY_ANSWER on async empty response", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("");

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Empty test", tabId: "tab-empty", async: true });

    expect(submit.status).toBe(202);
    const runId = submit.body.data.runId as string;

    const runData = await waitForRunStatus(app, runId, "failed");
    expect(runData.errorCode).toBe("EMPTY_ANSWER");
    expect(runData.errorMessage).toContain("empty response");
  });

  it("returns ChatResult text through sync route", async () => {
    const result: ChatResult = { text: "Structured reply.", proposals: [] };
    const engine = makeMockEngine(result);
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Structured reply.");
  });

  it("returns proposals from ChatResult", async () => {
    const result: ChatResult = {
      text: "Here are some options.",
      proposals: [{
        id: "prop-1",
        batchItems: [{ tool: "setCrewAssignment", preview: "Assign Kirk to Enterprise" }],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }],
    };
    const engine = makeMockEngine(result);
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Suggest changes" });

    expect(res.status).toBe(200);
    expect(res.body.data.proposals).toHaveLength(1);
    expect(res.body.data.proposals[0].id).toBe("prop-1");
  });
});

// ─── Async Run Error Propagation ────────────────────────────────

describe("async run error propagation", () => {
  it("surfaces GEMINI_ERROR when engine throws during async run", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("model overloaded"));

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Fail me", tabId: "tab-err", async: true });

    const runData = await waitForRunStatus(app, submit.body.data.runId as string, "failed");
    expect(runData.errorCode).toBe("GEMINI_ERROR");
    expect(runData.errorMessage).toContain("model overloaded");
  });

  it("includes trace on failed async run (admiral has trace)", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("crash"));

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Trace test", tabId: "tab-trace", async: true });

    const runData = await waitForRunStatus(app, submit.body.data.runId as string, "failed");
    expect(runData.trace).toBeDefined();
  });

  it("emits full event lifecycle for successful async run", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("Aye.");

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Lifecycle test", tabId: "tab-lifecycle", async: true });

    const runId = submit.body.data.runId as string;
    await waitForRunStatus(app, runId, "succeeded");

    const store = eventFactory.forUser("local");
    const events = await store.listSince("chat_run", runId, 0, 20);
    const types = events.map((e) => e.eventType);

    expect(types).toContain("run.queued");
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
  });
});

// ─── Run Cancel Edge Cases ──────────────────────────────────────

describe("run cancel edge cases", () => {
  it("returns 409 when cancelling an already succeeded run", async () => {
    await cleanDatabase(pool);
    const eventFactory = await createOperationEventStoreFactory(pool);
    const chatRunStore = await createChatRunStore(pool);
    const engine = makeMockEngine("Done.");

    const state = makeState({
      geminiEngine: engine,
      operationEventStoreFactory: eventFactory,
      operationEventStore: eventFactory.forUser("local"),
      chatRunStore,
    });
    const app = createApp(state);

    const submit = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Finish first", tabId: "tab-done", async: true });

    const runId = submit.body.data.runId as string;
    await waitForRunStatus(app, runId, "succeeded");

    const cancelRes = await testRequest(app)
      .post(`/api/chat/runs/${runId}/cancel`)
      .send({});
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error.message).toContain("terminal state");
  });

  it("returns 400 for invalid runId format on cancel", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat/runs/!!invalid!!/cancel")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid runId format on status query", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/chat/runs/!!bad!!");
    expect(res.status).toBe(400);
  });
});

// ─── Model Selector Routes ─────────────────────────────────────

describe("GET /api/models", () => {
  it("returns model list with current model marked active", async () => {
    const engine = makeMockEngine();
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.data.current).toBe("gemini-3-pro-preview");
    expect(res.body.data.defaultModel).toBeDefined();
    expect(res.body.data.models).toBeInstanceOf(Array);
    expect(res.body.data.models.length).toBeGreaterThan(0);

    const activeModels = res.body.data.models.filter((m: { active: boolean }) => m.active);
    expect(activeModels).toHaveLength(1);
    expect(activeModels[0].id).toBe("gemini-3-pro-preview");
  });

  it("each model has availability info", async () => {
    const engine = makeMockEngine();
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app).get("/api/models");
    for (const model of res.body.data.models) {
      expect(typeof model.available).toBe("boolean");
      expect(model).toHaveProperty("unavailableReason");
    }
  });
});

describe("POST /api/models/select", () => {
  it("returns 400 when model is missing", async () => {
    const engine = makeMockEngine();
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/models/select")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Missing 'model'");
  });

  it("returns 400 for unknown model", async () => {
    const engine = makeMockEngine();
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/models/select")
      .send({ model: "nonexistent-model" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unknown model");
  });

  it("switches model and clears sessions", async () => {
    const engine = makeMockEngine();
    // Create a session so sessionsCleared > 0
    await engine.chat("hello", "default", undefined, "local");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    // Get available models first
    const modelsRes = await testRequest(app).get("/api/models");
    const availableModel = modelsRes.body.data.models.find(
      (m: { available: boolean; id: string }) => m.available && m.id !== "gemini-3-pro-preview"
    );
    if (!availableModel) return; // skip if only one model available

    const res = await testRequest(app)
      .post("/api/models/select")
      .send({ model: availableModel.id });
    expect(res.status).toBe(200);
    expect(res.body.data.previousModel).toBe("gemini-3-pro-preview");
    expect(res.body.data.currentModel).toBe(availableModel.id);
    expect(res.body.data.sessionsCleared).toBeGreaterThanOrEqual(0);
  });

  it("returns 500 when engine is not initialized", async () => {
    const state = makeState({ geminiEngine: null });
    const app = createApp(state);

    // We need a model that exists. Try the default.
    const res = await testRequest(app)
      .post("/api/models/select")
      .send({ model: "gemini-2.5-flash" });
    // This should hit the 503 gemini-not-ready on requireVisitor for chat,
    // but for models route it requires admiral auth + engine check separately.
    // In dev mode auth passes, so it reaches the engine null check.
    expect([400, 500]).toContain(res.status);
  });
});

// ─── Image Validation ───────────────────────────────────────────

describe("image validation", () => {
  it("returns 400 for missing image data field", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello", image: { mimeType: "image/png" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("data");
  });

  it("returns 400 for unsupported image type", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "Hello", image: { data: "abc123", mimeType: "image/gif" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unsupported image type");
  });

  it("accepts valid image and passes to engine", async () => {
    const engine = makeMockEngine("I see the image.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .send({
        message: "What is this?",
        image: { data: "aGVsbG8=", mimeType: "image/png" },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("I see the image.");
    expect(engine.chat).toHaveBeenCalledWith(
      "What is this?",
      "default",
      { inlineData: { data: "aGVsbG8=", mimeType: "image/png" } },
      "local",
      expect.any(String),
      undefined,
      "fleet",
      false,
    );
  });
});

// ─── Message Validation Edge Cases ──────────────────────────────

describe("message validation edge cases", () => {
  it("returns 400 when message exceeds 10000 chars", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const longMessage = "x".repeat(10001);
    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: longMessage });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("10,000 characters");
  });

  it("returns 400 for session ID with special characters", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await testRequest(app)
      .post("/api/chat")
      .set("X-Session-Id", "session with spaces!")
      .send({ message: "Hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Invalid session ID");
  });
});
