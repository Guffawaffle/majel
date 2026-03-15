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
  startTimerFromPreset,
  startCustomTimer,
  extendTimer,
  getSortedVisibleTimers,
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

// ─── startTimerFromPreset ───────────────────────────────────

describe("startTimerFromPreset", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("creates a timer from a valid preset ID", () => {
    startTimerFromPreset("default-3m");
    const timers = getTimers();
    expect(timers).toHaveLength(1);
    expect(timers[0].label).toBe("3m");
    expect(timers[0].durationMs).toBe(180_000);
    expect(timers[0].remainingMs).toBe(180_000);
    expect(timers[0].presetId).toBe("default-3m");
    expect(timers[0].launchSource).toBe("preset");
  });

  it("is a no-op for a nonexistent preset ID", () => {
    startTimerFromPreset("nonexistent");
    expect(getTimers()).toHaveLength(0);
  });

  it("sets repeating to false and soundId to 0", () => {
    startTimerFromPreset("default-30s");
    const t = getTimers()[0];
    expect(t.repeating).toBe(false);
    expect(t.soundId).toBe(0);
  });
});

// ─── startCustomTimer ───────────────────────────────────────

describe("startCustomTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("creates a timer with auto-generated label", () => {
    startCustomTimer({ durationMs: 120_000 });
    const t = getTimers()[0];
    expect(t.label).toBe("2m");
    expect(t.durationMs).toBe(120_000);
    expect(t.launchSource).toBe("custom");
    expect(t.presetId).toBeUndefined();
  });

  it("uses provided label when given", () => {
    startCustomTimer({ durationMs: 90_000, label: "My Timer" });
    expect(getTimers()[0].label).toBe("My Timer");
  });

  it("auto-generates label for sub-minute durations", () => {
    startCustomTimer({ durationMs: 45_000 });
    expect(getTimers()[0].label).toBe("45s");
  });

  it("auto-generates label for mixed minutes and seconds", () => {
    startCustomTimer({ durationMs: 150_000 });
    expect(getTimers()[0].label).toBe("2m 30s");
  });

  it("uses provided soundId and repeating", () => {
    startCustomTimer({ durationMs: 60_000, soundId: 3, repeating: true });
    const t = getTimers()[0];
    expect(t.soundId).toBe(3);
    expect(t.repeating).toBe(true);
  });

  it("defaults soundId to 0 and repeating to false", () => {
    startCustomTimer({ durationMs: 60_000 });
    const t = getTimers()[0];
    expect(t.soundId).toBe(0);
    expect(t.repeating).toBe(false);
  });
});

// ─── extendTimer ────────────────────────────────────────────

