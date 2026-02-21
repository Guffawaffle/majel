/**
 * cached-fetch.test.ts — Unit tests for the SWR fetch wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { openCache, closeCache, destroyCache, cacheSet, cacheGet } from "./idb-cache.js";
import { cachedFetch, networkFetch, invalidateForMutation } from "./cached-fetch.js";

describe("cachedFetch", () => {
  beforeEach(async () => {
    await openCache("test-swr-user");
  });

  afterEach(async () => {
    await destroyCache();
  });

  // ── MISS ────────────────────────────────────────────────

  it("fetches from network on cache miss", async () => {
    const fetcher = vi.fn().mockResolvedValue([1, 2, 3]);
    const result = await cachedFetch("miss-key", fetcher, 60_000);

    expect(result.data).toEqual([1, 2, 3]);
    expect(result.fromCache).toBe(false);
    expect(result.stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stores fetched data in cache after a miss", async () => {
    const fetcher = vi.fn().mockResolvedValue("stored");
    await cachedFetch("store-key", fetcher, 60_000);

    const entry = await cacheGet("store-key");
    expect(entry).not.toBeNull();
    expect(entry!.data).toBe("stored");
  });

  // ── HIT + FRESH ─────────────────────────────────────────

  it("returns cached data without fetching when fresh", async () => {
    await cacheSet("fresh-key", "cached-value", 60_000);
    const fetcher = vi.fn().mockResolvedValue("network-value");
    const result = await cachedFetch("fresh-key", fetcher, 60_000);

    expect(result.data).toBe("cached-value");
    expect(result.fromCache).toBe(true);
    expect(result.stale).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  // ── HIT + STALE ─────────────────────────────────────────

  it("returns stale data and triggers background revalidation", async () => {
    // Pre-seed with an expired entry (maxAge=1ms, fetchedAt in the past)
    await cacheSet("stale-key", "old-value", 1); // 1ms TTL, immediately stale

    // Give it a moment to ensure it expires
    await new Promise((r) => setTimeout(r, 10));

    let resolveRevalidate!: (v: string) => void;
    const revalidatePromise = new Promise<string>((r) => { resolveRevalidate = r; });
    const fetcher = vi.fn().mockImplementation(() => revalidatePromise);
    const onRevalidate = vi.fn();

    const result = await cachedFetch("stale-key", fetcher, 60_000, onRevalidate);

    expect(result.data).toBe("old-value");
    expect(result.fromCache).toBe(true);
    expect(result.stale).toBe(true);

    // Resolve the background fetch
    resolveRevalidate("new-value");
    await new Promise((r) => setTimeout(r, 50));

    expect(onRevalidate).toHaveBeenCalledWith("new-value");
  });

  // ── VOLATILE ────────────────────────────────────────────

  it("bypasses cache for TTL=0 (VOLATILE)", async () => {
    await cacheSet("volatile-key", "cached", 60_000); // even if something is cached
    const fetcher = vi.fn().mockResolvedValue("fresh");
    const result = await cachedFetch("volatile-key", fetcher, 0);

    expect(result.data).toBe("fresh");
    expect(result.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // ── Cache unavailable ───────────────────────────────────

  it("falls back to network when cache is closed", async () => {
    closeCache();
    const fetcher = vi.fn().mockResolvedValue("network-only");
    const result = await cachedFetch("no-cache-key", fetcher, 60_000);

    expect(result.data).toBe("network-only");
    expect(result.fromCache).toBe(false);
  });

  // ── Dedup ───────────────────────────────────────────────

  it("deduplicates concurrent fetches for the same key", async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return "deduped";
    });

    // Fire two concurrent fetches
    const [r1, r2] = await Promise.all([
      cachedFetch("dedup-key", fetcher, 60_000),
      cachedFetch("dedup-key", fetcher, 60_000),
    ]);

    expect(r1.data).toBe("deduped");
    expect(r2.data).toBe("deduped");
    expect(callCount).toBe(1); // Only one actual network call
  });
});

describe("networkFetch", () => {
  beforeEach(async () => {
    await openCache("test-network-user");
  });

  afterEach(async () => {
    await destroyCache();
  });

  it("always fetches from network and updates cache", async () => {
    await cacheSet("net-key", "old", 60_000);
    const data = await networkFetch("net-key", async () => "fresh", 60_000);

    expect(data).toBe("fresh");
    const entry = await cacheGet("net-key");
    expect(entry!.data).toBe("fresh");
  });

  it("skips cache storage for TTL=0", async () => {
    const data = await networkFetch("volatile-net", async () => "val", 0);
    expect(data).toBe("val");
    const entry = await cacheGet("volatile-net");
    expect(entry).toBeNull();
  });
});

describe("invalidateForMutation", () => {
  beforeEach(async () => {
    await openCache("test-invalidate-user");
  });

  afterEach(async () => {
    await destroyCache();
  });

  it("invalidates officer cache entries on officer-overlay mutation", async () => {
    await cacheSet("catalog:officers:merged", [1], 60_000);
    await cacheSet("catalog:officers:merged?q=kirk", [2], 60_000);
    await cacheSet("catalog:counts", { total: 10 }, 60_000);
    await cacheSet("catalog:ships:merged", [3], 60_000);

    await invalidateForMutation("officer-overlay");

    expect(await cacheGet("catalog:officers:merged")).toBeNull();
    expect(await cacheGet("catalog:officers:merged?q=kirk")).toBeNull();
    expect(await cacheGet("catalog:counts")).toBeNull();
    // Ships unaffected
    expect(await cacheGet("catalog:ships:merged")).not.toBeNull();
  });

  it("is a no-op for unknown mutations", async () => {
    await cacheSet("key", "val", 60_000);
    await invalidateForMutation("unknown-mutation");
    expect(await cacheGet("key")).not.toBeNull();
  });
});
