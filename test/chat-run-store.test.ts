import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { createChatRunStore } from "../src/server/stores/chat-run-store.js";

let pool: Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe("chat-run-store", () => {
  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  it("enqueues and claims runs in FIFO order", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_a",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "A" },
    });
    await store.enqueue({
      id: "crun_b",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "B" },
    });

    const first = await store.claimNext("lock-1");
    const second = await store.claimNext("lock-2");

    expect(first?.run.id).toBe("crun_a");
    expect(second?.run.id).toBe("crun_b");
  });

  it("supports queued cancellation and marks terminal state", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_cancel",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "cancel me" },
    });

    const result = await store.requestCancel("crun_cancel", "user-a");
    expect(result).toBe("queued");

    const run = await store.getForUser("crun_cancel", "user-a");
    expect(run?.status).toBe("cancelled");
  });

  it("requeues stale running jobs", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_stale",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "stale" },
    });

    const claimed = await store.claimNext("lock-stale");
    expect(claimed?.run.status).toBe("running");

    await pool.query(
      `UPDATE chat_runs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      ["crun_stale"],
    );

    const requeued = await store.requeueStaleRunning(60_000);
    expect(requeued).toBe(1);

    const run = await store.get("crun_stale");
    expect(run?.status).toBe("queued");
  });
});
