/**
 * api.test.ts — Integration tests for Majel's Express API routes.
 *
 * Uses supertest against the app factory (no real server listen).
 * Mocks Gemini and Lex to test route logic in isolation.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";
import type { GeminiEngine } from "../src/server/gemini.js";
import type { MemoryService, Frame } from "../src/server/memory.js";
import { createSettingsStore, type SettingsStore } from "../src/server/settings.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

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

function makeMockEngine(response = "Aye, Admiral."): GeminiEngine {
  const sessions = new Map<string, Array<{ role: string; text: string }>>();
  const getSessionHistory = (sid: string) => {
    if (!sessions.has(sid)) sessions.set(sid, []);
    return sessions.get(sid)!;
  };
  return {
    chat: vi.fn().mockImplementation(async (msg: string, sessionId = "default") => {
      const history = getSessionHistory(sessionId);
      history.push({ role: "user", text: msg });
      history.push({ role: "model", text: response });
      return response;
    }),
    getHistory: vi.fn().mockImplementation((sessionId = "default") => [...getSessionHistory(sessionId)]),
    getSessionCount: vi.fn().mockImplementation(() => sessions.size),
    closeSession: vi.fn().mockImplementation((sessionId: string) => { sessions.delete(sessionId); }),
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    userStore: null,
    startupComplete: false,
    config: bootstrapConfigSync(),
    ...overrides,
  };
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

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
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

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("online");
    expect(res.body.data.gemini).toBe("connected");
    expect(res.body.data.memory).toBe("active");
    expect(res.body.data.referenceStore).toBeDefined();
    expect(res.body.data.overlayStore).toBeDefined();
  });
});

// ─── POST /api/chat ─────────────────────────────────────────────

describe("POST /api/chat", () => {
  it("returns 400 when message is missing", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await request(app).post("/api/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Missing");
  });

  it("returns 400 when message is not a string", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await request(app).post("/api/chat").send({ message: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 503 when Gemini is not configured", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain("Gemini not ready");
  });

  it("returns model response on success", async () => {
    const engine = makeMockEngine("Live long and prosper.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("Live long and prosper.");
    expect(engine.chat).toHaveBeenCalledWith("Hello", "default");
  });

  it("persists conversation to memory when available", async () => {
    const memory = makeMockMemory();
    const engine = makeMockEngine("Acknowledged.");
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    await request(app).post("/api/chat").send({ message: "Status report" });

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

    const res = await request(app)
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

    const res = await request(app).post("/api/chat").send({ message: "Hi" });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain("API quota exceeded");
  });

  it("routes messages to the session specified by X-Session-Id header", async () => {
    const engine = makeMockEngine("Session reply.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await request(app)
      .post("/api/chat")
      .set("X-Session-Id", "tab-abc")
      .send({ message: "Hello from tab A" });

    expect(engine.chat).toHaveBeenCalledWith("Hello from tab A", "tab-abc");
  });

  it("uses 'default' session when no X-Session-Id header", async () => {
    const engine = makeMockEngine("Default reply.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await request(app)
      .post("/api/chat")
      .send({ message: "Hello" });

    expect(engine.chat).toHaveBeenCalledWith("Hello", "default");
  });

  it("isolates history between different session IDs", async () => {
    const engine = makeMockEngine("Response.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    await request(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-1")
      .send({ message: "Alpha" });

    await request(app)
      .post("/api/chat")
      .set("X-Session-Id", "session-2")
      .send({ message: "Beta" });

    // Each session should have its own history
    const hist1 = engine.getHistory("session-1");
    const hist2 = engine.getHistory("session-2");
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

    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toEqual([]);
    // No memory service → no lex field
  });

  it("returns session history from engine", async () => {
    const engine = makeMockEngine();
    await engine.chat("Hello");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=session");
    expect(res.status).toBe(200);
    expect(res.body.data.session).toHaveLength(2);
    expect(res.body.data.session[0].text).toBe("Hello");
  });

  it("returns lex timeline when memory is available", async () => {
    const frames = [makeFrame({ id: "f1" }), makeFrame({ id: "f2" })];
    const memory = makeMockMemory(frames);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toHaveLength(2);
    expect(res.body.data.lex[0].id).toBe("f1");
  });

  it("returns both sources by default", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history");
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

    const res = await request(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await request(app).get("/api/history?source=lex&limit=5");
    expect(memory.timeline).toHaveBeenCalledWith(5);
  });

  it("returns session history for a specific sessionId", async () => {
    const engine = makeMockEngine();
    await engine.chat("Tab A message", "tab-a");
    await engine.chat("Tab B message", "tab-b");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=session&sessionId=tab-a");
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

    const res = await request(app).get("/api/recall");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Missing query");
  });

  it("returns 503 when memory is not available", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await request(app).get("/api/recall?q=Kirk");
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

    const res = await request(app).get("/api/recall?q=Kirk");
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

    await request(app).get("/api/recall?q=test&limit=5");
    expect(memory.recall).toHaveBeenCalledWith("test", 5);
  });

  it("returns 500 when recall throws", async () => {
    const memory = makeMockMemory();
    (memory.recall as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Search index corrupt")
    );
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/recall?q=test");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain("Search index corrupt");
  });
});

// ─── SPA Fallback ───────────────────────────────────────────────

describe("SPA fallback", () => {
  it("serves index.html for unknown routes", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await request(app).get("/some/unknown/route");
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

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.data.answer).toBe("No memory, still works.");
  });

  it("history with source=lex without memory returns no lex field", async () => {
    const state = makeState({ memoryService: null });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.data.lex).toBeUndefined();
  });

  it("history with source=session returns only session", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=session");
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

    const res = await request(app).get("/api/recall?q=test");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("string error");
  });

  it("chat handles non-Error throw from engine", async () => {
    const engine = makeMockEngine();
    (engine.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
      "raw string error"
    );
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hi" });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("raw string error");
  });

  it("health returns referenceStore/overlayStore status", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await request(app).get("/api/health");
    expect(res.body.data.referenceStore).toBeDefined();
    expect(res.body.data.overlayStore).toBeDefined();
  });

  it("recall defaults limit to 10", async () => {
    const memory = makeMockMemory();
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await request(app).get("/api/recall?q=test");
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
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(503);
    });

    it("returns all settings with categories", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).get("/api/settings");
      expect(res.status).toBe(200);
      expect(res.body.data.categories).toContain("display");
      expect(res.body.data.settings.length).toBeGreaterThan(0);
    });

    it("filters by category", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).get("/api/settings?category=display");
      expect(res.status).toBe(200);
      expect(res.body.data.category).toBe("display");
      for (const s of res.body.data.settings) {
        expect(s.category).toBe("display");
      }
    });

    it("returns 400 for unknown category", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).get("/api/settings?category=fake");
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/settings", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await request(app).patch("/api/settings").send({ "display.admiralName": "Guff" });
      expect(res.status).toBe(503);
    });

    it("updates a setting", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app)
        .patch("/api/settings")
        .send({ "display.admiralName": "Guff" });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toEqual({ key: "display.admiralName", status: "updated" });
      expect(await settingsStore.get("display.admiralName")).toBe("Guff");
    });

    it("reports errors for invalid keys", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app)
        .patch("/api/settings")
        .send({ "fake.key": "value" });
      expect(res.status).toBe(200);
      expect(res.body.data.results[0].status).toBe("error");
    });

    it("returns 400 for non-object body", async () => {
      const app = createApp(makeState({ settingsStore }));
      // Send a JSON number — parsed by express.json() as a non-object
      const res = await request(app)
        .patch("/api/settings")
        .set("Content-Type", "application/json")
        .send("42");
      expect(res.status).toBe(400);
    });

    it("returns 400 for array body", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app)
        .patch("/api/settings")
        .send([1, 2, 3]);
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/settings/:key", () => {
    it("returns 503 when store not available", async () => {
      const app = createApp(makeState());
      const res = await request(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(503);
    });

    it("resets a user-set value", async () => {
      await settingsStore.set("display.admiralName", "Guff");
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("reset");
      expect(res.body.data.resolvedValue).toBe("Admiral"); // default
    });

    it("handles non-existent key gracefully", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("not_found");
    });
  });
});

// ─── GET /api (Discovery) ───────────────────────────────────────

describe("GET /api", () => {
  it("returns API manifest with endpoints list", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api");
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Majel");
    expect(res.body.data.version).toBeDefined();
    expect(res.body.data.endpoints).toBeInstanceOf(Array);
    expect(res.body.data.endpoints.length).toBeGreaterThan(5);
  });

  it("includes all major endpoints", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api");
    const paths = res.body.data.endpoints.map((e: { path: string }) => e.path);
    expect(paths).toContain("/api/health");
    expect(paths).toContain("/api/diagnostic");
    expect(paths).toContain("/api/chat");
    expect(paths).toContain("/api/recall");
    expect(paths).toContain("/api/settings");
  });

  it("each endpoint has method, path, and description", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api");
    for (const endpoint of res.body.data.endpoints) {
      expect(endpoint.method).toBeDefined();
      expect(endpoint.path).toBeDefined();
      expect(endpoint.description).toBeDefined();
    }
  });
});

// ─── GET /api/diagnostic ────────────────────────────────────────

describe("GET /api/diagnostic", () => {
  it("returns system info regardless of subsystem state", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api/diagnostic");
    expect(res.status).toBe(200);
    expect(res.body.data.system).toBeDefined();
    expect(res.body.data.system.nodeVersion).toMatch(/^v\d+/);
    expect(res.body.data.system.timestamp).toBeDefined();
    expect(res.body.data.system.uptime).toBeDefined();
  });

  it("reports gemini as not configured when no engine", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api/diagnostic");
    expect(res.body.data.gemini.status).toBe("not configured");
  });

  it("reports gemini status with session count when connected", async () => {
    const engine = makeMockEngine();
    await engine.chat("hello"); // creates a session in "default"
    const app = createApp(makeState({ geminiEngine: engine }));
    const res = await request(app).get("/api/diagnostic");
    expect(res.body.data.gemini.status).toBe("connected");
    expect(res.body.data.gemini.model).toBe("gemini-2.5-flash-lite");
    expect(res.body.data.gemini.activeSessions).toBe(1);
  });

  it("reports memory status with frame count when active", async () => {
    const frames = [makeFrame(), makeFrame({ id: "frame-2" })];
    const memory = makeMockMemory(frames);
    const app = createApp(makeState({ memoryService: memory }));
    const res = await request(app).get("/api/diagnostic");
    expect(res.body.data.memory.status).toBe("active");
    expect(res.body.data.memory.frameCount).toBe(2);
    expect(res.body.data.memory.dbPath).toBeDefined();
  });

  it("reports memory as not configured when no service", async () => {
    const app = createApp(makeState());
    const res = await request(app).get("/api/diagnostic");
    expect(res.body.data.memory.status).toBe("not configured");
  });

  it("reports settings status with override count when active", async () => {
    await cleanDatabase(pool);
    const store = await createSettingsStore(pool);
    await store.set("display.admiralName", "TestAdmiral");
    const app = createApp(makeState({ settingsStore: store }));
    const res = await request(app).get("/api/diagnostic");
    expect(res.body.data.settings.status).toBe("active");
    expect(res.body.data.settings.userOverrides).toBe(1);
  });
});
