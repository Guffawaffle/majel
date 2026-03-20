import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createTokenLedgerStore } from "../src/server/stores/token-ledger-store.js";
import { createTokenBudgetStore, TokenBudgetExceededError } from "../src/server/stores/token-budget-store.js";
import { createSettingsStore, type SettingsStore } from "../src/server/stores/settings.js";
import type { TokenBudgetStore } from "../src/server/stores/token-budget-store.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("token-budget-store", () => {
  let settingsStore: SettingsStore;
  let budgetStore: TokenBudgetStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    settingsStore = await createSettingsStore(pool);
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);
  });

  // ── Rank default resolution ─────────────────────────────────

  it("resolves admiral budget as unlimited by default", async () => {
    const status = await budgetStore.checkBudget("user-1", "admiral");
    expect(status.dailyLimit).toBe(-1);
    expect(status.remaining).toBe(-1);
    expect(status.source).toBe("unlimited");
  });

  it("rejects ensign with zero budget (no LLM access)", async () => {
    await expect(budgetStore.checkBudget("user-1", "ensign")).rejects.toThrow(TokenBudgetExceededError);
    try {
      await budgetStore.checkBudget("user-1", "ensign");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenBudgetExceededError);
      const e = err as TokenBudgetExceededError;
      expect(e.status.dailyLimit).toBe(0);
      expect(e.status.remaining).toBe(0);
      expect(e.status.source).toBe("rank");
    }
  });

  it("allows lieutenant within budget", async () => {
    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(50000);
    expect(status.consumed).toBe(0);
    expect(status.remaining).toBe(50000);
    expect(status.source).toBe("rank");
  });

  it("allows captain within budget", async () => {
    const status = await budgetStore.checkBudget("user-1", "captain");
    expect(status.dailyLimit).toBe(200000);
    expect(status.remaining).toBe(200000);
    expect(status.source).toBe("rank");
  });

  // ── Usage enforcement ───────────────────────────────────────

  it("rejects when usage exceeds rank default budget", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // Record usage that exceeds lieutenant limit (50k)
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 30000, outputTokens: 25000 });

    await expect(budgetStore.checkBudget("user-1", "lieutenant")).rejects.toThrow(TokenBudgetExceededError);
    try {
      await budgetStore.checkBudget("user-1", "lieutenant");
    } catch (err) {
      const e = err as TokenBudgetExceededError;
      expect(e.status.dailyLimit).toBe(50000);
      expect(e.status.consumed).toBe(55000);
      expect(e.status.remaining).toBe(0);
    }
  });

  it("allows when usage is below rank default budget", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 10000, outputTokens: 5000 });

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.consumed).toBe(15000);
    expect(status.remaining).toBe(35000);
  });

  // ── Per-user override resolution ────────────────────────────

  it("per-user override takes precedence over rank default", async () => {
    await budgetStore.setOverride("user-1", 100000, "Power user", "admin-1");

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(100000);
    expect(status.source).toBe("override");
  });

  it("per-user unlimited override (-1) grants unlimited", async () => {
    await budgetStore.setOverride("user-1", -1, "VIP ensign", "admin-1");

    const status = await budgetStore.checkBudget("user-1", "ensign");
    expect(status.dailyLimit).toBe(-1);
    expect(status.remaining).toBe(-1);
    expect(status.source).toBe("unlimited");
  });

  it("removing override reverts to rank default", async () => {
    await budgetStore.setOverride("user-1", 100000, "Temp boost", "admin-1");
    await budgetStore.removeOverride("user-1");

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(50000);
    expect(status.source).toBe("rank");
  });

  // ── Override CRUD ───────────────────────────────────────────

  it("getOverride returns null for users without overrides", async () => {
    const override = await budgetStore.getOverride("user-1");
    expect(override).toBeNull();
  });

  it("setOverride creates and reads back override", async () => {
    await budgetStore.setOverride("user-1", 75000, "Special case", "admin-1");

    const override = await budgetStore.getOverride("user-1");
    expect(override).not.toBeNull();
    expect(override!.dailyLimit).toBe(75000);
    expect(override!.note).toBe("Special case");
    expect(override!.setBy).toBe("admin-1");
  });

  it("setOverride with null dailyLimit removes override", async () => {
    await budgetStore.setOverride("user-1", 75000, "Temp", "admin-1");
    await budgetStore.setOverride("user-1", null, null, "admin-1");

    const override = await budgetStore.getOverride("user-1");
    expect(override).toBeNull();
  });

  it("listOverrides returns all overrides", async () => {
    await budgetStore.setOverride("user-1", 75000, "Boost", "admin-1");
    await budgetStore.setOverride("user-2", -1, "VIP", "admin-1");

    const overrides = await budgetStore.listOverrides();
    expect(overrides.length).toBe(2);
  });

  // ── Admin-configurable rank defaults ────────────────────────

  it("respects admin-changed rank default via settings store", async () => {
    // Change lieutenant budget from 50k to 100k
    await settingsStore.set("budget.lieutenant", "100000");

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(100000);
  });

  // ── BudgetStatus shape ──────────────────────────────────────

  it("resetsAt is a valid ISO date for next UTC midnight", async () => {
    const status = await budgetStore.checkBudget("user-1", "captain");
    const resetDate = new Date(status.resetsAt);
    expect(resetDate.getUTCHours()).toBe(0);
    expect(resetDate.getUTCMinutes()).toBe(0);
    expect(resetDate.getUTCSeconds()).toBe(0);
    expect(resetDate.getTime()).toBeGreaterThan(Date.now());
  });

  // ── Error class ─────────────────────────────────────────────

  it("TokenBudgetExceededError has correct name and status", async () => {
    try {
      await budgetStore.checkBudget("user-1", "ensign");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenBudgetExceededError);
      const e = err as TokenBudgetExceededError;
      expect(e.name).toBe("TokenBudgetExceededError");
      expect(e.status).toBeDefined();
      expect(e.status.dailyLimit).toBe(0);
      return;
    }
    expect.fail("Expected TokenBudgetExceededError to be thrown");
  });
});
