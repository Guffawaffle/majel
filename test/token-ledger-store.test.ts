import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createTokenLedgerStore } from "../src/server/stores/token-ledger-store.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("token-ledger-store", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("records a token usage entry and reads it back via dailyUsage", async () => {
    const store = await createTokenLedgerStore(pool);

    await store.record({
      userId: "user-1",
      modelId: "gemini-2.0-flash",
      operation: "chat",
      inputTokens: 100,
      outputTokens: 50,
    });

    const usage = await store.dailyUsage("user-1");
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
    expect(usage.callCount).toBe(1);
  });

  it("aggregates multiple records for the same user", async () => {
    const store = await createTokenLedgerStore(pool);

    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 100, outputTokens: 50 });
    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "tool_call", inputTokens: 200, outputTokens: 80 });
    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "summarize", inputTokens: 50, outputTokens: 30 });

    const usage = await store.dailyUsage("user-1");
    expect(usage.inputTokens).toBe(350);
    expect(usage.outputTokens).toBe(160);
    expect(usage.totalTokens).toBe(510);
    expect(usage.callCount).toBe(3);
  });

  it("isolates usage by user", async () => {
    const store = await createTokenLedgerStore(pool);

    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 100, outputTokens: 50 });
    await store.record({ userId: "user-2", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 300, outputTokens: 200 });

    const u1 = await store.dailyUsage("user-1");
    const u2 = await store.dailyUsage("user-2");
    expect(u1.totalTokens).toBe(150);
    expect(u2.totalTokens).toBe(500);
  });

  it("returns zero usage for a user with no records", async () => {
    const store = await createTokenLedgerStore(pool);

    const usage = await store.dailyUsage("ghost-user");
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.callCount).toBe(0);
  });

  it("purges records older than the given interval", async () => {
    const store = await createTokenLedgerStore(pool);

    // Insert a record then backdate it via raw SQL
    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 100, outputTokens: 50 });
    await pool.query(`UPDATE token_ledger SET created_at = NOW() - INTERVAL '100 days'`);

    // Insert a recent record
    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 200, outputTokens: 80 });

    const purged = await store.purgeOlderThan("90 days");
    expect(purged).toBe(1);

    const usage = await store.dailyUsage("user-1");
    expect(usage.inputTokens).toBe(200);
    expect(usage.callCount).toBe(1);
  });

  // ── usageByUser (admin dashboard) ───────────────────────────

  it("usageByUser returns aggregated rows per user per day", async () => {
    const store = await createTokenLedgerStore(pool);

    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 100, outputTokens: 50 });
    await store.record({ userId: "user-1", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 200, outputTokens: 80 });
    await store.record({ userId: "user-2", modelId: "gemini-2.0-flash", operation: "chat", inputTokens: 300, outputTokens: 100 });

    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.usageByUser(today, today);
    expect(rows.length).toBe(2);

    const u1 = rows.find((r) => r.userId === "user-1");
    const u2 = rows.find((r) => r.userId === "user-2");
    expect(u1).toBeDefined();
    expect(u1!.totalTokens).toBe(430);
    expect(u1!.callCount).toBe(2);
    expect(u2).toBeDefined();
    expect(u2!.totalTokens).toBe(400);
    expect(u2!.callCount).toBe(1);
  });

  it("usageByUser returns empty array for date range with no data", async () => {
    const store = await createTokenLedgerStore(pool);
    const rows = await store.usageByUser("2020-01-01", "2020-01-01");
    expect(rows).toEqual([]);
  });
});
