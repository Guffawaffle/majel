/**
 * translator.test.ts — Unit tests for External Overlay Translator engine (#78 Phase 5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Covers: resolveSourcePath, applyTransform, translate (core engine).
 */

import { describe, it, expect } from "vitest";
import {
  resolveSourcePath,
  applyTransform,
  translate,
} from "../src/server/services/translator/index.js";
import type { TranslatorConfig, FieldTransform } from "../src/server/services/translator/index.js";

// ─── resolveSourcePath ──────────────────────────────────────

describe("resolveSourcePath", () => {
  it("resolves nested dot-notation paths", () => {
    const payload = { data: { officers: [1, 2, 3] } };
    expect(resolveSourcePath(payload, "data.officers")).toEqual([1, 2, 3]);
  });

  it("returns undefined for missing intermediate segment", () => {
    const payload = { data: { officers: [1] } };
    expect(resolveSourcePath(payload, "data.ships")).toBeUndefined();
  });

  it("returns undefined when traversing through null", () => {
    const payload = { data: null };
    expect(resolveSourcePath(payload, "data.officers")).toBeUndefined();
  });

  it("returns undefined when traversing through a primitive", () => {
    const payload = { data: 42 };
    expect(resolveSourcePath(payload, "data.officers")).toBeUndefined();
  });

  it("resolves top-level key with single segment", () => {
    const payload = { officers: ["a"] };
    expect(resolveSourcePath(payload, "officers")).toEqual(["a"]);
  });

  it("returns undefined for empty string path segment against root", () => {
    const payload = { "": "hidden" };
    // split("") on "" gives [""], which matches the "" key
    expect(resolveSourcePath(payload, "")).toBe("hidden");
  });

  it("handles undefined payload", () => {
    expect(resolveSourcePath(undefined, "a.b")).toBeUndefined();
  });

  it("handles null payload", () => {
    expect(resolveSourcePath(null, "a.b")).toBeUndefined();
  });
});

// ─── applyTransform ─────────────────────────────────────────

describe("applyTransform", () => {
  describe("lookup", () => {
    it("maps through table when key exists", () => {
      const transform: FieldTransform = {
        type: "lookup",
        table: { "1": "Ensign", "2": "Lieutenant" },
      };
      expect(applyTransform(1, transform)).toBe("Ensign");
    });

    it("returns original value when key not in table", () => {
      const transform: FieldTransform = {
        type: "lookup",
        table: { "1": "Ensign" },
      };
      expect(applyTransform(99, transform)).toBe(99);
    });

    it("returns original value when table is undefined", () => {
      const transform: FieldTransform = { type: "lookup" };
      expect(applyTransform("hello", transform)).toBe("hello");
    });
  });

  describe("toString", () => {
    it("coerces number to string", () => {
      expect(applyTransform(42, { type: "toString" })).toBe("42");
    });

    it("coerces boolean to string", () => {
      expect(applyTransform(true, { type: "toString" })).toBe("true");
    });

    it("coerces null to string", () => {
      expect(applyTransform(null, { type: "toString" })).toBe("null");
    });
  });

  describe("toNumber", () => {
    it("coerces numeric string to number", () => {
      expect(applyTransform("42", { type: "toNumber" })).toBe(42);
    });

    it("returns null for non-numeric string (NaN)", () => {
      expect(applyTransform("abc", { type: "toNumber" })).toBeNull();
    });

    it("coerces boolean to number", () => {
      expect(applyTransform(true, { type: "toNumber" })).toBe(1);
    });
  });

  describe("toBoolean", () => {
    it("converts 'true' string → true", () => {
      expect(applyTransform("true", { type: "toBoolean" })).toBe(true);
    });

    it("converts 'yes' string → true", () => {
      expect(applyTransform("yes", { type: "toBoolean" })).toBe(true);
    });

    it("converts '1' string → true", () => {
      expect(applyTransform("1", { type: "toBoolean" })).toBe(true);
    });

    it("converts 'false' string → false", () => {
      expect(applyTransform("false", { type: "toBoolean" })).toBe(false);
    });

    it("converts '0' string → false", () => {
      expect(applyTransform("0", { type: "toBoolean" })).toBe(false);
    });

    it("converts 'no' string → false", () => {
      expect(applyTransform("no", { type: "toBoolean" })).toBe(false);
    });

    it("converts empty string → false", () => {
      expect(applyTransform("", { type: "toBoolean" })).toBe(false);
    });

    it("falls back to Boolean() for non-string truthy value", () => {
      expect(applyTransform(1, { type: "toBoolean" })).toBe(true);
    });

    it("falls back to Boolean() for non-string falsy value", () => {
      expect(applyTransform(0, { type: "toBoolean" })).toBe(false);
    });
  });
});

// ─── translate ──────────────────────────────────────────────

/** Minimal config: officers + ships, no docks. */
const BASE_CONFIG: TranslatorConfig = {
  name: "Test Translator",
  version: "1.0",
  sourceType: "test-source",
  officers: {
    sourcePath: "officers",
    idField: "id",
    idPrefix: "test:officer:",
    fieldMap: {
      level: "level",
      rank: "rank",
      power: "power",
    },
    defaults: { owned: true },
    transforms: {
      level: { type: "toNumber" },
    },
  },
  ships: {
    sourcePath: "ships",
    idField: "id",
    idPrefix: "test:ship:",
    fieldMap: {
      tier: "tier",
      level: "level",
    },
  },
};

