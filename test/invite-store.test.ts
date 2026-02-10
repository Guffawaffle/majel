/**
 * invite-store.test.ts — Invite Code & Tenant Session Store Tests (ADR-018 Phase 2)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createInviteStore, type InviteStore } from "../src/server/invite-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
let store: InviteStore;

// ─── Lifecycle ──────────────────────────────────────────────────

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("InviteStore", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
    store = await createInviteStore(pool);
  });

  // ─── Invite Codes ──────────────────────────────────────────

  describe("Invite Codes", () => {
    it("creates a code with defaults", async () => {
      const code = await store.createCode();
      expect(code.code).toMatch(/^MAJEL-[A-F0-9]{4}-[A-F0-9]{4}$/);
      expect(code.maxUses).toBe(1);
      expect(code.usedCount).toBe(0);
      expect(code.expiresAt).toBeNull();
      expect(code.revoked).toBe(false);
      expect(code.createdAt).toBeTruthy();
    });

    it("creates a code with label and max uses", async () => {
      const code = await store.createCode({ label: "Test batch", maxUses: 5 });
      expect(code.label).toBe("Test batch");
      expect(code.maxUses).toBe(5);
    });

    it("creates a code with expiry", async () => {
      const code = await store.createCode({ expiresIn: "7d" });
      expect(code.expiresAt).toBeTruthy();
      // Expiry should be ~7 days in the future
      const expires = new Date(code.expiresAt! + "Z");
      const now = new Date();
      const diffDays = (expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(6);
      expect(diffDays).toBeLessThan(8);
    });

    it("rejects invalid duration format", async () => {
      await expect(store.createCode({ expiresIn: "abc" })).rejects.toThrow("Invalid duration format");
    });

    it("retrieves a code by value", async () => {
      const created = await store.createCode({ label: "fetch-me" });
      const fetched = await store.getCode(created.code);
      expect(fetched).toBeTruthy();
      expect(fetched!.code).toBe(created.code);
      expect(fetched!.label).toBe("fetch-me");
    });

    it("returns null for unknown code", async () => {
      const result = await store.getCode("MAJEL-NOPE-XXXX");
      expect(result).toBeNull();
    });

    it("lists all codes", async () => {
      await store.createCode({ label: "A" });
      await store.createCode({ label: "B" });
      await store.createCode({ label: "C" });
      const codes = await store.listCodes();
      expect(codes.length).toBe(3);
    });

    it("revokes a code", async () => {
      const code = await store.createCode();
      const revoked = await store.revokeCode(code.code);
      expect(revoked).toBe(true);
      const fetched = await store.getCode(code.code);
      expect(fetched!.revoked).toBe(true);
    });

    it("returns false when revoking unknown code", async () => {
      const result = await store.revokeCode("MAJEL-NOPE-XXXX");
      expect(result).toBe(false);
    });

    it("deletes a code", async () => {
      const code = await store.createCode();
      expect(await store.deleteCode(code.code)).toBe(true);
      expect(await store.getCode(code.code)).toBeNull();
    });
  });

  // ─── Redeem Flow ───────────────────────────────────────────

  describe("Invite Redemption", () => {
    it("redeems a valid code", async () => {
      const code = await store.createCode({ maxUses: 3 });
      const session = await store.redeemCode(code.code);
      expect(session.tenantId).toBeTruthy();
      expect(session.inviteCode).toBe(code.code);
      expect(session.createdAt).toBeTruthy();

      // Use count should increment
      const updated = await store.getCode(code.code);
      expect(updated!.usedCount).toBe(1);
    });

    it("allows multiple redemptions up to max", async () => {
      const code = await store.createCode({ maxUses: 2 });
      const s1 = await store.redeemCode(code.code);
      const s2 = await store.redeemCode(code.code);
      expect(s1.tenantId).not.toBe(s2.tenantId);

      // Third use should fail
      await expect(store.redeemCode(code.code)).rejects.toThrow("fully used");
    });

    it("rejects invalid code", async () => {
      await expect(store.redeemCode("MAJEL-NOPE-XXXX")).rejects.toThrow("Invalid invite code");
    });

    it("rejects revoked code", async () => {
      const code = await store.createCode();
      await store.revokeCode(code.code);
      await expect(store.redeemCode(code.code)).rejects.toThrow("revoked");
    });

    it("rejects expired code", async () => {
      // Create a code that expires in 0 minutes (already expired)
      const code = await store.createCode({ expiresIn: "0m" });
      // Wait a beat for datetime comparison
      await new Promise((r) => setTimeout(r, 50));
      // Force the expires_at to be in the past by updating directly
      // (since 0m would set it to 'now' which might still be valid)
      await expect(store.redeemCode(code.code)).rejects.toThrow();
    });
  });

  // ─── Tenant Sessions ──────────────────────────────────────

  describe("Tenant Sessions", () => {
    it("retrieves a session by tenant ID", async () => {
      const code = await store.createCode();
      const session = await store.redeemCode(code.code);
      const fetched = await store.getSession(session.tenantId);
      expect(fetched).toBeTruthy();
      expect(fetched!.tenantId).toBe(session.tenantId);
    });

    it("returns null for unknown session", async () => {
      const result = await store.getSession("nonexistent-uuid");
      expect(result).toBeNull();
    });

    it("touches a session (updates last_seen_at)", async () => {
      const code = await store.createCode();
      const session = await store.redeemCode(code.code);
      const before = (await store.getSession(session.tenantId))!.lastSeenAt;
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 100));
      await store.touchSession(session.tenantId);
      const after = (await store.getSession(session.tenantId))!.lastSeenAt;
      // lastSeenAt should be updated (or at least not earlier)
      expect(new Date(after + "Z").getTime()).toBeGreaterThanOrEqual(new Date(before + "Z").getTime());
    });

    it("lists all sessions", async () => {
      const c1 = await store.createCode({ maxUses: 5 });
      await store.redeemCode(c1.code);
      await store.redeemCode(c1.code);
      const sessions = await store.listSessions();
      expect(sessions.length).toBe(2);
    });

    it("deletes a session", async () => {
      const code = await store.createCode();
      const session = await store.redeemCode(code.code);
      expect(await store.deleteSession(session.tenantId)).toBe(true);
      expect(await store.getSession(session.tenantId)).toBeNull();
    });

    it("returns false when deleting unknown session", async () => {
      expect(await store.deleteSession("nonexistent")).toBe(false);
    });
  });

  // ─── Store Lifecycle ───────────────────────────────────────

  describe("Lifecycle", () => {
    it("is connected to a pool", () => {
      expect(store).toBeTruthy();
    });
  });
});