describe("extendTimer", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("extends a running timer — updates both remainingMs and durationMs", () => {
    createTimer({ label: "E", durationMs: 60_000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    extendTimer(id, 30_000);
    const t = getTimers()[0];
    expect(t.remainingMs).toBe(90_000);
    expect(t.durationMs).toBe(90_000);
    expect(t.state).toBe("running");
  });

  it("extends a paused timer — updates both remainingMs and durationMs", () => {
    createTimer({ label: "E", durationMs: 60_000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    pauseTimer(id);
    extendTimer(id, 15_000);
    const t = getTimers()[0];
    expect(t.remainingMs).toBe(75_000);
    expect(t.durationMs).toBe(75_000);
    expect(t.state).toBe("paused");
  });

  it("extends a completed timer — sets remainingMs and durationMs to ms, state to running", () => {
    // Create a timer and manually force it to completed via localStorage
    const saved = [{
      id: "completed-test",
      label: "Done",
      durationMs: 60_000,
      remainingMs: 0,
      state: "completed",
      repeating: false,
      soundId: 0,
      createdAt: Date.now(),
      completedCount: 1,
    }];
    localStorage.setItem("majel-timers", JSON.stringify(saved));
    loadFromStorage();

    extendTimer("completed-test", 30_000);
    const t = getTimers().find((t) => t.id === "completed-test")!;
    expect(t.remainingMs).toBe(30_000);
    expect(t.durationMs).toBe(30_000);
    expect(t.state).toBe("running");
  });

  it("is a no-op for a nonexistent timer", () => {
    createTimer({ label: "X", durationMs: 60_000, repeating: false, soundId: 0 });
    const before = { ...getTimers()[0] };
    extendTimer("nonexistent", 30_000);
    expect(getTimers()[0].remainingMs).toBe(before.remainingMs);
  });
});

// ─── getSortedVisibleTimers ─────────────────────────────────

describe("getSortedVisibleTimers", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("returns empty array when no timers exist", () => {
    expect(getSortedVisibleTimers()).toEqual([]);
  });

  it("excludes stopped timers", () => {
    createTimer({ label: "A", durationMs: 5000, repeating: false, soundId: 0 });
    const id = getTimers()[0].id;
    stopTimer(id);
    expect(getSortedVisibleTimers()).toHaveLength(0);
  });

  it("sorts completed timers before running timers", () => {
    // Load two timers: one running, one completed
    const saved = [
      {
        id: "running-1",
        label: "Running",
        durationMs: 60_000,
        remainingMs: 30_000,
        state: "running",
        repeating: false,
        soundId: 0,
        createdAt: 1000,
        completedCount: 0,
      },
      {
        id: "completed-1",
        label: "Done",
        durationMs: 60_000,
        remainingMs: 0,
        state: "completed",
        repeating: false,
        soundId: 0,
        createdAt: 2000,
        completedCount: 1,
      },
    ];
    localStorage.setItem("majel-timers", JSON.stringify(saved));
    loadFromStorage();

    const sorted = getSortedVisibleTimers();
    expect(sorted[0].id).toBe("completed-1");
    expect(sorted[1].id).toBe("running-1");
  });

  it("sorts running timers by remainingMs ascending", () => {
    const saved = [
      {
        id: "far",
        label: "Far",
        durationMs: 60_000,
        remainingMs: 50_000,
        state: "running",
        repeating: false,
        soundId: 0,
        createdAt: 1000,
        completedCount: 0,
      },
      {
        id: "near",
        label: "Near",
        durationMs: 60_000,
        remainingMs: 10_000,
        state: "running",
        repeating: false,
        soundId: 0,
        createdAt: 2000,
        completedCount: 0,
      },
    ];
    localStorage.setItem("majel-timers", JSON.stringify(saved));
    loadFromStorage();

    const sorted = getSortedVisibleTimers();
    expect(sorted[0].id).toBe("near");
    expect(sorted[1].id).toBe("far");
  });

  it("breaks ties by createdAt ascending (oldest first)", () => {
    const saved = [
      {
        id: "newer",
        label: "Newer",
        durationMs: 60_000,
        remainingMs: 30_000,
        state: "running",
        repeating: false,
        soundId: 0,
        createdAt: 5000,
        completedCount: 0,
      },
      {
        id: "older",
        label: "Older",
        durationMs: 60_000,
        remainingMs: 30_000,
        state: "running",
        repeating: false,
        soundId: 0,
        createdAt: 1000,
        completedCount: 0,
      },
    ];
    localStorage.setItem("majel-timers", JSON.stringify(saved));
    loadFromStorage();

    const sorted = getSortedVisibleTimers();
    expect(sorted[0].id).toBe("older");
    expect(sorted[1].id).toBe("newer");
  });
});

// ─── createTimer provenance ─────────────────────────────────

describe("createTimer provenance", () => {
  beforeEach(clearAllTimers);
  afterEach(clearAllTimers);

  it("persists presetId and launchSource when provided", () => {
    createTimer({
      label: "Preset",
      durationMs: 30_000,
      repeating: false,
      soundId: 0,
      presetId: "default-30s",
      launchSource: "preset",
    });
    const t = getTimers()[0];
    expect(t.presetId).toBe("default-30s");
    expect(t.launchSource).toBe("preset");
  });

  it("leaves provenance undefined when not provided", () => {
    createTimer({ label: "Basic", durationMs: 5000, repeating: false, soundId: 0 });
    const t = getTimers()[0];
    expect(t.presetId).toBeUndefined();
    expect(t.launchSource).toBeUndefined();
  });
});
