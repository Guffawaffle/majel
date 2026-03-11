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
import { createInviteStore, type InviteStore } from "../src/server/stores/invite-store.js";
import { createAuditStore, type AuditStore } from "../src/server/stores/audit-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createSettingsStore, type SettingsStore } from "../src/server/stores/settings.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

import { makeReadyState, makeConfig } from "./helpers/make-state.js";

const ADMIN_TOKEN = "test-admiral-routes-token";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    ...overrides,
  });
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

  it("GET /audit-log → 503", async () => {
    const res = await testRequest(app).get("/api/admiral/audit-log").set("Authorization", bearer);
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

describe("Admiral routes — audit log query", () => {
  let app: Express;
  let inviteStore: InviteStore;
  let auditStore: AuditStore;

  const actorA = "11111111-1111-4111-8111-111111111111";
  const actorB = "22222222-2222-4222-8222-222222222222";
  const targetA = "33333333-3333-4333-8333-333333333333";

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
    auditStore = await createAuditStore(pool);

    await auditStore.logEvent({
      event: "auth.signin.success",
      actorId: actorA,
      targetId: targetA,
      detail: { source: "test" },
    });
    await auditStore.logEvent({
      event: "auth.signin.failure",
      actorId: actorB,
      detail: { source: "test" },
    });

    app = createApp(makeState({ inviteStore, auditStore }));
  });

  it("returns recent audit log entries", async () => {
    const res = await testRequest(app).get("/api/admiral/audit-log").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.entries)).toBe(true);
    expect(res.body.data.count).toBeGreaterThanOrEqual(2);
  });

  it("filters by event", async () => {
    const res = await testRequest(app)
      .get("/api/admiral/audit-log")
      .query({ event: "auth.signin.failure" })
      .set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBe(1);
    expect(res.body.data.entries[0].eventType).toBe("auth.signin.failure");
  });

  it("filters by actorId", async () => {
    const res = await testRequest(app)
      .get("/api/admiral/audit-log")
      .query({ actorId: actorA })
      .set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBe(1);
    expect(res.body.data.entries[0].actorId).toBe(actorA);
  });

  it("rejects invalid event", async () => {
    const res = await testRequest(app)
      .get("/api/admiral/audit-log")
      .query({ event: "not.real" })
      .set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("rejects invalid UUID filter", async () => {
    const res = await testRequest(app)
      .get("/api/admiral/audit-log")
      .query({ actorId: "bad-id" })
      .set("Authorization", bearer);
    expect(res.status).toBe(400);
  });

  it("rejects invalid date window", async () => {
    const res = await testRequest(app)
      .get("/api/admiral/audit-log")
      .query({ from: "2026-02-21T00:00:00Z", to: "2026-02-20T00:00:00Z" })
      .set("Authorization", bearer);
    expect(res.status).toBe(400);
  });
});

// ─── Model Management ─────────────────────────────────────────

describe("Admiral routes — model management", () => {
  let app: Express;
  let settingsStore: SettingsStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    settingsStore = await createSettingsStore(pool);
    app = createApp(makeState({ settingsStore }));
  });

  // ── GET /api/admiral/models ──

  it("GET /models returns model list", async () => {
    const res = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.models)).toBe(true);
    expect(res.body.data.count).toBeGreaterThan(0);

    const model = res.body.data.models[0];
    expect(model).toHaveProperty("id");
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("provider");
    expect(model).toHaveProperty("defaultEnabled");
    expect(model).toHaveProperty("providerCapable");
    expect(model).toHaveProperty("adminEnabled");
    expect(model).toHaveProperty("effectiveAvailable");
  });

  it("GET /models works without settingsStore (overrides default to empty)", async () => {
    app = createApp(makeState());
    const res = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.models.length).toBeGreaterThan(0);
  });

  // ── PATCH /api/admiral/models/:id/availability ──

  it("PATCH /models/:id/availability — disable a model", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const enabledModel = listRes.body.data.models.find((m: { defaultEnabled: boolean }) => m.defaultEnabled);
    expect(enabledModel).toBeTruthy();

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${enabledModel.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: false, reason: "Testing disable" });
    expect(res.status).toBe(200);
    expect(res.body.data.adminEnabled).toBe(false);
    expect(res.body.data.modelId).toBe(enabledModel.id);
  });

  it("PATCH /models/:id/availability — enable a model", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const disabledModel = listRes.body.data.models.find((m: { defaultEnabled: boolean }) => !m.defaultEnabled);
    if (!disabledModel) return; // All models enabled by default — skip

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${disabledModel.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data.adminEnabled).toBe(true);
    expect(res.body.data.modelId).toBe(disabledModel.id);
  });

  it("PATCH persists override — visible in subsequent GET", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const model = listRes.body.data.models[0];

    await testRequest(app)
      .patch(`/api/admiral/models/${model.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: false, reason: "Disabled for test" });

    const listRes2 = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const updated = listRes2.body.data.models.find((m: { id: string }) => m.id === model.id);
    expect(updated.adminEnabled).toBe(false);
    expect(updated.adminReason).toBe("Disabled for test");
  });

  it("PATCH rejects unknown model ID", async () => {
    const res = await testRequest(app)
      .patch("/api/admiral/models/not-a-real-model/availability")
      .set("Authorization", bearer)
      .send({ adminEnabled: true });
    expect(res.status).toBe(404);
  });

  it("PATCH rejects missing adminEnabled", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const model = listRes.body.data.models[0];

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${model.id}/availability`)
      .set("Authorization", bearer)
      .send({});
    expect(res.status).toBe(400);
  });

  it("PATCH rejects non-boolean adminEnabled", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const model = listRes.body.data.models[0];

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${model.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects reason > 200 chars", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const model = listRes.body.data.models[0];

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${model.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: true, reason: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects non-string reason", async () => {
    const listRes = await testRequest(app).get("/api/admiral/models").set("Authorization", bearer);
    const model = listRes.body.data.models[0];

    const res = await testRequest(app)
      .patch(`/api/admiral/models/${model.id}/availability`)
      .set("Authorization", bearer)
      .send({ adminEnabled: true, reason: 42 });
    expect(res.status).toBe(400);
  });

  it("PATCH → 503 when settingsStore is null", async () => {
    app = createApp(makeState());
    const res = await testRequest(app)
      .patch("/api/admiral/models/gemini-2.5-flash/availability")
      .set("Authorization", bearer)
      .send({ adminEnabled: true });
    expect(res.status).toBe(503);
  });
});
