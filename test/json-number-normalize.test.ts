import { describe, expect, it } from "vitest";
import { deepRoundNumbers, serializeNormalizedJson } from "../src/server/services/json-number-normalize.js";

describe("json-number-normalize", () => {
  it("deep-rounds nested numeric values to 6 decimals", () => {
    const input = {
      a: 0.30000000000000004,
      nested: {
        b: 55.300000000000004,
        list: [1.23456789123, { c: 2.5000000000000004 }],
      },
    };

    const rounded = deepRoundNumbers(input, 6);
    expect(rounded).toEqual({
      a: 0.3,
      nested: {
        b: 55.3,
        list: [1.234568, { c: 2.5 }],
      },
    });
  });

  it("serializes normalized JSON for persisted payloads", () => {
    const payload = {
      officer_bonus: {
        attack: [{ value: 0.30000000000000004, bonus: 55.300000000000004 }],
      },
    };

    const json = serializeNormalizedJson(payload, "reference_ships.officer_bonus");
    expect(json).toContain('"value":0.3');
    expect(json).toContain('"bonus":55.3');
    expect(/\d+\.\d{10,}/.test(json ?? "")).toBe(false);
  });

  it("returns null for null payloads", () => {
    expect(serializeNormalizedJson(null, "reference_ships.levels")).toBeNull();
    expect(serializeNormalizedJson(undefined, "reference_ships.levels")).toBeNull();
  });

  it("throws when long-decimal tail remains after normalization", () => {
    const originalStringify = JSON.stringify;
    JSON.stringify = (() => '{"x":0.1234567890123}') as typeof JSON.stringify;
    try {
      expect(() => serializeNormalizedJson({ x: 1 }, "reference_ships.levels")).toThrow(
        /Long-decimal numeric tail detected/,
      );
    } finally {
      JSON.stringify = originalStringify;
    }
  });
});
