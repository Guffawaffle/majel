/**
 * auth.test.ts — Auth Middleware & Routes Tests (ADR-018 Phase 2)
 *
 * Tests the three-tier access control system:
 *   - Demo mode (no MAJEL_ADMIN_TOKEN): everything open
 *   - Admiral: bearer token check
 *   - Visitor: tenant cookie or admiral token
 *   - Auth routes: redeem, logout, status
 *   - Admin routes: invite CRUD, session management
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import { testRequest } from "./helpers/test-request.js";
import { createInviteStore, type InviteStore } from "../src/server/stores/invite-store.js";
import { createApp, type AppState } from "../src/server/index.js";
import { bootstrapConfigSync, type AppConfig } from "../src/server/config.js";
import { envelopeMiddleware, sendOk } from "../src/server/envelope.js";
import { requireAdmiral, requireVisitor, TENANT_COOKIE } from "../src/server/services/auth.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});
const ADMIN_TOKEN = "test-admiral-token-12345";

// ─── Helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...bootstrapConfigSync(),
    ...overrides,
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
    crewStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    userStore: null,
    auditStore: null,
    startupComplete: true,
    config: makeConfig(),
    ...overrides,
  };
}

/** Build a minimal test app with auth middleware on a test endpoint. */
function buildTestApp(appState: AppState) {
  const app = express();
  app.use(envelopeMiddleware);
  app.use(express.json());
  app.use(cookieParser());

  // Protected test routes
  app.get("/test/admiral", requireAdmiral(appState), (_req, res) => {
    sendOk(res, { access: "admiral", tenantId: res.locals.tenantId });
  });
  app.get("/test/visitor", requireVisitor(appState), (_req, res) => {
    sendOk(res, { access: "visitor", tenantId: res.locals.tenantId });
  });
  app.get("/test/public", (_req, res) => {
    sendOk(res, { access: "public" });
  });

  return app;
}

// ─── Demo Mode (auth disabled) ──────────────────────────────────

describe("Auth — Demo Mode (no MAJEL_ADMIN_TOKEN)", () => {
  it("admiral endpoint is open", async () => {
    const state = makeState(); // authEnabled = false (no adminToken)
    const app = buildTestApp(state);
    const res = await testRequest(app).get("/test/admiral");
    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe("admiral");
  });

  it("visitor endpoint is open with tenantId 'local'", async () => {
    const state = makeState();
    const app = buildTestApp(state);
    const res = await testRequest(app).get("/test/visitor");
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe("local");
  });
});

// ─── Admiral Middleware ─────────────────────────────────────────

describe("Auth — requireAdmiral", () => {
  it("rejects requests without Authorization header", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    });
    const app = buildTestApp(state);
    const res = await testRequest(app).get("/test/admiral");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects wrong token", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/admiral")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-Bearer auth", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/admiral")
      .set("Authorization", `Basic ${ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("accepts valid bearer token", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/admiral")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe("admiral");
  });
});

// ─── Visitor Middleware ─────────────────────────────────────────

describe("Auth — requireVisitor", () => {
  let inviteStore: InviteStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
  });

  it("rejects unauthenticated request", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
      inviteStore,
    });
    const app = buildTestApp(state);
    const res = await testRequest(app).get("/test/visitor");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("accepts admiral token as visitor", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
      inviteStore,
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/visitor")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("accepts valid tenant cookie", async () => {
    const code = await inviteStore.createCode();
    const session = await inviteStore.redeemCode(code.code);

    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
      inviteStore,
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/visitor")
      .set("Cookie", `${TENANT_COOKIE}=${session.tenantId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(session.tenantId);
  });

  it("rejects invalid tenant cookie", async () => {
    const state = makeState({
      config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
      inviteStore,
    });
    const app = buildTestApp(state);
    const res = await testRequest(app)
      .get("/test/visitor")
      .set("Cookie", `${TENANT_COOKIE}=nonexistent-uuid`);
    expect(res.status).toBe(401);
  });
});

// ─── Auth Routes ────────────────────────────────────────────────

