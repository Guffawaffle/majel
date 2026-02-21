import { invalidateForMutation } from "../cache/cached-fetch.js";
import { enqueue, enqueueIntent, type MutationReplayIntent } from "../cache/sync-queue.svelte.js";
import { ApiError } from "./fetch.js";

interface LockedMutationOptions<T> {
  label: string;
  lockKey: string;
  mutate: () => Promise<T>;
  mutationKey?: string;
  queueOnNetworkError?: boolean;
  replayIntent?: MutationReplayIntent;
}

const lockChains = new Map<string, Promise<void>>();

function isRetriableNetworkError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status >= 500;
  }
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "TypeError"
    || msg.includes("failed to fetch")
    || msg.includes("network")
    || msg.includes("load failed")
  );
}

async function withLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = lockChains.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const chain = previous.catch(() => undefined).then(() => gate);
  lockChains.set(lockKey, chain);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (lockChains.get(lockKey) === chain) {
      lockChains.delete(lockKey);
    }
  }
}

export async function runLockedMutation<T>(opts: LockedMutationOptions<T>): Promise<T> {
  return withLock(opts.lockKey, async () => {
    try {
      const result = await opts.mutate();
      if (opts.mutationKey) {
        await invalidateForMutation(opts.mutationKey);
      }
      return result;
    } catch (err) {
      if (opts.queueOnNetworkError && isRetriableNetworkError(err)) {
        if (opts.replayIntent) {
          enqueueIntent(opts.replayIntent);
        } else {
          enqueue(opts.label, async () => {
            await runLockedMutation({
              ...opts,
              queueOnNetworkError: false,
            });
          });
        }
      }
      throw err;
    }
  });
}
