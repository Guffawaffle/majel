/**
 * user-store.test.ts — User Store Tests
 *
 * Tests pure functions (deriveAdminUserId, roleLevel) and
 * full integration tests for the PG-backed user store.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  createUserStore,
  deriveAdminUserId,
  roleLevel,
  ROLES,
  type UserStore,
} from "../src/server/stores/user-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

// ─── Pure Function Tests ────────────────────────────────────

describe("deriveAdminUserId", () => {
  it("returns a valid UUID format", () => {
    const uuid = deriveAdminUserId("my-secret-token");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is deterministic (same input → same output)", () => {
    const a = deriveAdminUserId("token-1");
    const b = deriveAdminUserId("token-1");
    expect(a).toBe(b);
  });

  it("produces different UUIDs for different tokens", () => {
    const a = deriveAdminUserId("token-a");
    const b = deriveAdminUserId("token-b");
    expect(a).not.toBe(b);
  });
});

describe("roleLevel", () => {
  it("ensign = 0", () => expect(roleLevel("ensign")).toBe(0));
  it("lieutenant = 1", () => expect(roleLevel("lieutenant")).toBe(1));
  it("captain = 2", () => expect(roleLevel("captain")).toBe(2));
  it("admiral = 3", () => expect(roleLevel("admiral")).toBe(3));
});

describe("ROLES constant", () => {
  it("contains all four roles in order", () => {
    expect(ROLES).toEqual(["ensign", "lieutenant", "captain", "admiral"]);
  });
});

// ─── Integration Tests (PG) ────────────────────────────────

describe("UserStore — integration", () => {
  let pool: Pool;
  let store: UserStore;

  beforeAll(() => {
    pool = createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createUserStore(pool);
  });

  // ── Sign Up ──────────────────────────────────────────

  describe("signUp", () => {
    it("creates a new user and returns verify token", async () => {
      const result = await store.signUp({
        email: "test@example.com",
        password: "securePassword12345!",
        displayName: "Test User",
      });
      expect(result.user.email).toBe("test@example.com");
      expect(result.user.displayName).toBe("Test User");
      expect(result.user.role).toBe("ensign");
      expect(result.user.emailVerified).toBe(false);
      expect(result.verifyToken).toBeTruthy();
    });

    it("rejects invalid email (no @)", async () => {
      await expect(
        store.signUp({ email: "not-an-email", password: "securePassword12345!", displayName: "X" }),
      ).rejects.toThrow("Invalid email");
    });

    it("rejects empty email", async () => {
      await expect(
        store.signUp({ email: "  ", password: "securePassword12345!", displayName: "X" }),
      ).rejects.toThrow("Invalid email");
    });

    it("rejects too-long email", async () => {
      const longEmail = "a".repeat(250) + "@b.com";
      await expect(
        store.signUp({ email: longEmail, password: "securePassword12345!", displayName: "X" }),
      ).rejects.toThrow("Invalid email");
    });

    it("rejects short password", async () => {
      await expect(
        store.signUp({ email: "a@b.com", password: "short", displayName: "X" }),
      ).rejects.toThrow();
    });

    it("rejects too-long password", async () => {
      await expect(
        store.signUp({ email: "a@b.com", password: "x".repeat(201), displayName: "X" }),
      ).rejects.toThrow();
    });

    it("rejects empty display name", async () => {
      await expect(
        store.signUp({ email: "a@b.com", password: "securePassword12345!", displayName: "  " }),
      ).rejects.toThrow("Display name");
    });

    it("rejects too-long display name", async () => {
      await expect(
        store.signUp({ email: "a@b.com", password: "securePassword12345!", displayName: "x".repeat(101) }),
      ).rejects.toThrow("Display name");
    });

    it("rejects duplicate email", async () => {
      await store.signUp({ email: "dupe@test.com", password: "securePassword12345!", displayName: "A" });
      await expect(
        store.signUp({ email: "dupe@test.com", password: "securePassword12345!", displayName: "B" }),
      ).rejects.toThrow("Unable to create account");
    });
  });

  // ── Sign In ──────────────────────────────────────────

  describe("signIn", () => {
    const email = "signin@test.com";
    const password = "correctPassword12345!";

    beforeEach(async () => {
      const result = await store.signUp({ email, password, displayName: "Signer" });
      // Verify email so sign-in works
      await store.verifyEmail(result.verifyToken);
    });

    it("signs in with correct credentials", async () => {
      const result = await store.signIn(email, password);
      expect(result.user.email).toBe(email);
      expect(result.sessionToken).toBeTruthy();
    });

    it("rejects wrong password", async () => {
      await expect(store.signIn(email, "wrongPassword12345!")).rejects.toThrow(
        "Invalid email or password",
      );
    });

    it("rejects nonexistent email (timing-safe)", async () => {
      await expect(store.signIn("nobody@test.com", password)).rejects.toThrow(
        "Invalid email or password",
      );
    });

    it("rejects unverified email", async () => {
      // Create a new unverified user
      await store.signUp({ email: "unverified@test.com", password, displayName: "UV" });
      await expect(store.signIn("unverified@test.com", password)).rejects.toThrow(
        "verify your email",
      );
    });

    it("locks account after max failed attempts", async () => {
      for (let i = 0; i < 5; i++) {
        await store.signIn(email, "wrong" + i).catch(() => {});
      }
      await expect(store.signIn(email, password)).rejects.toThrow("temporarily locked");
    });
  });

  // ── Session Management ───────────────────────────────

  describe("session management", () => {
    let sessionToken: string;
    let userId: string;

    beforeEach(async () => {
      const signup = await store.signUp({ email: "session@test.com", password: "securePassword12345!", displayName: "S" });
      await store.verifyEmail(signup.verifyToken);
      const signin = await store.signIn("session@test.com", "securePassword12345!", "127.0.0.1", "TestAgent/1.0");
      sessionToken = signin.sessionToken;
      userId = signin.user.id;
    });

    it("resolves a valid session", async () => {
      const resolved = await store.resolveSession(sessionToken);
      expect(resolved).not.toBeNull();
      expect(resolved!.userId).toBe(userId);
      expect(resolved!.email).toBe("session@test.com");
    });

    it("returns null for unknown session", async () => {
      const resolved = await store.resolveSession("nonexistent-token");
      expect(resolved).toBeNull();
    });

    it("touches a session (no error)", async () => {
      await expect(store.touchSession(sessionToken)).resolves.not.toThrow();
    });

    it("destroys a session", async () => {
      await store.destroySession(sessionToken);
      const resolved = await store.resolveSession(sessionToken);
      expect(resolved).toBeNull();
    });

    it("destroys all sessions for a user", async () => {
      await store.destroyAllSessions(userId);
      const resolved = await store.resolveSession(sessionToken);
      expect(resolved).toBeNull();
    });

    it("destroys other sessions, keeps current", async () => {
      // Create a second session
      const signin2 = await store.signIn("session@test.com", "securePassword12345!");
      await store.destroyOtherSessions(userId, sessionToken);
      // First session still works
      const r1 = await store.resolveSession(sessionToken);
      expect(r1).not.toBeNull();
      // Second session gone
      const r2 = await store.resolveSession(signin2.sessionToken);
      expect(r2).toBeNull();
    });

    it("lists user sessions", async () => {
      const sessions = await store.listUserSessions(userId);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0]!.userId).toBe(userId);
    });
  });

  // ── Email Verification ───────────────────────────────

  describe("email verification", () => {
    it("verifies email with valid token", async () => {
      const signup = await store.signUp({ email: "v@test.com", password: "securePassword12345!", displayName: "V" });
      const ok = await store.verifyEmail(signup.verifyToken);
      expect(ok).toBe(true);
    });

    it("rejects invalid token", async () => {
      const ok = await store.verifyEmail("bogus-token");
      expect(ok).toBe(false);
    });

    it("createVerifyToken generates a new token", async () => {
      const signup = await store.signUp({ email: "cv@test.com", password: "securePassword12345!", displayName: "CV" });
      const token = await store.createVerifyToken(signup.user.id);
      expect(token).toBeTruthy();
      // Can verify with the new token
      const ok = await store.verifyEmail(token);
      expect(ok).toBe(true);
    });
  });

  // ── Password Reset ───────────────────────────────────

  describe("password reset", () => {
    let email: string;

    beforeEach(async () => {
      email = "reset@test.com";
      const signup = await store.signUp({ email, password: "oldPassword12345!!!", displayName: "R" });
      await store.verifyEmail(signup.verifyToken);
    });

    it("createResetToken returns token for verified user", async () => {
      const token = await store.createResetToken(email);
      expect(token).toBeTruthy();
    });

    it("createResetToken returns null for unknown email", async () => {
      const token = await store.createResetToken("nobody@x.com");
      expect(token).toBeNull();
    });

    it("createResetToken returns null for unverified user", async () => {
      await store.signUp({ email: "unver2@test.com", password: "securePassword12345!", displayName: "UV2" });
      const token = await store.createResetToken("unver2@test.com");
      expect(token).toBeNull();
    });

    it("resetPassword changes the password and kills sessions", async () => {
      // Sign in to create a session
      const signin = await store.signIn(email, "oldPassword12345!!!");
      const token = (await store.createResetToken(email))!;
      const ok = await store.resetPassword(token, "newPassword12345!!!");
      expect(ok).toBe(true);
      // Old session is destroyed
      const r = await store.resolveSession(signin.sessionToken);
      expect(r).toBeNull();
      // Can sign in with new password
      const signin2 = await store.signIn(email, "newPassword12345!!!");
      expect(signin2.user.email).toBe(email);
    });

    it("resetPassword returns false for bogus token", async () => {
      const ok = await store.resetPassword("bogus-token", "newPassword12345!!!");
      expect(ok).toBe(false);
    });

    it("resetPassword rejects weak new password", async () => {
      const token = (await store.createResetToken(email))!;
      await expect(store.resetPassword(token, "short")).rejects.toThrow();
    });
  });

  // ── Change Password ──────────────────────────────────

  describe("changePassword", () => {
    let userId: string;
    let sessionToken: string;

    beforeEach(async () => {
      const signup = await store.signUp({ email: "chg@test.com", password: "oldPassword12345!!!", displayName: "C" });
      await store.verifyEmail(signup.verifyToken);
      const signin = await store.signIn("chg@test.com", "oldPassword12345!!!");
      userId = signin.user.id;
      sessionToken = signin.sessionToken;
    });

    it("changes password and keeps current session", async () => {
      const ok = await store.changePassword(userId, "oldPassword12345!!!", "newPassword12345!!!", sessionToken);
      expect(ok).toBe(true);
      // Current session still works
      const r = await store.resolveSession(sessionToken);
      expect(r).not.toBeNull();
    });

    it("rejects wrong current password", async () => {
      await expect(
        store.changePassword(userId, "wrongPassword12345!", "newPassword12345!!!", sessionToken),
      ).rejects.toThrow("Current password is incorrect");
    });

    it("rejects weak new password", async () => {
      await expect(
        store.changePassword(userId, "oldPassword12345!!!", "short", sessionToken),
      ).rejects.toThrow();
    });

    it("returns false for unknown user ID", async () => {
      const ok = await store.changePassword("00000000-0000-0000-0000-000000000000", "oldPassword12345!!!", "newPassword12345!!!", "x");
      expect(ok).toBe(false);
    });
  });

  // ── User Management (Admiral) ────────────────────────

  describe("admin management", () => {
    let userId: string;

    beforeEach(async () => {
      const signup = await store.signUp({ email: "admin@test.com", password: "securePassword12345!", displayName: "Admin" });
      userId = signup.user.id;
    });

    it("getUser returns user by ID", async () => {
      const user = await store.getUser(userId);
      expect(user).not.toBeNull();
      expect(user!.email).toBe("admin@test.com");
    });

    it("getUser returns null for unknown ID", async () => {
      const user = await store.getUser("00000000-0000-0000-0000-000000000000");
      expect(user).toBeNull();
    });

    it("getUserByEmail finds user", async () => {
      const user = await store.getUserByEmail("admin@test.com");
      expect(user).not.toBeNull();
    });

    it("getUserByEmail returns null for unknown", async () => {
      const user = await store.getUserByEmail("nobody@test.com");
      expect(user).toBeNull();
    });

    it("listUsers returns all users", async () => {
      const users = await store.listUsers();
      expect(users.length).toBeGreaterThanOrEqual(1);
    });

    it("setRole promotes a user", async () => {
      const updated = await store.setRole(userId, "captain");
      expect(updated).not.toBeNull();
      expect(updated!.role).toBe("captain");
    });

    it("setRole returns null for unknown user", async () => {
      const updated = await store.setRole("00000000-0000-0000-0000-000000000000", "captain");
      expect(updated).toBeNull();
    });

    it("lockUser and unlockUser", async () => {
      const locked = await store.lockUser(userId, "test reason");
      expect(locked).toBe(true);
      const unlocked = await store.unlockUser(userId);
      expect(unlocked).toBe(true);
    });

    it("lockUser with default reason", async () => {
      const locked = await store.lockUser(userId);
      expect(locked).toBe(true);
    });

    it("deleteUser removes the user", async () => {
      const deleted = await store.deleteUser(userId);
      expect(deleted).toBe(true);
      const user = await store.getUser(userId);
      expect(user).toBeNull();
    });

    it("deleteUser returns false for unknown", async () => {
      const deleted = await store.deleteUser("00000000-0000-0000-0000-000000000000");
      expect(deleted).toBe(false);
    });

    it("countUsers returns correct count", async () => {
      const count = await store.countUsers();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Cleanup ──────────────────────────────────────────

  describe("cleanupExpiredSessions", () => {
    it("returns count of removed sessions", async () => {
      const count = await store.cleanupExpiredSessions();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Lifecycle ────────────────────────────────────────

  describe("close", () => {
    it("close() does not throw", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
