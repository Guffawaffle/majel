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
    expect(status.warning).toBe(false);
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
    expect(status.warning).toBe(false);
  });

  it("allows captain within budget", async () => {
    const status = await budgetStore.checkBudget("user-1", "captain");
    expect(status.dailyLimit).toBe(200000);
    expect(status.remaining).toBe(200000);
    expect(status.source).toBe("rank");
    expect(status.warning).toBe(false);
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
    expect(status.warning).toBe(false);
  });

  // ── Per-user override resolution ────────────────────────────

  it("per-user override takes precedence over rank default", async () => {
    await budgetStore.setOverride("user-1", 100000, "Power user", "admin-1");

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(100000);
    expect(status.source).toBe("override");
    expect(status.warning).toBe(false);
  });

  it("per-user unlimited override (-1) grants unlimited", async () => {
    await budgetStore.setOverride("user-1", -1, "VIP ensign", "admin-1");

    const status = await budgetStore.checkBudget("user-1", "ensign");
    expect(status.dailyLimit).toBe(-1);
    expect(status.remaining).toBe(-1);
    expect(status.source).toBe("unlimited");
    expect(status.warning).toBe(false);
  });

  it("removing override reverts to rank default", async () => {
    await budgetStore.setOverride("user-1", 100000, "Temp boost", "admin-1");
    await budgetStore.removeOverride("user-1");

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.dailyLimit).toBe(50000);
    expect(status.source).toBe("rank");
    expect(status.warning).toBe(false);
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
      expect(e.status.warning).toBe(false);
      return;
    }
    expect.fail("Expected TokenBudgetExceededError to be thrown");
  });

  // ── Warning / padding threshold ─────────────────────────────

  it("sets warning=true when consumed reaches warning threshold", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // lieutenant budget = 50000, default padding = 10% → warning threshold = 45000
    // Record 46000 tokens (above 45000 threshold but below 50000 limit)
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 30000, outputTokens: 16000 });

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.consumed).toBe(46000);
    expect(status.remaining).toBe(4000);
    expect(status.warning).toBe(true);
  });

  it("warning=false when consumed is below warning threshold", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // lieutenant budget = 50000, default padding = 10% → warning threshold = 45000
    // Record 44000 tokens (below 45000 threshold)
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 30000, outputTokens: 14000 });

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.consumed).toBe(44000);
    expect(status.warning).toBe(false);
  });

  it("respects custom padding_pct from settings", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // Set padding to 20% → warning threshold = 50000 - 10000 = 40000
    await settingsStore.set("budget.padding_pct", "20");

    // Record 41000 tokens (above 40000 threshold)
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 25000, outputTokens: 16000 });

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.consumed).toBe(41000);
    expect(status.warning).toBe(true);
  });

  it("warning=false when padding_pct is 0", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // Set padding to 0% → no warning zone
    await settingsStore.set("budget.padding_pct", "0");

    // Record 49000 tokens — very close to limit but padding is disabled
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 30000, outputTokens: 19000 });

    const status = await budgetStore.checkBudget("user-1", "lieutenant");
    expect(status.consumed).toBe(49000);
    expect(status.warning).toBe(false);
  });

  it("exceeded error status has warning=false (past the warning zone)", async () => {
    const ledgerStore = await createTokenLedgerStore(pool);
    budgetStore = await createTokenBudgetStore(pool, pool, settingsStore, ledgerStore);

    // Exceed the lieutenant limit entirely
    await ledgerStore.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 30000, outputTokens: 25000 });

    try {
      await budgetStore.checkBudget("user-1", "lieutenant");
      expect.fail("Expected TokenBudgetExceededError");
    } catch (err) {
      const e = err as TokenBudgetExceededError;
      expect(e.status.consumed).toBe(55000);
      expect(e.status.warning).toBe(false);
    }
  });
});
