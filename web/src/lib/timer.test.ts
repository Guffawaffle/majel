/**
 * timer.test.ts — Unit tests for the multi-timer store.
 *
 * Tests: createTimer, pauseTimer, resumeTimer, stopTimer,
 *        restartTimer, setRepeating, canAddTimer, MAX_TIMERS,
 *        localStorage persistence (loadFromStorage).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────

// Mock timer-audio so sound playback doesn't fail in test env.
vi.mock("./timer-audio.js", () => ({
  SOUND_NAMES: Array.from({ length: 10 }, (_, i) => `Sound${i}`),
  playSound: vi.fn().mockResolvedValue(undefined),
}));

// Mock localStorage
const _storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => _storage[k] ?? null,
  setItem: (k: string, v: string) => { _storage[k] = v; },
  removeItem: (k: string) => { delete _storage[k]; },
  clear: () => { Object.keys(_storage).forEach(k => delete _storage[k]); },
});

// Import after mocks are set up.
import {
  getTimers,
  createTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  restartTimer,
  setRepeating,
  canAddTimer,
  loadFromStorage,
  MAX_TIMERS,
} from "./timer.svelte.js";

// ─── Helpers ────────────────────────────────────────────────

/** Stop all timers to clean up between tests. */
function clearAllTimers() {
  const ids = getTimers().map((t) => t.id);
  ids.forEach(stopTimer);
}

// ─── MAX_TIMERS ─────────────────────────────────────────────

describe("MAX_TIMERS", () => {
  it("is 10", () => {
    expect(MAX_TIMERS).toBe(10);
  });
});

// ─── createTimer ────────────────────────────────────────────

describe("createTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("adds a timer to the store", () => {
    createTimer({ label: "Test", durationMs: 5000, repeating: false, soundId: 0 });
    expect(getTimers()).toHaveLength(1);
  });

  it("sets initial state to running", () => {
    createTimer({ label: "A", durationMs: 3000, repeating: false, soundId: 1 });
    expect(getTimers()[0].state).toBe("running");
  });

  it("assigns a unique id", () => {
    createTimer({ label: "A", durationMs: 1000, repeating: false, soundId: 0 });
    createTimer({ label: "B", durationMs: 2000, repeating: false, soundId: 0 });
    const ids = getTimers().map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("trims and falls back to 'Timer' for empty label", () => {
    createTimer({ label: "   ", durationMs: 1000, repeating: false, soundId: 0 });
    expect(getTimers()[0].label).toBe("Timer");
  });

  it("clamps soundId to 0–9", () => {
    createTimer({ label: "A", durationMs: 1000, repeating: false, soundId: 99 });
    expect(getTimers()[0].soundId).toBe(9);
    clearAllTimers();
    createTimer({ label: "B", durationMs: 1000, repeating: false, soundId: -5 });
    expect(getTimers()[0].soundId).toBe(0);
  });

  it("sets remainingMs = durationMs initially", () => {
    createTimer({ label: "A", durationMs: 7500, repeating: false, soundId: 0 });
    const t = getTimers()[0];
    expect(t.remainingMs).toBe(t.durationMs);
  });

  it("stores the repeating flag", () => {
    createTimer({ label: "R", durationMs: 1000, repeating: true, soundId: 0 });
    expect(getTimers()[0].repeating).toBe(true);
  });

  it("does not exceed MAX_TIMERS", () => {
    for (let i = 0; i < MAX_TIMERS + 5; i++) {
      createTimer({ label: `T${i}`, durationMs: 1000, repeating: false, soundId: 0 });
    }
    expect(getTimers().length).toBeLessThanOrEqual(MAX_TIMERS);
  });
});

// ─── canAddTimer ────────────────────────────────────────────

describe("canAddTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("returns true when under limit", () => {
    expect(canAddTimer()).toBe(true);
  });

  it("returns false when at MAX_TIMERS", () => {
    for (let i = 0; i < MAX_TIMERS; i++) {
      createTimer({ label: `T${i}`, durationMs: 1000, repeating: false, soundId: 0 });
    }
    expect(canAddTimer()).toBe(false);
  });
});

// ─── pauseTimer / resumeTimer ────────────────────────────────

describe("pauseTimer / resumeTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("pauses a running timer", () => {
    createTimer({ label: "P", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    pauseTimer(id);
    expect(getTimers()[0].state).toBe("paused");
  });

  it("resumes a paused timer", () => {
    createTimer({ label: "R", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    pauseTimer(id);
    resumeTimer(id);
    expect(getTimers()[0].state).toBe("running");
  });

  it("does not pause a non-running timer", () => {
    createTimer({ label: "P", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    pauseTimer(id);
    pauseTimer(id); // second pause — no-op
    expect(getTimers()[0].state).toBe("paused");
  });
});

// ─── stopTimer ──────────────────────────────────────────────

describe("stopTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("removes the timer from the store", () => {
    createTimer({ label: "S", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    stopTimer(id);
    expect(getTimers().find((t) => t.id === id)).toBeUndefined();
  });

  it("leaves other timers untouched", () => {
    createTimer({ label: "A", durationMs: 1000, repeating: false, soundId: 0 });
    createTimer({ label: "B", durationMs: 2000, repeating: false, soundId: 0 });
    const [a, b] = getTimers();
    stopTimer(a.id);
    expect(getTimers()).toHaveLength(1);
    expect(getTimers()[0].id).toBe(b.id);
  });
});

// ─── restartTimer ───────────────────────────────────────────

describe("restartTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("resets remainingMs and state to running", () => {
    createTimer({ label: "RS", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    // Simulate completion by mutating through pause+restart
    pauseTimer(id);
    restartTimer(id);
    const t = getTimers().find((t) => t.id === id)!;
    expect(t.state).toBe("running");
    expect(t.remainingMs).toBe(t.durationMs);
    expect(t.completedCount).toBe(0);
  });
});

// ─── setRepeating ───────────────────────────────────────────

describe("setRepeating", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("toggles the repeating flag", () => {
    createTimer({ label: "Rep", durationMs: 1000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    setRepeating(id, true);
    expect(getTimers()[0].repeating).toBe(true);
    setRepeating(id, false);
    expect(getTimers()[0].repeating).toBe(false);
  });
});

// ─── loadFromStorage ────────────────────────────────────────

describe("loadFromStorage", () => {
  beforeEach(() => {
    clearAllTimers();
    localStorage.clear();
  });
  afterEach(clearAllTimers);

  it("loads valid timers from localStorage", () => {
    const saved = [
      {
        id: "abc-123",
        label: "Saved Timer",
        durationMs: 10000,
        remainingMs: 8000,
        state: "paused",
        repeating: false,
        soundId: 2,
        createdAt: Date.now(),
        completedCount: 0,
      },
    ];
    localStorage.setItem("majel-timers", JSON.stringify(saved));
    loadFromStorage();
    const loaded = getTimers().find((t) => t.id === "abc-123");
    expect(loaded).toBeDefined();
    expect(loaded?.label).toBe("Saved Timer");
  });

  it("ignores corrupt localStorage data", () => {
    localStorage.setItem("majel-timers", "not-json");
    expect(() => loadFromStorage()).not.toThrow();
  });

  it("ignores non-array localStorage data", () => {
    localStorage.setItem("majel-timers", JSON.stringify({ not: "an array" }));
    loadFromStorage();
    // Should not crash and timers from previous test should not appear
    // (we cleared all timers in beforeEach)
    expect(Array.isArray(getTimers())).toBe(true);
  });
});
