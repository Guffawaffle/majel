/**
 * timer-audio.test.ts — Tests for the timer audio engine.
 *
 * Verifies SOUND_NAMES registry and playSound() interface.
 * Actual audio output is mocked (no Web Audio hardware needed).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ─── Web Audio Mock ─────────────────────────────────────────

function makeGain() {
  return {
    connect: vi.fn(),
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  };
}

function makeOscillator() {
  return {
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    type: "sine",
    frequency: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  };
}

const mockCtx = {
  state: "running",
  currentTime: 0,
  resume: vi.fn().mockResolvedValue(undefined),
  createOscillator: vi.fn(() => makeOscillator()),
  createGain: vi.fn(() => makeGain()),
  destination: {},
};

vi.stubGlobal("AudioContext", vi.fn(function AudioContextMock() { return mockCtx; }));

import { SOUND_NAMES, playSound } from "./timer-audio.js";

// ─── SOUND_NAMES ─────────────────────────────────────────────

describe("SOUND_NAMES", () => {
  it("has exactly 10 entries", () => {
    expect(SOUND_NAMES).toHaveLength(10);
  });

  it("contains Bridge Bell as first entry", () => {
    expect(SOUND_NAMES[0]).toBe("Bridge Bell");
  });

  it("contains Sonar as last entry", () => {
    expect(SOUND_NAMES[9]).toBe("Sonar");
  });

  it("all entries are non-empty strings", () => {
    for (const name of SOUND_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

// ─── playSound ──────────────────────────────────────────────

describe("playSound", () => {
  it("resolves without error for valid sound IDs (0–9)", async () => {
    for (let i = 0; i < 10; i++) {
      await expect(playSound(i)).resolves.toBeUndefined();
    }
  });

  it("uses the AudioContext to generate sound 0", async () => {
    // Measure call count delta to be independent of prior test runs.
    const before = mockCtx.createOscillator.mock.calls.length;
    await playSound(0);
    const after = mockCtx.createOscillator.mock.calls.length;
    expect(after).toBeGreaterThan(before);
  });

  it("silently ignores out-of-range sound ID (negative)", async () => {
    await expect(playSound(-1)).resolves.toBeUndefined();
  });

  it("silently ignores out-of-range sound ID (>9)", async () => {
    await expect(playSound(10)).resolves.toBeUndefined();
  });

  it("silently ignores out-of-range sound ID (very large)", async () => {
    await expect(playSound(999)).resolves.toBeUndefined();
  });

  it("does not throw even if AudioContext throws", async () => {
    vi.stubGlobal("AudioContext", vi.fn(function() { throw new Error("no audio"); }));
    try {
      await expect(playSound(0)).resolves.toBeUndefined();
    } finally {
      // Restore so this doesn't bleed into other tests.
      vi.stubGlobal("AudioContext", vi.fn(function AudioContextMock() { return mockCtx; }));
    }
  });
});
