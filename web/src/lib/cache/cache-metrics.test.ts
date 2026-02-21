/**
 * cache-metrics.test.ts — Tests for cache performance metrics.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordHit,
  recordMiss,
  recordRevalidation,
  getCacheMetrics,
  resetCacheMetrics,
} from "./cache-metrics.js";

describe("cache-metrics", () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  it("starts at zero", () => {
    const m = getCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.revalidations).toBe(0);
    expect(m.total).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.bytesSaved).toBe(0);
  });

  it("records hits with bandwidth estimate", () => {
    recordHit(1024);
    recordHit(2048);
    const m = getCacheMetrics();
    expect(m.hits).toBe(2);
    expect(m.bytesSaved).toBe(3072);
  });

  it("records misses", () => {
    recordMiss();
    recordMiss();
    recordMiss();
    const m = getCacheMetrics();
    expect(m.misses).toBe(3);
    expect(m.total).toBe(3);
    expect(m.hitRate).toBe(0);
  });

  it("records revalidations separately from hits/misses", () => {
    recordRevalidation();
    const m = getCacheMetrics();
    expect(m.revalidations).toBe(1);
    // Revalidations don't count toward hit rate total
    expect(m.total).toBe(0);
  });

  it("computes hit rate correctly", () => {
    recordHit();
    recordHit();
    recordHit();
    recordMiss();
    const m = getCacheMetrics();
    expect(m.hitRate).toBe(0.75);
  });

  it("resets all counters", () => {
    recordHit(500);
    recordMiss();
    recordRevalidation();
    resetCacheMetrics();
    const m = getCacheMetrics();
    expect(m.hits).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.revalidations).toBe(0);
    expect(m.bytesSaved).toBe(0);
  });
});
