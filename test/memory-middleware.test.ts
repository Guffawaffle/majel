/**
 * memory-middleware.test.ts — Tests for per-request scoped memory middleware (ADR-021 D4)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { testRequest } from "./helpers/test-request.js";
import { attachScopedMemory } from "../src/server/memory-middleware.js";
import type { AppState } from "../src/server/app-context.js";
import type { MemoryService } from "../src/server/memory.js";
import type { FrameStoreFactory } from "../src/server/postgres-frame-store.js";
import { bootstrapConfigSync } from "../src/server/config.js";

// ─── Helpers ────────────────────────────────────────────────────

function makeMockMemory(): MemoryService {
  return {
    remember: vi.fn().mockResolvedValue({ id: "test-frame" }),
    recall: vi.fn().mockResolvedValue([]),
    timeline: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    getFrameCount: vi.fn().mockResolvedValue(0),
    getDbPath: vi.fn().mockReturnValue("mock"),
  };
}

function makeMockFactory(): FrameStoreFactory & { forUser: ReturnType<typeof vi.fn> } {
  const mockStore = {} as never; // createMemoryService wraps this
  return {
    forUser: vi.fn().mockReturnValue(mockStore),
  } as unknown as FrameStoreFactory & { forUser: ReturnType<typeof vi.fn> };
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

/**
 * Build a minimal Express app that:
 * 1. Optionally sets res.locals.userId (simulating auth middleware)
 * 2. Runs attachScopedMemory
 * 3. Returns whether res.locals.memory was set
 */
function buildTestApp(
  appState: AppState,
  userId?: string,
): express.Express {
  const app = express();

  // Simulate auth middleware setting userId
  if (userId) {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.locals.userId = userId;
      next();
    });
  }

  app.use(attachScopedMemory(appState));

  app.get("/test", (_req: Request, res: Response) => {
    res.json({
      hasMemory: !!res.locals.memory,
      memoryType: res.locals.memory?.getDbPath?.() ?? "none",
    });
  });

  return app;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("attachScopedMemory middleware", () => {
  it("attaches nothing when no factory and no memoryService", async () => {
    const state = makeState();
    const app = buildTestApp(state, "user-1");

    const res = await testRequest(app).get("/test");
    expect(res.body.hasMemory).toBe(false);
  });

  it("falls back to shared memoryService when no factory", async () => {
    const memory = makeMockMemory();
    const state = makeState({ memoryService: memory });
    const app = buildTestApp(state, "user-1");

    const res = await testRequest(app).get("/test");
    expect(res.body.hasMemory).toBe(true);
    expect(res.body.memoryType).toBe("mock");
  });

  it("falls back to shared memoryService when no userId", async () => {
    const memory = makeMockMemory();
    const factory = makeMockFactory();
    const state = makeState({ memoryService: memory, frameStoreFactory: factory });
    // No userId set (no auth middleware)
    const app = buildTestApp(state);

    const res = await testRequest(app).get("/test");
    expect(res.body.hasMemory).toBe(true);
    // Should NOT have called factory.forUser
    expect(factory.forUser).not.toHaveBeenCalled();
  });

  it("creates scoped memory when factory and userId are present", async () => {
    const factory = makeMockFactory();
    const state = makeState({ frameStoreFactory: factory });
    const app = buildTestApp(state, "user-42");

    const res = await testRequest(app).get("/test");
    expect(res.body.hasMemory).toBe(true);
    expect(factory.forUser).toHaveBeenCalledWith("user-42");
  });

  it("prefers factory over shared memoryService", async () => {
    const sharedMemory = makeMockMemory();
    const factory = makeMockFactory();
    const state = makeState({ memoryService: sharedMemory, frameStoreFactory: factory });
    const app = buildTestApp(state, "user-99");

    await testRequest(app).get("/test");
    // Factory should be used, not the shared service
    expect(factory.forUser).toHaveBeenCalledWith("user-99");
  });

  it("different users get different scoped stores", async () => {
    const factory = makeMockFactory();
    const state = makeState({ frameStoreFactory: factory });

    const app = express();
    app.use(attachScopedMemory(state));

    // Simulate two requests with different users
    app.get("/test", (req: Request, res: Response) => {
      // userId set per-request
      res.json({ hasMemory: !!res.locals.memory });
    });

    // Request 1: user-A
    const app1 = express();
    app1.use((_req, res, next) => { res.locals.userId = "user-A"; next(); });
    app1.use(attachScopedMemory(state));
    app1.get("/test", (_req, res) => res.json({ ok: true }));
    await request(app1).get("/test");

    // Request 2: user-B
    const app2 = express();
    app2.use((_req, res, next) => { res.locals.userId = "user-B"; next(); });
    app2.use(attachScopedMemory(state));
    app2.get("/test", (_req, res) => res.json({ ok: true }));
    await request(app2).get("/test");

    expect(factory.forUser).toHaveBeenCalledWith("user-A");
    expect(factory.forUser).toHaveBeenCalledWith("user-B");
    expect(factory.forUser).toHaveBeenCalledTimes(2);
  });
});
