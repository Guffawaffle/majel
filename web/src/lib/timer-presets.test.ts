/**
 * timer-presets.test.ts — Unit tests for the preset seed data module.
 *
 * Tests: getVisiblePresets, getPresetById, immutability of defaults.
 */

import { describe, it, expect } from "vitest";
import { getVisiblePresets, getPresetById } from "./timer-presets.js";

// ─── getVisiblePresets ──────────────────────────────────────

describe("getVisiblePresets", () => {
  it("returns 5 default presets", () => {
    expect(getVisiblePresets()).toHaveLength(5);
  });

  it("returns presets sorted by sortOrder", () => {
    const presets = getVisiblePresets();
    for (let i = 1; i < presets.length; i++) {
      expect(presets[i].sortOrder).toBeGreaterThan(presets[i - 1].sortOrder);
    }
  });

  it("returns the expected stable IDs in order", () => {
    const ids = getVisiblePresets().map((p) => p.id);
    expect(ids).toEqual([
      "default-30s",
      "default-1m",
      "default-3m",
      "default-5m",
      "default-10m",
    ]);
  });

  it("returns copies, not references to seed data", () => {
    const a = getVisiblePresets();
    const b = getVisiblePresets();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });

  it("mutations to returned presets do not affect seed data", () => {
    const presets = getVisiblePresets();
    presets[0].label = "MUTATED";
    presets[0].visible = false;
    const fresh = getVisiblePresets();
    expect(fresh[0].label).toBe("30s");
    expect(fresh[0].visible).toBe(true);
  });

  it("all default presets have kind 'default'", () => {
    for (const p of getVisiblePresets()) {
      expect(p.kind).toBe("default");
    }
  });

  it("returns expected durations in ms", () => {
    const durations = getVisiblePresets().map((p) => p.durationMs);
    expect(durations).toEqual([30_000, 60_000, 180_000, 300_000, 600_000]);
  });
});

// ─── getPresetById ──────────────────────────────────────────

describe("getPresetById", () => {
  it("resolves an existing default preset", () => {
    const preset = getPresetById("default-3m");
    expect(preset).toBeDefined();
    expect(preset!.label).toBe("3m");
    expect(preset!.durationMs).toBe(180_000);
    expect(preset!.kind).toBe("default");
  });

  it("returns undefined for a nonexistent ID", () => {
    expect(getPresetById("nonexistent")).toBeUndefined();
  });

  it("returns a copy, not the seed reference", () => {
    const a = getPresetById("default-1m");
    const b = getPresetById("default-1m");
    expect(a).not.toBe(b);
  });

  it("resolves each default ID correctly", () => {
    const expected: Record<string, number> = {
      "default-30s": 30_000,
      "default-1m": 60_000,
      "default-3m": 180_000,
      "default-5m": 300_000,
      "default-10m": 600_000,
    };
    for (const [id, ms] of Object.entries(expected)) {
      const preset = getPresetById(id);
      expect(preset).toBeDefined();
      expect(preset!.durationMs).toBe(ms);
    }
  });
});
