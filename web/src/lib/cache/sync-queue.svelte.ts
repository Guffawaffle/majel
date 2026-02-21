/**
 * sync-queue.ts — Background sync queue for offline mutations.
 *
 * ADR-032 Phase 3: Queues failed mutations in memory for replay
 * when connectivity returns. Non-persistent (cleared on page reload).
 *
 * Design: Simple queue with replay. Mutations are functions that
 * return Promises. On reconnect, they're retried in order.
 */

export interface QueuedMutation {
  id: string;
  label: string;
  execute: () => Promise<void>;
  queuedAt: number;
}

let queue = $state<QueuedMutation[]>([]);
let replaying = $state(false);

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
}

/** Remove a specific item from the queue. */
export function dequeue(id: string): void {
  queue = queue.filter((m) => m.id !== id);
}

/** Clear the entire queue. */
export function clearQueue(): void {
  queue = [];
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

  for (const item of queue) {
    try {
      await item.execute();
      successCount++;
    } catch {
      // Keep failed items for next retry
      remaining.push(item);
    }
  }

  queue = remaining;
  replaying = false;
  return successCount;
}
