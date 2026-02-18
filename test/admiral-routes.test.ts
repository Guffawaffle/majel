/**
 * admiral-routes.test.ts — Admiral Route Validation Edge Cases
 *
 * Tests uncovered branches in admiral.ts:
 * - inviteStore null (already partly covered, but some endpoints missing)
 * - Input validation: label, maxUses, expiresIn
 * - Long code/id checks
 * - delete-all-sessions
 * - createCode catch path
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createInviteStore, type InviteStore } from "../src/server/stores/invite-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

const ADMIN_TOKEN = "test-admiral-routes-token";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    adminPool: null,
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    crewStore: null,
    receiptStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    userStore: null,
    targetStore: null,
    auditStore: null,
    startupComplete: true,
    config: { ...bootstrapConfigSync(), adminToken: ADMIN_TOKEN, authEnabled: true },
    ...overrides,
  };
}

const bearer = `Bearer ${ADMIN_TOKEN}`;

describe("Admiral routes — inviteStore null", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState());
  });

  it("POST /invites → 503", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer).send({});
    expect(res.status).toBe(503);
  });

  it("GET /invites → 503", async () => {
    const res = await testRequest(app).get("/api/admiral/invites").set("Authorization", bearer);
    expect(res.status).toBe(503);
  });

  it("DELETE /invites/:code → 503", async () => {
    const res = await testRequest(app).delete("/api/admiral/invites/abc").set("Authorization", bearer);
    expect(res.status).toBe(503);
  });

  it("GET /sessions → 503", async () => {
    const res = await testRequest(app).get("/api/admiral/sessions").set("Authorization", bearer);
    expect(res.status).toBe(503);
  });

  it("DELETE /sessions/:id → 503", async () => {
    const res = await testRequest(app).delete("/api/admiral/sessions/abc").set("Authorization", bearer);
    expect(res.status).toBe(503);
  });

  it("DELETE /sessions (all) → 503", async () => {
    const res = await testRequest(app).delete("/api/admiral/sessions").set("Authorization", bearer);
    expect(res.status).toBe(503);
  });
});

describe("Admiral routes — input validation", () => {
  let app: Express;
  let inviteStore: InviteStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
    app = createApp(makeState({ inviteStore }));
  });

  // ── POST /invites validation ──

  it("rejects label > 200 chars", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ label: "x".repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("200");
  });

  it("rejects non-string label", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ label: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects maxUses < 1", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ maxUses: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("maxUses");
  });

  it("rejects maxUses > 10000", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ maxUses: 10001 });
    expect(res.status).toBe(400);
  });

  it("rejects non-integer maxUses", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ maxUses: 1.5 });
    expect(res.status).toBe(400);
  });

  it("rejects expiresIn > 20 chars", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ expiresIn: "x".repeat(21) });
    expect(res.status).toBe(400);
  });

  it("rejects non-string expiresIn", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ expiresIn: 42 });
    expect(res.status).toBe(400);
  });

  it("creates invite with all valid params", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer)
      .send({ label: "Test", maxUses: 5, expiresIn: "7d" });
    expect(res.status).toBe(201);
  });

  it("creates invite with no params (defaults)", async () => {
    const res = await testRequest(app).post("/api/admiral/invites").set("Authorization", bearer).send({});
    expect(res.status).toBe(201);
  });

  // ── DELETE /invites/:code validation ──

  it("rejects code > 100 chars", async () => {
    const res = await testRequest(app).delete("/api/admiral/invites/" + "x".repeat(101)).set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown code", async () => {
    const res = await testRequest(app).delete("/api/admiral/invites/nonexistent").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  // ── DELETE /sessions/:id validation ──

  it("rejects session id > 100 chars", async () => {
    const res = await testRequest(app).delete("/api/admiral/sessions/" + "x".repeat(101)).set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown session", async () => {
    const res = await testRequest(app).delete("/api/admiral/sessions/nonexistent").set("Authorization", bearer);
    expect(res.status).toBe(404);
  });

  // ── DELETE /sessions (all) ──

  it("delete-all returns count 0 when no sessions", async () => {
    const res = await testRequest(app).delete("/api/admiral/sessions").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(0);
  });
});
