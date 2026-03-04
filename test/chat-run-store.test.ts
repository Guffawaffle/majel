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

  it("terminalizes stale running jobs when cancel was requested", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_stale_cancel_requested",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "cancel stale" },
    });

    const claimed = await store.claimNext("lock-stale-cancel");
    expect(claimed?.run.status).toBe("running");

    const cancelState = await store.requestCancel("crun_stale_cancel_requested", "user-a");
    expect(cancelState).toBe("running");

    await pool.query(
      `UPDATE chat_runs SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      ["crun_stale_cancel_requested"],
    );

    const recovered = await store.requeueStaleRunning(60_000);
    expect(recovered).toBe(1);

    const run = await store.get("crun_stale_cancel_requested");
    expect(run?.status).toBe("cancelled");
    expect(run?.finishedAt).not.toBeNull();
  });

  it("handles concurrent queued cancellations deterministically", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_cancel_race",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "cancel race" },
    });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => store.requestCancel("crun_cancel_race", "user-a")),
    );

    expect(attempts).toContain("queued");
    expect(attempts.every((value) => value === "queued" || value === "terminal")).toBe(true);

    const run = await store.getForUser("crun_cancel_race", "user-a");
    expect(run?.status).toBe("cancelled");
    expect(run?.cancelRequested).toBe(true);
  });

  it("preserves coherent terminal state under finish-vs-timeout race", async () => {
    const store = await createChatRunStore(pool);

    await store.enqueue({
      id: "crun_finish_timeout_race",
      userId: "user-a",
      sessionId: "s1",
      tabId: "t1",
      requestJson: { message: "race" },
    });

    const claim = await store.claimNext("lock-race");
    expect(claim).not.toBeNull();

    const [finishApplied] = await Promise.all([
      store.finish("crun_finish_timeout_race", "lock-race", "succeeded"),
      pool.query(
        `UPDATE chat_runs
         SET status = 'timed_out',
             lock_token = NULL,
             finished_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        ["crun_finish_timeout_race"],
      ),
    ]);

    const run = await store.get("crun_finish_timeout_race");
    expect(run).not.toBeNull();
    expect(["succeeded", "timed_out"]).toContain(run!.status);
    expect(run!.status).not.toBe("running");
    expect(run!.finishedAt).not.toBeNull();
    expect(await store.heartbeat("crun_finish_timeout_race", "lock-race")).toBe(false);

    if (run!.status === "succeeded") {
      expect(finishApplied).toBe(true);
    }
    if (run!.status === "timed_out") {
      expect(finishApplied).toBe(false);
    }
  });
});
