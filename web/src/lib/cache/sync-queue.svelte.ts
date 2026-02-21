/**
 * sync-queue.ts — Background sync queue for offline mutations.
 *
 * ADR-032 Phase 3: Queues failed mutations in memory for replay
 * when connectivity returns. Non-persistent (cleared on page reload).
 *
 * Design: Simple queue with replay. Mutations are functions that
 * return Promises. On reconnect, they're retried in order.
 */

import { invalidateForMutation } from "./cached-fetch.js";

const STORAGE_KEY = "majel-sync-queue-v1";

export interface MutationReplayIntent {
  label: string;
  lockKey: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  mutationKey?: string;
}

export interface QueuedMutation {
  id: string;
  label: string;
  execute?: () => Promise<void>;
  intent?: MutationReplayIntent;
  queuedAt: number;
}

let queue = $state<QueuedMutation[]>(loadQueue());
let replaying = $state(false);

function hasWindowStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function loadQueue(): QueuedMutation[] {
  if (!hasWindowStorage()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      label: string;
      queuedAt: number;
      intent: MutationReplayIntent;
    }>;
    return parsed
      .filter((item) => item && item.id && item.intent)
      .map((item) => ({
        id: item.id,
        label: item.label,
        queuedAt: item.queuedAt,
        intent: item.intent,
      }));
  } catch {
    return [];
  }
}

function persistQueue(): void {
  if (!hasWindowStorage()) return;
  try {
    const serializable = queue
      .filter((item) => item.intent)
      .map((item) => ({
        id: item.id,
        label: item.label,
        queuedAt: item.queuedAt,
        intent: item.intent,
      }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Best-effort persistence
  }
}

async function executeIntent(intent: MutationReplayIntent): Promise<void> {
  const headers: Record<string, string> = {
    "X-Requested-With": "majel-client",
    ...(intent.headers ?? {}),
  };
  const hasBody = intent.body !== undefined;
  if (hasBody) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const response = await fetch(intent.path, {
    method: intent.method,
    credentials: "same-origin",
    headers,
    ...(hasBody ? { body: JSON.stringify(intent.body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Replay failed (${response.status})`);
  }
  if (intent.mutationKey) {
    await invalidateForMutation(intent.mutationKey);
  }
}

/** Get the current queue (reactive). */
export function getQueue(): QueuedMutation[] {
  return queue;
}

/** Whether queue replay is in progress. */
export function isReplaying(): boolean {
  return replaying;
}

/** Queue a mutation for retry when online. */
export function enqueue(label: string, execute: () => Promise<void>): void {
  queue = [
    ...queue,
    {
      id: crypto.randomUUID(),
      label,
      execute,
      queuedAt: Date.now(),
    },
  ];
  persistQueue();
}

/** Queue a durable serializable mutation intent for replay after reload/offline. */
export function enqueueIntent(intent: MutationReplayIntent): void {
  queue = [
    ...queue,
    {
      id: crypto.randomUUID(),
      label: intent.label,
      intent,
      queuedAt: Date.now(),
    },
  ];
  persistQueue();
}

/** Remove a specific item from the queue. */
export function dequeue(id: string): void {
  queue = queue.filter((m) => m.id !== id);
  persistQueue();
}

/** Clear the entire queue. */
export function clearQueue(): void {
  queue = [];
  persistQueue();
}

/**
 * Replay all queued mutations in order.
 * Succeeding items are removed; failing items stay in queue.
 * Returns count of successful replays.
 */
export async function replayQueue(): Promise<number> {
  if (replaying || queue.length === 0) return 0;

  replaying = true;
  let successCount = 0;
  const remaining: QueuedMutation[] = [];
  const failedLocks = new Set<string>();

  for (const item of queue) {
    const lockKey = item.intent?.lockKey;
    if (lockKey && failedLocks.has(lockKey)) {
      remaining.push(item);
      continue;
    }

    try {
      if (item.intent) {
        await executeIntent(item.intent);
      } else if (item.execute) {
        await item.execute();
      }
      successCount++;
    } catch {
      // Keep failed items for next retry
      if (lockKey) failedLocks.add(lockKey);
      remaining.push(item);
    }
  }

  queue = remaining;
  persistQueue();
  replaying = false;
  return successCount;
}