describe("translate", () => {
  it("translates valid payload with officers + ships", () => {
    const payload = {
      officers: [
        { id: "kirk", level: "50", rank: "Captain", power: 9000 },
        { id: "spock", level: "45", rank: "Commander", power: 8500 },
      ],
      ships: [{ id: "enterprise", tier: 8, level: 40 }],
    };

    const result = translate(BASE_CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data!.version).toBe("1.0");
    expect(result.data!.source).toBe("test-source");
    expect(result.data!.officers).toHaveLength(2);
    expect(result.data!.ships).toHaveLength(1);
    expect(result.stats.officers.translated).toBe(2);
    expect(result.stats.ships.translated).toBe(1);
  });

  it("sets correct refId with prefix + source id", () => {
    const payload = {
      officers: [{ id: "kirk", level: "50", rank: "Captain", power: 9000 }],
      ships: [{ id: "ent", tier: 8, level: 40 }],
    };

    const result = translate(BASE_CONFIG, payload);
    expect(result.data!.officers![0].refId).toBe("test:officer:kirk");
    expect(result.data!.ships![0].refId).toBe("test:ship:ent");
  });

  it("generates warning when sourcePath does not resolve to an array", () => {
    const payload = { officers: "not-an-array", ships: [] };
    const result = translate(BASE_CONFIG, payload);

    expect(result.warnings).toContain(
      "officers: sourcePath 'officers' did not resolve to an array",
    );
  });

  it("generates warning and increments errored for items missing idField", () => {
    const payload = {
      officers: [{ level: 50, rank: "Captain" }], // no 'id'
      ships: [],
    };

    const result = translate(BASE_CONFIG, payload);
    expect(result.stats.officers.errored).toBe(1);
    expect(result.warnings.some((w) => w.includes("missing idField"))).toBe(true);
  });

  it("returns success=false and data=null for non-object payload", () => {
    const result = translate(BASE_CONFIG, "not-an-object");
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.warnings).toContain("payload must be a non-null object");
  });

  it("returns success=false and data=null for null payload", () => {
    const result = translate(BASE_CONFIG, null);
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it("returns success=false and data=null for array payload", () => {
    const result = translate(BASE_CONFIG, [1, 2, 3]);
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it("returns success=false when no entities are translated (empty arrays)", () => {
    const payload = { officers: [], ships: [] };
    const result = translate(BASE_CONFIG, payload);
    expect(result.success).toBe(false);
    expect(result.warnings).toContain("no entities were successfully translated");
  });

  it("applies defaults for missing fields", () => {
    const payload = {
      officers: [{ id: "kirk", level: "50", rank: "Captain" }],
      ships: [],
    };

    const result = translate(BASE_CONFIG, payload);
    // The 'owned' default should be applied
    const officer = result.data!.officers![0] as Record<string, unknown>;
    expect(officer.owned).toBe(true);
  });

  it("applies transforms correctly (toNumber on level)", () => {
    const payload = {
      officers: [{ id: "kirk", level: "50", rank: "Captain", power: 9000 }],
      ships: [],
    };

    const result = translate(BASE_CONFIG, payload);
    // level was "50" string → should be 50 number via toNumber transform
    expect(result.data!.officers![0].level).toBe(50);
  });

  it("translates docks with shipIdPrefix", () => {
    const config: TranslatorConfig = {
      name: "Dock Test",
      version: "1.0",
      sourceType: "test-docks",
      docks: {
        sourcePath: "docks",
        fieldMap: {
          slot: "number",
          ship_id: "shipId",
        },
        shipIdPrefix: "cdn:ship:",
        transforms: {
          number: { type: "toNumber" },
        },
      },
    };

    const payload = {
      docks: [
        { slot: "1", ship_id: "enterprise" },
        { slot: "2", ship_id: "reliant" },
      ],
    };

    const result = translate(config, payload);
    expect(result.success).toBe(true);
    expect(result.data!.docks).toHaveLength(2);
    expect(result.data!.docks![0].shipId).toBe("cdn:ship:enterprise");
    expect(result.data!.docks![0].number).toBe(1);
    expect(result.data!.docks![1].shipId).toBe("cdn:ship:reliant");
    expect(result.stats.docks.translated).toBe(2);
  });

  it("translates docks without shipIdPrefix", () => {
    const config: TranslatorConfig = {
      name: "Dock Test No Prefix",
      version: "1.0",
      sourceType: "test-docks",
      docks: {
        sourcePath: "docks",
        fieldMap: { ship_id: "shipId" },
      },
    };

    const payload = { docks: [{ ship_id: "enterprise" }] };
    const result = translate(config, payload);
    expect(result.data!.docks![0].shipId).toBe("enterprise");
  });

  it("skips non-object items in entity arrays with errored count", () => {
    const payload = {
      officers: [null, "bad", { id: "kirk", level: "50" }],
      ships: [],
    };

    const result = translate(BASE_CONFIG, payload);
    expect(result.stats.officers.errored).toBe(2);
    expect(result.stats.officers.translated).toBe(1);
    expect(result.warnings.some((w) => w.includes("not a valid object"))).toBe(true);
  });

  it("includes exportDate in output data", () => {
    const payload = {
      officers: [{ id: "kirk", level: 50 }],
      ships: [],
    };

    const result = translate(BASE_CONFIG, payload);
    expect(result.data!.exportDate).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(result.data!.exportDate!).toISOString()).toBe(result.data!.exportDate);
  });
});
