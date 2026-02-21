/**
 * sync-queue.test.ts — Unit tests for the background sync queue.
 *
 * ADR-032 Phase 3: Tests queue/dequeue/replay/clear operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getQueue,
  isReplaying,
  enqueue,
  enqueueIntent,
  dequeue,
  clearQueue,
  replayQueue,
} from "./sync-queue.svelte.js";

describe("sync queue", () => {
  beforeEach(() => {
    clearQueue();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("majel-sync-queue-v1");
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty", () => {
    expect(getQueue()).toHaveLength(0);
  });

  it("enqueues a mutation", () => {
    enqueue("test", async () => {});
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].label).toBe("test");
  });

  it("enqueues multiple mutations in order", () => {
    enqueue("first", async () => {});
    enqueue("second", async () => {});
    expect(getQueue()).toHaveLength(2);
    expect(getQueue()[0].label).toBe("first");
    expect(getQueue()[1].label).toBe("second");
  });

  it("dequeues by id", () => {
    enqueue("a", async () => {});
    enqueue("b", async () => {});
    const id = getQueue()[0].id;
    dequeue(id);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].label).toBe("b");
  });

  it("clears the entire queue", () => {
    enqueue("a", async () => {});
    enqueue("b", async () => {});
    clearQueue();
    expect(getQueue()).toHaveLength(0);
  });

  it("replays and removes successful mutations", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    enqueue("mutation", fn);
    const count = await replayQueue();
    expect(count).toBe(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(getQueue()).toHaveLength(0);
  });

  it("keeps failed mutations in queue after replay", async () => {
    const fail = vi.fn().mockRejectedValue(new Error("fail"));
    enqueue("failing", fail);
    const count = await replayQueue();
    expect(count).toBe(0);
    expect(getQueue()).toHaveLength(1);
  });

  it("replays mixed success/failure correctly", async () => {
    const ok = vi.fn().mockResolvedValue(undefined);
    const fail = vi.fn().mockRejectedValue(new Error("fail"));
    enqueue("success", ok);
    enqueue("failure", fail);
    enqueue("success2", ok);
    const count = await replayQueue();
    expect(count).toBe(2);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].label).toBe("failure");
  });

  it("returns 0 if queue is empty", async () => {
    const count = await replayQueue();
    expect(count).toBe(0);
  });

  it("isReplaying is false when idle", () => {
    expect(isReplaying()).toBe(false);
  });

  it("assigns unique IDs", () => {
    enqueue("a", async () => {});
    enqueue("b", async () => {});
    const ids = getQueue().map((q) => q.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("records queuedAt timestamp", () => {
    const before = Date.now();
    enqueue("timed", async () => {});
    const after = Date.now();
    const ts = getQueue()[0].queuedAt;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("persists intent items for durability", () => {
    enqueueIntent({
      label: "persist me",
      lockKey: "dock:1",
      method: "PUT",
      path: "/api/crew/docks/1",
      body: { label: "Alpha" },
      mutationKey: "crew-dock",
    });

    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem("majel-sync-queue-v1");
      expect(raw).toBeTruthy();
      expect(raw).toContain("persist me");
      expect(raw).toContain("/api/crew/docks/1");
    }
  });

  it("replays durable intent items through fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    enqueueIntent({
      label: "replay me",
      lockKey: "dock:1",
      method: "PUT",
      path: "/api/crew/docks/1",
      body: { label: "Bravo" },
      mutationKey: "crew-dock",
    });

    const count = await replayQueue();
    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/crew/docks/1", expect.objectContaining({
      method: "PUT",
      credentials: "same-origin",
    }));
    expect(getQueue()).toHaveLength(0);
  });

  it("defers later same-lock intents when an earlier one fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: vi.fn().mockResolvedValue({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);

    enqueueIntent({
      label: "first",
      lockKey: "dock:1",
      method: "PUT",
      path: "/api/crew/docks/1",
      body: { label: "First" },
      mutationKey: "crew-dock",
    });
    enqueueIntent({
      label: "second",
      lockKey: "dock:1",
      method: "PUT",
      path: "/api/crew/docks/1",
      body: { label: "Second" },
      mutationKey: "crew-dock",
    });

    const count = await replayQueue();
    expect(count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getQueue()).toHaveLength(2);
  });
});
