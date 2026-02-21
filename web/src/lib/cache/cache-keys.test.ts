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

  // ─── Phase 2: Crew entity invalidation rules ──────────────

  it("bridge-core invalidates bridge-cores and effective-state", () => {
    expect(INVALIDATION_MAP["bridge-core"]).toEqual([
      "bridge-cores*",
      "effective-state",
    ]);
  });

  it("crew-loadout invalidates crew:loadouts and effective-state", () => {
    expect(INVALIDATION_MAP["crew-loadout"]).toEqual([
      "crew:loadouts*",
      "effective-state",
    ]);
  });

  it("crew-variant invalidates crew:loadouts", () => {
    expect(INVALIDATION_MAP["crew-variant"]).toEqual([
      "crew:loadouts*",
    ]);
  });

  it("below-deck-policy invalidates below-deck-policies", () => {
    expect(INVALIDATION_MAP["below-deck-policy"]).toEqual([
      "below-deck-policies*",
    ]);
  });

  it("crew-dock invalidates docks, effective-state, and plan", () => {
    expect(INVALIDATION_MAP["crew-dock"]).toEqual([
      "crew:docks*",
      "effective-state",
      "crew:plan*",
    ]);
  });

  it("fleet-preset invalidates presets and effective-state", () => {
    expect(INVALIDATION_MAP["fleet-preset"]).toEqual([
      "fleet-presets*",
      "effective-state",
    ]);
  });

  it("crew-plan invalidates plan items and effective-state", () => {
    expect(INVALIDATION_MAP["crew-plan"]).toEqual([
      "crew:plan*",
      "effective-state",
    ]);
  });

  it("officer-reservation invalidates reservations", () => {
    expect(INVALIDATION_MAP["officer-reservation"]).toEqual([
      "officer-reservations*",
    ]);
  });

  it("import-commit flushes all catalog and crew caches", () => {
    const patterns = INVALIDATION_MAP["import-commit"];
    expect(patterns).toBeDefined();
    expect(patterns.length).toBeGreaterThanOrEqual(6);
    expect(patterns).toContain("catalog:*");
    expect(patterns).toContain("effective-state");
  });

  // ─── Crew key generation ──────────────────────────────────

  it("generates correct crew keys", () => {
    expect(cacheKey("/api/bridge-cores")).toBe("bridge-cores");
    expect(cacheKey("/api/crew/loadouts")).toBe("crew:loadouts");
    expect(cacheKey("/api/crew/docks")).toBe("crew:docks");
    expect(cacheKey("/api/fleet-presets")).toBe("fleet-presets");
    expect(cacheKey("/api/crew/plan")).toBe("crew:plan");
    expect(cacheKey("/api/officer-reservations")).toBe("officer-reservations");
    expect(cacheKey("/api/effective-state")).toBe("effective-state");
    expect(cacheKey("/api/below-deck-policies")).toBe("below-deck-policies");
  });

  it("generates crew keys with filter params", () => {
    expect(cacheKey("/api/crew/loadouts", { shipId: "s1", active: true }))
      .toBe("crew:loadouts?active=true&shipId=s1");
    expect(cacheKey("/api/crew/plan", { dockNumber: 3 }))
      .toBe("crew:plan?dockNumber=3");
  });
});
