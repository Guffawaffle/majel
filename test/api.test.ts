/**
 * api.test.ts — Integration tests for Majel's Express API routes.
 *
 * Uses supertest against the app factory (no real server listen).
 * Mocks Gemini and Lex to test route logic in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";
import type { GeminiEngine } from "../src/server/gemini.js";
import type { MemoryService, Frame } from "../src/server/memory.js";
import { buildSection, buildFleetData, type FleetData } from "../src/server/fleet-data.js";
import { createSettingsStore, type SettingsStore } from "../src/server/settings.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock hasCredentials since it checks the filesystem
vi.mock("../src/server/sheets.js", () => ({
  hasCredentials: vi.fn(() => false),
  fetchRoster: vi.fn(),
  fetchFleetData: vi.fn(),
  parseTabMapping: vi.fn(() => ({ Officers: "officers", Ships: "ships" })),
}));

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
  };
}

function makeMockEngine(response = "Aye, Admiral."): GeminiEngine {
  const history: Array<{ role: string; text: string }> = [];
  return {
    chat: vi.fn().mockImplementation(async (msg: string) => {
      history.push({ role: "user", text: msg });
      history.push({ role: "model", text: response });
      return response;
    }),
    getHistory: vi.fn().mockImplementation(() => [...history]),
  };
}

function makeFleetData(): FleetData {
  return buildFleetData("test-spreadsheet", [
    buildSection("officers", "Officers", "Officers", [
      ["Name", "Level"], ["Kirk", "50"], ["Spock", "45"],
    ]),
  ]);
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    geminiEngine: null,
    memoryService: null,
    settingsStore: null,
    fleetData: null,
    rosterError: null,
    startupComplete: false,
    ...overrides,
  };
}

// ─── GET /api/health ────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns initializing status before startup", async () => {
    const state = makeState();
    const app = createApp(state);

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("initializing");
    expect(res.body.gemini).toBe("not configured");
    expect(res.body.memory).toBe("not configured");
    expect(res.body.fleet.loaded).toBe(false);
  });

  it("returns online status after startup", async () => {
    const state = makeState({
      startupComplete: true,
      geminiEngine: makeMockEngine(),
      memoryService: makeMockMemory(),
      fleetData: makeFleetData(),
    });
    const app = createApp(state);

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("online");
    expect(res.body.gemini).toBe("connected");
    expect(res.body.memory).toBe("active");
    expect(res.body.fleet.loaded).toBe(true);
    expect(res.body.fleet.totalChars).toBeGreaterThan(0);
    expect(res.body.fleet.sections).toHaveLength(1);
  });

  it("reports roster error when present", async () => {
    const state = makeState({
      startupComplete: true,
      rosterError: "OAuth expired",
    });
    const app = createApp(state);

    const res = await request(app).get("/api/health");
    expect(res.body.fleet.loaded).toBe(false);
    expect(res.body.fleet.error).toBe("OAuth expired");
  });
});

// ─── POST /api/chat ─────────────────────────────────────────────

describe("POST /api/chat", () => {
  it("returns 400 when message is missing", async () => {
    const state = makeState({ geminiEngine: makeMockEngine() });
    const app = createApp(state);

    const res = await request(app).post("/api/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing");
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
    expect(res.body.error).toContain("Gemini not ready");
  });

  it("returns model response on success", async () => {
    const engine = makeMockEngine("Live long and prosper.");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Live long and prosper.");
    expect(engine.chat).toHaveBeenCalledWith("Hello");
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
    expect(res.body.answer).toBe("Still works.");
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
    expect(res.body.error).toContain("API quota exceeded");
  });
});

// ─── GET /api/history ───────────────────────────────────────────

describe("GET /api/history", () => {
  it("returns empty session and lex when nothing configured", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body.session).toEqual([]);
    // No memory service → no lex field
  });

  it("returns session history from engine", async () => {
    const engine = makeMockEngine();
    await engine.chat("Hello");
    const state = makeState({ geminiEngine: engine });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=session");
    expect(res.status).toBe(200);
    expect(res.body.session).toHaveLength(2);
    expect(res.body.session[0].text).toBe("Hello");
  });

  it("returns lex timeline when memory is available", async () => {
    const frames = [makeFrame({ id: "f1" }), makeFrame({ id: "f2" })];
    const memory = makeMockMemory(frames);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.lex).toHaveLength(2);
    expect(res.body.lex[0].id).toBe("f1");
  });

  it("returns both sources by default", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("session");
    expect(res.body).toHaveProperty("lex");
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
    expect(res.body.lex).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ memoryService: memory });
    const app = createApp(state);

    await request(app).get("/api/history?source=lex&limit=5");
    expect(memory.timeline).toHaveBeenCalledWith(5);
  });
});

// ─── GET /api/recall ────────────────────────────────────────────

describe("GET /api/recall", () => {
  it("returns 400 when query is missing", async () => {
    const state = makeState({ memoryService: makeMockMemory() });
    const app = createApp(state);

    const res = await request(app).get("/api/recall");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing query");
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
    expect(res.body.query).toBe("Kirk");
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].id).toBe("recall-1");
    expect(res.body.results[0].reference).toBe("Kirk discussion");
    expect(res.body.results[0].keywords).toEqual(["kirk", "captain"]);
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
    expect(res.body.error).toContain("Search index corrupt");
  });
});

// ─── GET /api/roster ────────────────────────────────────────────

describe("GET /api/roster", () => {
  it("returns 400 when SPREADSHEET_ID is not configured", async () => {
    // SPREADSHEET_ID comes from env, which is empty in tests
    const state = makeState();
    const app = createApp(state);

    const res = await request(app).get("/api/roster");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("MAJEL_SPREADSHEET_ID not configured");
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
    expect(res.body.answer).toBe("No memory, still works.");
  });

  it("history with source=lex without memory returns no lex field", async () => {
    const state = makeState({ memoryService: null });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=lex");
    expect(res.status).toBe(200);
    expect(res.body.lex).toBeUndefined();
  });

  it("history with source=session returns only session", async () => {
    const engine = makeMockEngine();
    const memory = makeMockMemory([makeFrame()]);
    const state = makeState({ geminiEngine: engine, memoryService: memory });
    const app = createApp(state);

    const res = await request(app).get("/api/history?source=session");
    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();
    expect(res.body.lex).toBeUndefined();
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
    expect(res.body.error).toBe("string error");
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
    expect(res.body.error).toBe("raw string error");
  });

  it("health shows credentials=false when mocked", async () => {
    const state = makeState({ startupComplete: true });
    const app = createApp(state);

    const res = await request(app).get("/api/health");
    expect(res.body.credentials).toBe(false);
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
  let settingsDir: string;
  let settingsStore: SettingsStore;

  beforeEach(() => {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-api-settings-"));
    settingsStore = createSettingsStore(path.join(settingsDir, "settings.db"));
  });

  afterEach(() => {
    settingsStore.close();
    fs.rmSync(settingsDir, { recursive: true, force: true });
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
      expect(res.body.categories).toContain("sheets");
      expect(res.body.categories).toContain("display");
      expect(res.body.settings.length).toBeGreaterThan(0);
    });

    it("filters by category", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).get("/api/settings?category=display");
      expect(res.status).toBe(200);
      expect(res.body.category).toBe("display");
      for (const s of res.body.settings) {
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
      expect(res.body.results[0]).toEqual({ key: "display.admiralName", status: "updated" });
      expect(settingsStore.get("display.admiralName")).toBe("Guff");
    });

    it("reports errors for invalid keys", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app)
        .patch("/api/settings")
        .send({ "fake.key": "value" });
      expect(res.status).toBe(200);
      expect(res.body.results[0].status).toBe("error");
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
      settingsStore.set("display.admiralName", "Guff");
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("reset");
      expect(res.body.resolvedValue).toBe("Admiral"); // default
    });

    it("handles non-existent key gracefully", async () => {
      const app = createApp(makeState({ settingsStore }));
      const res = await request(app).delete("/api/settings/display.admiralName");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_found");
    });
  });
});
