/**
 * session-routes.test.ts — Chat Session Route Tests (ADR-019)
 *
 * Supertest-based HTTP-level tests for /api/sessions routes:
 *   - Store not available (503)
 *   - List sessions (with limit validation)
 *   - Get session by ID (with ownership checks)
 *   - Patch session title (validation, ownership)
 *   - Delete session (ownership)
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import { makeState } from "./helpers/make-state.js";
import { createSessionStore, type SessionStore } from "../src/server/sessions.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// makeState imported from ./helpers/make-state.js

// ═════════════════════════════════════════════════════════════
// Store Not Available (503)
// ═════════════════════════════════════════════════════════════

describe("Session routes — store not available", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("GET /api/sessions returns 503 when session store is null", async () => {
    const res = await testRequest(app).get("/api/sessions");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SESSION_STORE_NOT_AVAILABLE");
  });

  it("GET /api/sessions/:id returns 503 when session store is null", async () => {
    const res = await testRequest(app).get("/api/sessions/test-id");
    expect(res.status).toBe(503);
  });

  it("PATCH /api/sessions/:id returns 503 when session store is null", async () => {
    const res = await testRequest(app).patch("/api/sessions/test-id").send({ title: "New title" });
    expect(res.status).toBe(503);
  });

  it("DELETE /api/sessions/:id returns 503 when session store is null", async () => {
    const res = await testRequest(app).delete("/api/sessions/test-id");
    expect(res.status).toBe(503);
  });
});

// ═════════════════════════════════════════════════════════════
// Session routes — with live store
// ═════════════════════════════════════════════════════════════

describe("Session routes — with live store", () => {
  let app: Express;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    sessionStore = await createSessionStore(pool);
    app = createApp(makeState({ sessionStore }));
  });

  // ─── List ──────────────────────────────────────────────────

  describe("GET /api/sessions", () => {
    it("returns empty list when no sessions", async () => {
      const res = await testRequest(app).get("/api/sessions");
      expect(res.status).toBe(200);
      expect(res.body.data.sessions).toEqual([]);
    });

    it("returns sessions (via all=true for demo mode)", async () => {
      await sessionStore.create("s1", "First Session");
      await sessionStore.addMessage("s1", "user", "Hello");

      const res = await testRequest(app).get("/api/sessions?all=true");
      expect(res.status).toBe(200);
      expect(res.body.data.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await sessionStore.create(`s${i}`, `Session ${i}`);
        await sessionStore.addMessage(`s${i}`, "user", `msg ${i}`);
        await new Promise(r => setTimeout(r, 5));
      }

      const res = await testRequest(app).get("/api/sessions?limit=2&all=true");
      expect(res.status).toBe(200);
      expect(res.body.data.sessions.length).toBe(2);
    });

    it("rejects limit below 1", async () => {
      const res = await testRequest(app).get("/api/sessions?limit=0");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("rejects limit above 200", async () => {
      const res = await testRequest(app).get("/api/sessions?limit=201");
      expect(res.status).toBe(400);
    });

    it("rejects non-numeric limit", async () => {
      const res = await testRequest(app).get("/api/sessions?limit=abc");
      expect(res.status).toBe(400);
    });
  });

  // ─── Get ───────────────────────────────────────────────────

  describe("GET /api/sessions/:id", () => {
    it("returns a session with messages", async () => {
      await sessionStore.create("s1", "Test Session");
      await sessionStore.addMessage("s1", "user", "Hello");
      await sessionStore.addMessage("s1", "model", "Hi!");

      const res = await testRequest(app).get("/api/sessions/s1");
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("Test Session");
      expect(res.body.data.messages).toHaveLength(2);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await testRequest(app).get("/api/sessions/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 for overly long ID", async () => {
      const res = await testRequest(app).get(`/api/sessions/${"x".repeat(201)}`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Patch Title ───────────────────────────────────────────

  describe("PATCH /api/sessions/:id", () => {
    it("updates session title", async () => {
      await sessionStore.create("s1", "Old Title");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({ title: "New Title" });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("New Title");
    });

    it("rejects missing title", async () => {
      await sessionStore.create("s1", "Title");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_PARAM");
    });

    it("rejects non-string title", async () => {
      await sessionStore.create("s1", "Title");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({ title: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects title over 200 chars", async () => {
      await sessionStore.create("s1", "Title");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({ title: "x".repeat(201) });
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await testRequest(app).patch("/api/sessions/nope").send({ title: "Title" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for overly long ID", async () => {
      const res = await testRequest(app).patch(`/api/sessions/${"x".repeat(201)}`).send({ title: "Title" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Delete ────────────────────────────────────────────────

  describe("DELETE /api/sessions/:id", () => {
    it("deletes a session", async () => {
      await sessionStore.create("s1", "To Delete");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).delete("/api/sessions/s1");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("deleted");

      // Confirm deleted
      const get = await testRequest(app).get("/api/sessions/s1");
      expect(get.status).toBe(404);
    });

    it("returns 404 for nonexistent session", async () => {
      const res = await testRequest(app).delete("/api/sessions/nope");
      expect(res.status).toBe(404);
    });

    it("returns 404 for overly long ID", async () => {
      const res = await testRequest(app).delete(`/api/sessions/${"x".repeat(201)}`);
      expect(res.status).toBe(404);
    });
  });
});
