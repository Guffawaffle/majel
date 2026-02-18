/**
 * user-settings.test.ts — Per-User Settings Store + Routes (#86)
 *
 * Tests:
 * - Store: user override, fallback chain, validation, deletion
 * - Routes: GET/PUT/DELETE with auth
 * - Isolation: user A's settings don't leak to user B
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createSettingsStore, type SettingsStore } from "../src/server/stores/settings.js";
import { createUserSettingsStore, type UserSettingsStore } from "../src/server/stores/user-settings-store.js";
import { createUserStore, type UserStore } from "../src/server/stores/user-store.js";
import { testRequest } from "./helpers/test-request.js";
import { createApp } from "../src/server/index.js";
import { makeReadyState, makeConfig } from "./helpers/make-state.js";
import type { AppState } from "../src/server/app-context.js";
import type { Express } from "express";

// ─── Setup ──────────────────────────────────────────────────────

let pool: Pool;
let settingsStore: SettingsStore;
let userSettingsStore: UserSettingsStore;
let userStore: UserStore;

beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await cleanDatabase(pool);
  userStore = await createUserStore(pool);
  settingsStore = await createSettingsStore(pool);
  userSettingsStore = await createUserSettingsStore(pool, undefined, settingsStore);
});

// ─── Helper: create a test user ─────────────────────────────────

async function createTestUser(email = "test@example.com", name = "Test User"): Promise<string> {
  const result = await userStore.signUp({ email, password: "securePassword12345!", displayName: name });
  return result.user.id;
}

// ═══════════════════════════════════════════════════════════════
// Store tests
// ═══════════════════════════════════════════════════════════════

describe("UserSettingsStore", () => {
  describe("getForUser", () => {
    it("returns system default when no user override exists", async () => {
      const userId = await createTestUser();
      const entry = await userSettingsStore.getForUser(userId, "display.admiralName");
      expect(entry.value).toBe("Admiral");
      expect(entry.source).not.toBe("user");
    });

    it("returns user override when set", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.admiralName", "Kirk");
      const entry = await userSettingsStore.getForUser(userId, "display.admiralName");
      expect(entry.value).toBe("Kirk");
      expect(entry.source).toBe("user");
    });
  });

  describe("setForUser", () => {
    it("persists a user override", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.theme", "red-alert");
      const entry = await userSettingsStore.getForUser(userId, "display.theme");
      expect(entry.value).toBe("red-alert");
    });

    it("upserts existing override", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.theme", "red-alert");
      await userSettingsStore.setForUser(userId, "display.theme", "andorian");
      const entry = await userSettingsStore.getForUser(userId, "display.theme");
      expect(entry.value).toBe("andorian");
    });

    it("rejects unknown setting key", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "nonexistent.key", "value"),
      ).rejects.toThrow("Unknown setting");
    });

    it("rejects non-overridable setting (system category)", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "system.port", "4000"),
      ).rejects.toThrow("not user-overridable");
    });

    it("rejects non-overridable setting (model category)", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "model.name", "other-model"),
      ).rejects.toThrow("not user-overridable");
    });

    it("validates number type", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "fleet.opsLevel", "not-a-number"),
      ).rejects.toThrow("must be a number");
    });

    it("validates number min", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "fleet.opsLevel", "0"),
      ).rejects.toThrow("minimum is 1");
    });

    it("validates number max", async () => {
      const userId = await createTestUser();
      await expect(
        userSettingsStore.setForUser(userId, "fleet.opsLevel", "999"),
      ).rejects.toThrow("maximum is 80");
    });
  });

  describe("deleteForUser", () => {
    it("removes a user override", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.admiralName", "Kirk");
      const deleted = await userSettingsStore.deleteForUser(userId, "display.admiralName");
      expect(deleted).toBe(true);
      const entry = await userSettingsStore.getForUser(userId, "display.admiralName");
      expect(entry.value).toBe("Admiral"); // back to default
      expect(entry.source).not.toBe("user");
    });

    it("returns false for non-existent override", async () => {
      const userId = await createTestUser();
      const deleted = await userSettingsStore.deleteForUser(userId, "display.theme");
      expect(deleted).toBe(false);
    });
  });

  describe("getAllForUser", () => {
    it("returns only user-overridable settings", async () => {
      const userId = await createTestUser();
      const all = await userSettingsStore.getAllForUser(userId);
      // Should include display.* and fleet.* but NOT model.* or system.*
      const keys = all.map((e) => e.key);
      expect(keys).toContain("display.admiralName");
      expect(keys).toContain("fleet.opsLevel");
      expect(keys).not.toContain("model.name");
      expect(keys).not.toContain("system.port");
    });

    it("marks user overrides with source: user", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.admiralName", "Spock");
      const all = await userSettingsStore.getAllForUser(userId);
      const admiralName = all.find((e) => e.key === "display.admiralName");
      expect(admiralName?.value).toBe("Spock");
      expect(admiralName?.source).toBe("user");
    });
  });

  describe("countForUser", () => {
    it("returns 0 for user with no overrides", async () => {
      const userId = await createTestUser();
      expect(await userSettingsStore.countForUser(userId)).toBe(0);
    });

    it("counts user overrides", async () => {
      const userId = await createTestUser();
      await userSettingsStore.setForUser(userId, "display.admiralName", "Kirk");
      await userSettingsStore.setForUser(userId, "display.theme", "red-alert");
      expect(await userSettingsStore.countForUser(userId)).toBe(2);
    });
  });

  describe("isolation", () => {
    it("user A settings do not affect user B", async () => {
      const userA = await createTestUser("a@example.com", "User A");
      const userB = await createTestUser("b@example.com", "User B");

      await userSettingsStore.setForUser(userA, "display.admiralName", "Kirk");

      const entryA = await userSettingsStore.getForUser(userA, "display.admiralName");
      expect(entryA.value).toBe("Kirk");
      expect(entryA.source).toBe("user");

      const entryB = await userSettingsStore.getForUser(userB, "display.admiralName");
      expect(entryB.value).toBe("Admiral"); // default, not Kirk
      expect(entryB.source).not.toBe("user");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Route tests
// ═══════════════════════════════════════════════════════════════

const ADMIN_TOKEN = "test-user-settings-token";

function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return makeReadyState({
    config: makeConfig({ adminToken: ADMIN_TOKEN, authEnabled: true }),
    ...overrides,
  });
}

describe("User Settings API routes", () => {
  describe("userSettingsStore = null → 503", () => {
    let app: Express;
    beforeEach(async () => {
      app = createApp(makeAppState({ userSettingsStore: null }));
    });

    it("GET /api/user-settings → 503", async () => {
      const res = await testRequest(app).get("/api/user-settings")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(503);
    });

    it("PUT /api/user-settings/display.theme → 503", async () => {
      const res = await testRequest(app).put("/api/user-settings/display.theme")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({ value: "red-alert" });
      expect(res.status).toBe(503);
    });

    it("DELETE /api/user-settings/display.theme → 503", async () => {
      const res = await testRequest(app).delete("/api/user-settings/display.theme")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(503);
    });
  });

  describe("with live store", () => {
    let app: Express;

    beforeEach(async () => {
      await cleanDatabase(pool);
      userStore = await createUserStore(pool);
      settingsStore = await createSettingsStore(pool);
      userSettingsStore = await createUserSettingsStore(pool, undefined, settingsStore);

      app = createApp(makeAppState({
        pool,
        settingsStore,
        userSettingsStore,
        userStore,
      }));
    });

    it("GET /api/user-settings returns settings for authenticated user", async () => {
      const res = await testRequest(app).get("/api/user-settings")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      // In bootstrap/demo mode, userId = deriveAdminUserId — no real user
      // The important thing is it returns 200 with settings array
      expect(res.status).toBe(200);
      expect(res.body.data.settings).toBeInstanceOf(Array);
      expect(res.body.data.overrideCount).toBeDefined();
    });

    it("PUT /api/user-settings/:key validates unknown key", async () => {
      const res = await testRequest(app).put("/api/user-settings/nonexistent.key")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({ value: "whatever" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_PARAM");
    });

    it("PUT /api/user-settings/:key validates non-overridable key", async () => {
      const res = await testRequest(app).put("/api/user-settings/system.port")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({ value: "4000" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not user-overridable/);
    });

    it("PUT /api/user-settings/:key requires value in body", async () => {
      const res = await testRequest(app).put("/api/user-settings/display.theme")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("PUT + GET round-trip works", async () => {
      const putRes = await testRequest(app).put("/api/user-settings/display.theme")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({ value: "red-alert" });
      expect(putRes.status).toBe(200);
      expect(putRes.body.data.status).toBe("updated");

      const getRes = await testRequest(app).get("/api/user-settings")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(getRes.status).toBe(200);
      const theme = getRes.body.data.settings.find((s: { key: string }) => s.key === "display.theme");
      expect(theme?.value).toBe("red-alert");
    });

    it("DELETE /api/user-settings/:key resets to default", async () => {
      // Set then delete
      await testRequest(app).put("/api/user-settings/display.admiralName")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
        .send({ value: "Kirk" });

      const delRes = await testRequest(app).delete("/api/user-settings/display.admiralName")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.status).toBe("reset");
      expect(delRes.body.data.resolvedValue).toBe("Admiral"); // default
    });

    it("DELETE /api/user-settings/:key for non-existent override → not_found", async () => {
      const res = await testRequest(app).delete("/api/user-settings/display.theme")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("not_found");
    });
  });
});
