import { describe, expect, it } from "vitest";
import { runLockedMutation } from "./mutation.js";
import { clearQueue, getQueue, replayQueue } from "../cache/sync-queue.svelte.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function eventually(check: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await flushMicrotasks(2);
  }
  throw new Error("Condition was not met in time");
}

describe("runLockedMutation", () => {
  it("queues a mutation once on retriable network failure", async () => {
    clearQueue();

    await expect(runLockedMutation({
      label: "Dock save",
      lockKey: "dock:99",
      queueOnNetworkError: true,
      mutate: async () => {
        throw new TypeError("Failed to fetch");
      },
    })).rejects.toThrow();

    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].label).toBe("Dock save");
  });

  it("does not enqueue duplicates when queued replay fails again", async () => {
    clearQueue();

    await expect(runLockedMutation({
      label: "Dock save",
      lockKey: "dock:100",
      queueOnNetworkError: true,
      mutate: async () => {
        throw new TypeError("Failed to fetch");
      },
    })).rejects.toThrow();

    expect(getQueue()).toHaveLength(1);
    const replayed = await replayQueue();
    expect(replayed).toBe(0);
    expect(getQueue()).toHaveLength(1);
  });

  it("serializes operations sharing the same lockKey", async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let secondStarted = false;

    const p1 = runLockedMutation({
      label: "first",
      lockKey: "dock:1",
      mutate: async () => {
        await firstGate.promise;
        return 1;
      },
    });

    const p2 = runLockedMutation({
      label: "second",
      lockKey: "dock:1",
      mutate: async () => {
        secondStarted = true;
        await secondGate.promise;
        return 2;
      },
    });

    await flushMicrotasks();
    expect(secondStarted).toBe(false);

    firstGate.resolve();
    await p1;
    await eventually(() => secondStarted);

    secondGate.resolve();
    await p2;
  });

  it("allows operations with different lockKeys to start independently", async () => {
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    let startedA = false;
    let startedB = false;

    const p1 = runLockedMutation({
      label: "a",
      lockKey: "dock:1",
      mutate: async () => {
        startedA = true;
        await gateA.promise;
      },
    });

    const p2 = runLockedMutation({
      label: "b",
      lockKey: "dock:2",
      mutate: async () => {
        startedB = true;
        await gateB.promise;
      },
    });

    await eventually(() => startedA && startedB);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([p1, p2]);
  });
});
