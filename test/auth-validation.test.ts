/**
 * auth-validation.test.ts — Auth Route Input Validation Tests
 *
 * Focused on hitting every input-validation branch in auth routes:
 * signup, signin, verify-email, change-password, forgot-password,
 * reset-password, set-role, lock, delete, dev-verify.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testRequest } from "./helpers/test-request.js";
import type { Express } from "express";
import { createApp } from "../src/server/index.js";
import type { AppState } from "../src/server/app-context.js";
import { createUserStore, type UserStore } from "../src/server/stores/user-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

import { makeReadyState, makeConfig } from "./helpers/make-state.js";

const ADMIN_TOKEN = "test-admiral-auth-validation";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════
// userStore = null → 503
// ═══════════════════════════════════════════════════════════

describe("Auth routes — userStore unavailable", () => {
  let app: Express;

  beforeEach(() => {
    app = createApp(makeState({ startupComplete: true }));
  });

  for (const [method, path] of [
    ["post", "/api/auth/signup"],
    ["post", "/api/auth/verify-email"],
    ["post", "/api/auth/signin"],
    ["post", "/api/auth/forgot-password"],
    ["post", "/api/auth/reset-password"],
  ] as const) {
    it(`${method.toUpperCase()} ${path} → 503`, async () => {
      const res = await (testRequest(app) as any)[method](path).send({});
      expect(res.status).toBe(503);
    });
  }
});

// ═══════════════════════════════════════════════════════════
// Input Validation — signup
// ═══════════════════════════════════════════════════════════

describe("Auth routes — signup validation", () => {
  let app: Express;
  let userStore: UserStore;

  beforeAll(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
  });

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing email", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ password: "securePassword12345!", displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string email", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: 123, password: "securePassword12345!", displayName: "X" });
    expect(res.status).toBe(400);
  });

  it("rejects email > 254 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a".repeat(255), password: "securePassword12345!", displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("254");
  });

  it("rejects missing password", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string password", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: 123, displayName: "X" });
    expect(res.status).toBe(400);
  });

  it("rejects password < 15 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: "short", displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("15 characters");
  });

  it("rejects password > 200 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: "x".repeat(201), displayName: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("200");
  });

  it("rejects missing displayName", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: "securePassword12345!" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string displayName", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: "securePassword12345!", displayName: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects displayName > 100 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({ email: "a@b.com", password: "securePassword12345!", displayName: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("100");
  });

  it("returns 201 on valid signup", async () => {
    const res = await testRequest(app).post("/api/auth/signup").send({
      email: "valid@example.com", password: "securePassword12345!", displayName: "Valid User",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe("valid@example.com");
  });

  it("returns 400 on duplicate email", async () => {
    await testRequest(app).post("/api/auth/signup").send({
      email: "dupe@example.com", password: "securePassword12345!", displayName: "A",
    });
    const res = await testRequest(app).post("/api/auth/signup").send({
      email: "dupe@example.com", password: "securePassword12345!", displayName: "B",
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Input Validation — signin
// ═══════════════════════════════════════════════════════════

describe("Auth routes — signin validation", () => {
  let app: Express;
  let userStore: UserStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing email", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ password: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string email", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: 42, password: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects email > 254 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: "a".repeat(255), password: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects missing password", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: "a@b.com" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string password", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: "a@b.com", password: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects password > 200 chars", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: "a@b.com", password: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("returns 401 for bad credentials", async () => {
    const res = await testRequest(app).post("/api/auth/signin").send({ email: "no@one.com", password: "badpass123" });
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════
// Input Validation — verify-email
// ═══════════════════════════════════════════════════════════

describe("Auth routes — verify-email validation", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing token", async () => {
    const res = await testRequest(app).post("/api/auth/verify-email").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string token", async () => {
    const res = await testRequest(app).post("/api/auth/verify-email").send({ token: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects token > 500 chars", async () => {
    const res = await testRequest(app).post("/api/auth/verify-email").send({ token: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  it("rejects invalid token", async () => {
    const res = await testRequest(app).post("/api/auth/verify-email").send({ token: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("expired");
  });
});

// ═══════════════════════════════════════════════════════════
// Input Validation — forgot-password
// ═══════════════════════════════════════════════════════════

describe("Auth routes — forgot-password validation", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing email", async () => {
    const res = await testRequest(app).post("/api/auth/forgot-password").send({});
    expect(res.status).toBe(400);
  });

  it("rejects non-string email", async () => {
    const res = await testRequest(app).post("/api/auth/forgot-password").send({ email: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects email > 254 chars", async () => {
    const res = await testRequest(app).post("/api/auth/forgot-password").send({ email: "a".repeat(255) });
    expect(res.status).toBe(400);
  });

  it("returns 200 even for unknown email (no reveal)", async () => {
    const res = await testRequest(app).post("/api/auth/forgot-password").send({ email: "nobody@test.com" });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// Input Validation — reset-password
// ═══════════════════════════════════════════════════════════

describe("Auth routes — reset-password validation", () => {
  let app: Express;

  beforeEach(async () => {
    await cleanDatabase(pool);
    const userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing token", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ newPassword: "securePassword12345!" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string token", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: 42, newPassword: "securePassword12345!" });
    expect(res.status).toBe(400);
  });

  it("rejects token > 500 chars", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "x".repeat(501), newPassword: "securePassword12345!" });
    expect(res.status).toBe(400);
  });

  it("rejects missing newPassword", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_PARAM");
  });

  it("rejects non-string newPassword", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "abc", newPassword: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects newPassword < 15 chars", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "abc", newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects newPassword > 200 chars", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "abc", newPassword: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("rejects bogus token", async () => {
    const res = await testRequest(app).post("/api/auth/reset-password").send({ token: "bogus", newPassword: "securePassword12345!" });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Admiral Routes — set-role, lock, delete, users
// ═══════════════════════════════════════════════════════════

describe("Auth routes — admiral management", () => {
  let app: Express;
  let userStore: UserStore;
  const bearer = `Bearer ${ADMIN_TOKEN}`;

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  // ── set-role ──
  describe("POST /api/auth/admiral/set-role", () => {
    it("rejects missing email", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ role: "captain" });
      expect(res.status).toBe(400);
    });

    it("rejects non-string email", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: 42, role: "captain" });
      expect(res.status).toBe(400);
    });

    it("rejects email > 254 chars", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: "a".repeat(255), role: "captain" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid role", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: "a@b.com", role: "invalid" });
      expect(res.status).toBe(400);
    });

    it("rejects missing role", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: "a@b.com" });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown user", async () => {
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: "nobody@x.com", role: "captain" });
      expect(res.status).toBe(404);
    });

    it("promotes a user", async () => {
      await userStore.signUp({ email: "promo@test.com", password: "securePassword12345!", displayName: "P" });
      const res = await testRequest(app).post("/api/auth/admiral/set-role")
        .set("Authorization", bearer).send({ email: "promo@test.com", role: "captain" });
      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe("captain");
    });
  });

  // ── lock / unlock ──
  describe("PATCH /api/auth/admiral/lock", () => {
    it("rejects missing email", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ locked: true });
      expect(res.status).toBe(400);
    });

    it("rejects non-string email", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: 42, locked: true });
      expect(res.status).toBe(400);
    });

    it("rejects email > 254", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "a".repeat(255), locked: true });
      expect(res.status).toBe(400);
    });

    it("rejects missing locked boolean", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "a@b.com" });
      expect(res.status).toBe(400);
    });

    it("rejects non-boolean locked", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "a@b.com", locked: "yes" });
      expect(res.status).toBe(400);
    });

    it("rejects reason > 500 chars", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "a@b.com", locked: true, reason: "x".repeat(501) });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown user", async () => {
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "nobody@x.com", locked: true });
      expect(res.status).toBe(404);
    });

    it("locks a user", async () => {
      await userStore.signUp({ email: "lock@test.com", password: "securePassword12345!", displayName: "L" });
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "lock@test.com", locked: true, reason: "test" });
      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain("locked");
    });

    it("unlocks a user", async () => {
      await userStore.signUp({ email: "unlock@test.com", password: "securePassword12345!", displayName: "U" });
      await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "unlock@test.com", locked: true });
      const res = await testRequest(app).patch("/api/auth/admiral/lock")
        .set("Authorization", bearer).send({ email: "unlock@test.com", locked: false });
      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain("unlocked");
    });
  });

  // ── delete user ──
  describe("DELETE /api/auth/admiral/user", () => {
    it("rejects missing email", async () => {
      const res = await testRequest(app).delete("/api/auth/admiral/user")
        .set("Authorization", bearer).send({});
      expect(res.status).toBe(400);
    });

    it("rejects non-string email", async () => {
      const res = await testRequest(app).delete("/api/auth/admiral/user")
        .set("Authorization", bearer).send({ email: 42 });
      expect(res.status).toBe(400);
    });

    it("rejects email > 254", async () => {
      const res = await testRequest(app).delete("/api/auth/admiral/user")
        .set("Authorization", bearer).send({ email: "a".repeat(255) });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown user", async () => {
      const res = await testRequest(app).delete("/api/auth/admiral/user")
        .set("Authorization", bearer).send({ email: "nobody@x.com" });
      expect(res.status).toBe(404);
    });

    it("deletes a user", async () => {
      await userStore.signUp({ email: "del@test.com", password: "securePassword12345!", displayName: "D" });
      const res = await testRequest(app).delete("/api/auth/admiral/user")
        .set("Authorization", bearer).send({ email: "del@test.com" });
      expect(res.status).toBe(200);
    });
  });

  // ── list users ──
  describe("GET /api/auth/admiral/users", () => {
    it("lists all users", async () => {
      await userStore.signUp({ email: "u1@test.com", password: "securePassword12345!", displayName: "U1" });
      const res = await testRequest(app).get("/api/auth/admiral/users")
        .set("Authorization", bearer);
      expect(res.status).toBe(200);
      expect(res.body.data.users.length).toBeGreaterThanOrEqual(1);
    });

    it("returns 503 when userStore is null", async () => {
      const nullApp = createApp(makeState({ startupComplete: true }));
      const res = await testRequest(nullApp).get("/api/auth/admiral/users")
        .set("Authorization", bearer);
      expect(res.status).toBe(503);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// Change Password route validation
// ═══════════════════════════════════════════════════════════

describe("Auth routes — change-password validation", () => {
  let app: Express;
  let userStore: UserStore;
  let sessionToken: string;

  beforeEach(async () => {
    await cleanDatabase(pool);
    userStore = await createUserStore(pool);
    const signup = await userStore.signUp({ email: "cpw@test.com", password: "oldPassword12345!!!", displayName: "CPW" });
    await userStore.verifyEmail(signup.verifyToken);
    const signin = await userStore.signIn("cpw@test.com", "oldPassword12345!!!");
    sessionToken = signin.sessionToken;
    app = createApp(makeState({ userStore, startupComplete: true }));
  });

  it("rejects missing currentPassword", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ newPassword: "newPassword12345!!!" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string currentPassword", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: 42, newPassword: "newPassword12345!!!" });
    expect(res.status).toBe(400);
  });

  it("rejects currentPassword > 200 chars", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "x".repeat(201), newPassword: "newPassword12345!!!" });
    expect(res.status).toBe(400);
  });

  it("rejects missing newPassword", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "oldPassword12345!!!" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string newPassword", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "oldPassword12345!!!", newPassword: 42 });
    expect(res.status).toBe(400);
  });

  it("rejects newPassword < 15 chars", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "oldPassword12345!!!", newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects newPassword > 200 chars", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "oldPassword12345!!!", newPassword: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("rejects wrong current password", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "wrongOldPass12345!", newPassword: "newPassword12345!!!" });
    expect(res.status).toBe(400);
  });

  it("succeeds with correct passwords", async () => {
    const res = await testRequest(app).post("/api/auth/change-password")
      .set("Cookie", `majel_session=${sessionToken}`)
      .send({ currentPassword: "oldPassword12345!!!", newPassword: "newPassword12345!!!" });
    expect(res.status).toBe(200);
  });
});