describe("Auth Routes", () => {
  let inviteStore: InviteStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
  });

  describe("POST /api/auth/redeem", () => {
    it("redeems valid invite code and sets cookie", async () => {
      const code = await inviteStore.createCode();
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/auth/redeem")
        .send({ code: code.code });
      expect(res.status).toBe(201);
      expect(res.body.data.tier).toBe("visitor");
      expect(res.body.data.tenantId).toBeTruthy();
      // Should set cookie
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.startsWith(`${TENANT_COOKIE}=`))).toBe(true);
    });

    it("rejects missing code", async () => {
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/auth/redeem")
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects invalid code", async () => {
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/auth/redeem")
        .send({ code: "NOPE" });
      expect(res.status).toBe(403);
    });

    it("returns demo mode response when auth disabled", async () => {
      const state = makeState({ inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/auth/redeem")
        .send({ code: "anything" });
      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("admiral");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the tenant cookie", async () => {
      const state = makeState({ inviteStore });
      const app = createApp(state);
      const res = await testRequest(app).post("/api/auth/logout");
      expect(res.status).toBe(200);
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      // Cookie should be cleared (expires in the past or max-age=0)
      expect(cookies.some((c: string) => c.includes(TENANT_COOKIE))).toBe(true);
    });
  });

  describe("GET /api/auth/status", () => {
    it("returns admiral tier when auth disabled", async () => {
      const state = makeState({ inviteStore });
      const app = createApp(state);
      const res = await testRequest(app).get("/api/auth/status");
      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("admiral");
      expect(res.body.data.authEnabled).toBe(false);
    });

    it("returns admiral tier with valid bearer token", async () => {
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app)
        .get("/api/auth/status")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("admiral");
    });

    it("returns visitor tier with valid tenant cookie", async () => {
      const code = await inviteStore.createCode();
      const session = await inviteStore.redeemCode(code.code);
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app)
        .get("/api/auth/status")
        .set("Cookie", `${TENANT_COOKIE}=${session.tenantId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("visitor");
    });

    it("returns public tier with no credentials", async () => {
      const state = makeState({
        config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
        inviteStore,
      });
      const app = createApp(state);
      const res = await testRequest(app).get("/api/auth/status");
      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("public");
    });
  });
});

// ─── Admin Routes ───────────────────────────────────────────────

describe("Admin Routes", () => {
  let inviteStore: InviteStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
  });

  const authConfig = () => makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true });
  const authHeaders = () => ({ Authorization: `Bearer ${ADMIN_TOKEN}` });

  describe("POST /api/admiral/invites", () => {
    it("creates an invite code", async () => {
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/admiral/invites")
        .set(authHeaders())
        .send({ label: "Test", maxUses: 5, expiresIn: "7d" });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toMatch(/^MAJEL-/);
      expect(res.body.data.maxUses).toBe(5);
    });

    it("rejects without admiral token", async () => {
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .post("/api/admiral/invites")
        .send({ label: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admiral/invites", () => {
    it("lists invite codes", async () => {
      await inviteStore.createCode({ label: "A" });
      await inviteStore.createCode({ label: "B" });
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .get("/api/admiral/invites")
        .set(authHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
    });
  });

  describe("DELETE /api/admiral/invites/:code", () => {
    it("revokes an invite code", async () => {
      const code = await inviteStore.createCode();
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .delete(`/api/admiral/invites/${code.code}`)
        .set(authHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.revoked).toBe(true);

      // Verify it's actually revoked
      const fetched = await inviteStore.getCode(code.code);
      expect(fetched!.revoked).toBe(true);
    });

    it("returns 404 for unknown code", async () => {
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .delete("/api/admiral/invites/MAJEL-NOPE-XXXX")
        .set(authHeaders());
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/admiral/sessions", () => {
    it("lists tenant sessions", async () => {
      const code = await inviteStore.createCode({ maxUses: 5 });
      await inviteStore.redeemCode(code.code);
      await inviteStore.redeemCode(code.code);
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .get("/api/admiral/sessions")
        .set(authHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
    });
  });

  describe("DELETE /api/admiral/sessions/:id", () => {
    it("deletes a tenant session", async () => {
      const code = await inviteStore.createCode();
      const session = await inviteStore.redeemCode(code.code);
      const state = makeState({ config: authConfig(), inviteStore });
      const app = createApp(state);
      const res = await testRequest(app)
        .delete(`/api/admiral/sessions/${session.tenantId}`)
        .set(authHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });
  });
});

// ─── Route Protection Integration ───────────────────────────────

describe("Route Protection (auth enforced)", () => {
  let inviteStore: InviteStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    inviteStore = await createInviteStore(pool);
  });

  const authConfig = () => makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true });

  it("health endpoint is public (no auth needed)", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("catalog GET requires authentication", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    // Catalog reads now require auth — unauthenticated requests get 401
    const res = await testRequest(app).get("/api/catalog/officers");
    expect(res.status).toBe(401);
  });

  it("chat requires admiral token", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app)
      .post("/api/chat")
      .send({ message: "hi" });
    expect(res.status).toBe(401);
  });

  it("settings requires visitor auth", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app).get("/api/settings");
    expect(res.status).toBe(401);
  });

  it("sessions requires visitor auth", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app).get("/api/sessions");
    expect(res.status).toBe(401);
  });

  it("crew routes require visitor auth", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app).get("/api/crew/docks");
    expect(res.status).toBe(401);
  });

  it("diagnostic routes require admiral auth", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app).get("/api/diagnostic/schema");
    expect(res.status).toBe(401);
  });

  it("catalog overlay mutation requires visitor auth", async () => {
    const state = makeState({ config: authConfig(), inviteStore });
    const app = createApp(state);
    const res = await testRequest(app)
      .patch("/api/catalog/officers/test-id/overlay")
      .send({ ownership: "owned" });
    expect(res.status).toBe(401);
  });
});
