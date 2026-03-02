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
import { makeState, makeConfig } from "./helpers/make-state.js";
import { createSessionStore, type SessionStore } from "../src/server/sessions.js";
import { createUserStore, type UserStore } from "../src/server/stores/user-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

const ADMIN_TOKEN = "session-routes-auth-token";

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

    it("returns sessions for the current user", async () => {
      await sessionStore.create("s1", "First Session", "local");
      await sessionStore.addMessage("s1", "user", "Hello");

      const res = await testRequest(app).get("/api/sessions");
      expect(res.status).toBe(200);
      expect(res.body.data.sessions.length).toBeGreaterThanOrEqual(1);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await sessionStore.create(`s${i}`, `Session ${i}`, "local");
        await sessionStore.addMessage(`s${i}`, "user", `msg ${i}`);
        await new Promise(r => setTimeout(r, 5));
      }

      const res = await testRequest(app).get("/api/sessions?limit=2");
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

    it("never lists sessions owned by another user", async () => {
      await sessionStore.create("mine", "My Session", "local");
      await sessionStore.addMessage("mine", "user", "hello");
      await sessionStore.create("theirs", "Other Session", "other-user");
      await sessionStore.addMessage("theirs", "user", "secret");

      const res = await testRequest(app).get("/api/sessions");
      expect(res.status).toBe(200);
      const ids = (res.body.data.sessions as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain("mine");
      expect(ids).not.toContain("theirs");
    });
  });

  // ─── Get ───────────────────────────────────────────────────

  describe("GET /api/sessions/:id", () => {
    it("returns a session with messages", async () => {
      await sessionStore.create("s1", "Test Session", "local");
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

    it("returns 404 for sessions owned by another user", async () => {
      await sessionStore.create("other-session", "Other", "other-user");
      await sessionStore.addMessage("other-session", "user", "secret");

      const res = await testRequest(app).get("/api/sessions/other-session");
      expect(res.status).toBe(404);
    });
  });

  // ─── Patch Title ───────────────────────────────────────────

  describe("PATCH /api/sessions/:id", () => {
    it("updates session title", async () => {
      await sessionStore.create("s1", "Old Title", "local");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({ title: "New Title" });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe("New Title");
    });

    it("rejects missing title", async () => {
      await sessionStore.create("s1", "Title", "local");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("MISSING_PARAM");
    });

    it("rejects non-string title", async () => {
      await sessionStore.create("s1", "Title", "local");
      await sessionStore.addMessage("s1", "user", "msg");

      const res = await testRequest(app).patch("/api/sessions/s1").send({ title: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects title over 200 chars", async () => {
      await sessionStore.create("s1", "Title", "local");
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

    it("returns 404 when patching a session owned by another user", async () => {
      await sessionStore.create("other-session", "Other", "other-user");
      await sessionStore.addMessage("other-session", "user", "secret");

      const res = await testRequest(app)
        .patch("/api/sessions/other-session")
        .send({ title: "Hacked" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Delete ────────────────────────────────────────────────

  describe("DELETE /api/sessions/:id", () => {
    it("deletes a session", async () => {
      await sessionStore.create("s1", "To Delete", "local");
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

    it("returns 404 when deleting a session owned by another user", async () => {
      await sessionStore.create("other-session", "Other", "other-user");
      await sessionStore.addMessage("other-session", "user", "secret");

      const res = await testRequest(app).delete("/api/sessions/other-session");
      expect(res.status).toBe(404);
    });
  });
});

// ═════════════════════════════════════════════════════════════
// Session routes — auth-enabled isolation checks
// ═════════════════════════════════════════════════════════════

describe("Session routes — auth-enabled isolation", () => {
  let app: Express;
  let sessionStore: SessionStore;
  let userStore: UserStore;
  let userASessionToken: string;
  let userBSessionToken: string;
  let admiralSessionToken: string;
  let userAId: string;
  let userBId: string;

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    sessionStore = await createSessionStore(pool);

    const a = await userStore.signUp({
      email: "session-a@test.com",
      password: "securePassword12345!",
      displayName: "Session A",
    });
    const b = await userStore.signUp({
      email: "session-b@test.com",
      password: "securePassword12345!",
      displayName: "Session B",
    });
    const adm = await userStore.signUp({
      email: "session-admiral@test.com",
      password: "securePassword12345!",
      displayName: "Session Admiral",
    });

    await userStore.verifyEmail(a.verifyToken);
    await userStore.verifyEmail(b.verifyToken);
    await userStore.verifyEmail(adm.verifyToken);
    await userStore.setRole(a.user.id, "lieutenant");
    await userStore.setRole(b.user.id, "lieutenant");
    await userStore.setRole(adm.user.id, "admiral");

    userAId = a.user.id;
    userBId = b.user.id;

    userASessionToken = (await userStore.signIn("session-a@test.com", "securePassword12345!")).sessionToken;
    userBSessionToken = (await userStore.signIn("session-b@test.com", "securePassword12345!")).sessionToken;
    admiralSessionToken = (await userStore.signIn("session-admiral@test.com", "securePassword12345!")).sessionToken;

    await sessionStore.create("user-a-session", "User A Session", userAId);
    await sessionStore.addMessage("user-a-session", "user", "a-private");
    await sessionStore.create("user-b-session", "User B Session", userBId);
    await sessionStore.addMessage("user-b-session", "user", "b-private");

    app = createApp(makeState({
      startupComplete: true,
      sessionStore,
      userStore,
      config: makeConfig({ authEnabled: true, adminToken: ADMIN_TOKEN }),
    }));
  });

  it("user list endpoint only returns own sessions", async () => {
    const resA = await testRequest(app)
      .get("/api/sessions")
      .set("Cookie", `majel_session=${userASessionToken}`);
    expect(resA.status).toBe(200);
    const idsA = (resA.body.data.sessions as Array<{ id: string }>).map((s) => s.id);
    expect(idsA).toContain("user-a-session");
    expect(idsA).not.toContain("user-b-session");

    const resB = await testRequest(app)
      .get("/api/sessions")
      .set("Cookie", `majel_session=${userBSessionToken}`);
    expect(resB.status).toBe(200);
    const idsB = (resB.body.data.sessions as Array<{ id: string }>).map((s) => s.id);
    expect(idsB).toContain("user-b-session");
    expect(idsB).not.toContain("user-a-session");
  });

  it("get/patch/delete return 404 for cross-user access, including admiral", async () => {
    const userAToBGet = await testRequest(app)
      .get("/api/sessions/user-b-session")
      .set("Cookie", `majel_session=${userASessionToken}`);
    expect(userAToBGet.status).toBe(404);

    const userAToBPatch = await testRequest(app)
      .patch("/api/sessions/user-b-session")
      .set("Cookie", `majel_session=${userASessionToken}`)
      .send({ title: "attempted" });
    expect(userAToBPatch.status).toBe(404);

    const userAToBDelete = await testRequest(app)
      .delete("/api/sessions/user-b-session")
      .set("Cookie", `majel_session=${userASessionToken}`);
    expect(userAToBDelete.status).toBe(404);

    const admiralToAGet = await testRequest(app)
      .get("/api/sessions/user-a-session")
      .set("Cookie", `majel_session=${admiralSessionToken}`);
    expect(admiralToAGet.status).toBe(404);

    const admiralToAPatch = await testRequest(app)
      .patch("/api/sessions/user-a-session")
      .set("Cookie", `majel_session=${admiralSessionToken}`)
      .send({ title: "attempted-admiral" });
    expect(admiralToAPatch.status).toBe(404);

    const admiralToADelete = await testRequest(app)
      .delete("/api/sessions/user-a-session")
      .set("Cookie", `majel_session=${admiralSessionToken}`);
    expect(admiralToADelete.status).toBe(404);
  });
});
