/**
 * cache-keys.test.ts — Unit tests for cache key construction and TTLs.
 */

import { describe, it, expect } from "vitest";
import { cacheKey, TTL, INVALIDATION_MAP } from "./cache-keys.js";

describe("cacheKey", () => {
  it("strips /api/ prefix and converts slashes to colons", () => {
    expect(cacheKey("/api/catalog/officers/merged")).toBe("catalog:officers:merged");
  });

  it("handles endpoints without /api/ prefix", () => {
    expect(cacheKey("catalog/officers/merged")).toBe("catalog:officers:merged");
  });

  it("appends sorted query params", () => {
    const key = cacheKey("/api/catalog/officers/merged", { rarity: "epic", q: "kirk" });
    expect(key).toBe("catalog:officers:merged?q=kirk&rarity=epic");
  });

  it("omits null/undefined/empty filter values", () => {
    const key = cacheKey("/api/catalog/officers/merged", {
      q: "",
      rarity: null,
      group: undefined,
      ownership: "owned",
    });
    expect(key).toBe("catalog:officers:merged?ownership=owned");
  });

  it("returns base key when no filters have values", () => {
    const key = cacheKey("/api/catalog/officers/merged", { q: "", rarity: null });
    expect(key).toBe("catalog:officers:merged");
  });

  it("strips existing query string from endpoint", () => {
    const key = cacheKey("/api/catalog/officers/merged?q=old", { q: "new" });
    expect(key).toBe("catalog:officers:merged?q=new");
  });

  it("handles no filters", () => {
    expect(cacheKey("/api/catalog/counts")).toBe("catalog:counts");
  });
});

describe("TTL constants", () => {
  it("REFERENCE is 24 hours in ms", () => {
    expect(TTL.REFERENCE).toBe(86_400_000);
  });

  it("OVERLAY is 5 minutes in ms", () => {
    expect(TTL.OVERLAY).toBe(300_000);
  });

  it("COMPOSITION is 10 minutes in ms", () => {
    expect(TTL.COMPOSITION).toBe(600_000);
  });

  it("VOLATILE is 0", () => {
    expect(TTL.VOLATILE).toBe(0);
  });
});

describe("INVALIDATION_MAP", () => {
  it("officer-overlay invalidates officers and counts", () => {
    expect(INVALIDATION_MAP["officer-overlay"]).toEqual([
      "catalog:officers:merged*",
      "catalog:counts",
    ]);
  });

  it("ship-overlay invalidates ships and counts", () => {
    expect(INVALIDATION_MAP["ship-overlay"]).toEqual([
      "catalog:ships:merged*",
      "catalog:counts",
    ]);
  });

  it("bulk operations defined", () => {
    expect(INVALIDATION_MAP["bulk-officer-overlay"]).toBeDefined();
    expect(INVALIDATION_MAP["bulk-ship-overlay"]).toBeDefined();
  });
});
