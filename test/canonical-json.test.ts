/**
 * canonical-json.test.ts — Tests for deterministic JSON serialization
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Validates that canonicalStringify produces identical output regardless of
 * object key insertion order, which is critical for tamper-detection hashing
 * after PostgreSQL JSONB round-trips.
 */

import { describe, it, expect } from "vitest";
import { canonicalStringify } from "../src/server/util/canonical-json.js";

describe("canonicalStringify", () => {
  it("sorts top-level object keys alphabetically", () => {
    const a = canonicalStringify({ zebra: 1, alpha: 2, mango: 3 });
    const b = canonicalStringify({ alpha: 2, mango: 3, zebra: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"alpha":2,"mango":3,"zebra":1}');
  });

  it("sorts nested object keys recursively", () => {
    const a = canonicalStringify({ outer: { z: 1, a: 2 }, first: true });
    const b = canonicalStringify({ first: true, outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"first":true,"outer":{"a":2,"z":1}}');
  });

  it("preserves array element order (does not sort arrays)", () => {
    const result = canonicalStringify({ items: [3, 1, 2] });
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it("sorts keys within objects inside arrays", () => {
    const a = canonicalStringify({
      officers: [
        { refId: "kirk", level: 50, rank: "5" },
        { rank: "3", refId: "spock", level: 40 },
      ],
    });
    const b = canonicalStringify({
      officers: [
        { level: 50, rank: "5", refId: "kirk" },
        { level: 40, rank: "3", refId: "spock" },
      ],
    });
    expect(a).toBe(b);
    // Both should have keys in alphabetical order within each object
    expect(a).toContain('"level":50,"rank":"5","refId":"kirk"');
    expect(a).toContain('"level":40,"rank":"3","refId":"spock"');
  });

  it("handles null values", () => {
    expect(canonicalStringify(null)).toBe("null");
  });

  it("handles primitive values", () => {
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("hello")).toBe('"hello"');
    expect(canonicalStringify(true)).toBe("true");
  });

  it("handles empty objects and arrays", () => {
    expect(canonicalStringify({})).toBe("{}");
    expect(canonicalStringify([])).toBe("[]");
  });

  it("handles deeply nested structures (3+ levels)", () => {
    const a = canonicalStringify({
      export: {
        version: "1.0",
        officers: [{ refId: "1", data: { power: 100, level: 50 } }],
      },
    });
    const b = canonicalStringify({
      export: {
        officers: [{ data: { level: 50, power: 100 }, refId: "1" }],
        version: "1.0",
      },
    });
    expect(a).toBe(b);
  });

  it("produces stable hash input for sync_overlay-shaped payload", () => {
    // Simulate what Gemini sends vs what JSONB returns
    const geminiShaped = {
      export: {
        version: "1.0",
        source: "screenshot",
        officers: [
          { refId: "cdn:officer:100", level: 45, rank: "3", owned: true },
          { refId: "cdn:officer:200", level: 30, rank: "2", owned: true },
        ],
      },
      dry_run: false,
    };

    // JSONB might reorder keys differently
    const jsonbReturned = {
      dry_run: false,
      export: {
        officers: [
          { level: 45, owned: true, rank: "3", refId: "cdn:officer:100" },
          { level: 30, owned: true, rank: "2", refId: "cdn:officer:200" },
        ],
        source: "screenshot",
        version: "1.0",
      },
    };

    expect(canonicalStringify(geminiShaped)).toBe(canonicalStringify(jsonbReturned));
  });
});
