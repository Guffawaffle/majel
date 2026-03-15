/**
 * timer.svelte.ts — Reactive multi-timer store.
 *
 * Follows the Svelte 5 rune pattern: private module-level $state,
 * exported getter functions, exported mutation functions.
 *
 * Features:
 * - Up to 10 concurrent timers
 * - 250 ms tick interval while any timer is running
 * - localStorage persistence (survives page refresh)
 * - visibilitychange: recalculates remaining time from elapsed delta
 * - Repeating mode auto-restarts on completion
 */

import type { Timer, TimerState } from "./types.js";
import { playSound } from "./timer-audio.js";
import { getPresetById } from "./timer-presets.js";

// ─── Constants ──────────────────────────────────────────────

export const MAX_TIMERS = 10;
const STORAGE_KEY = "majel-timers";
const TICK_MS = 250;

// ─── Private State ──────────────────────────────────────────

let timers = $state<Timer[]>([]);
let _intervalId: ReturnType<typeof setInterval> | null = null;
let _lastTickAt: number = Date.now();

// ─── Persistence ────────────────────────────────────────────

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timers));
  } catch {
    // localStorage may be unavailable in certain environments — ignore.
  }
}

export function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Timer[];
    if (!Array.isArray(saved)) return;
    const now = Date.now();
    timers = saved
      .filter((t) => t && typeof t.id === "string")
      .map((t) => ({ ...t }));
    _startTickIfNeeded();
  } catch {
    // Corrupt storage — silently ignore.
  }
}

// ─── Tick Engine ────────────────────────────────────────────

function tick(): void {
  const now = Date.now();
  const elapsed = now - _lastTickAt;
  _lastTickAt = now;

  let anyRunning = false;
  const next: Timer[] = timers.map((t) => {
    if (t.state !== "running") return t;
    anyRunning = true;
    const remaining = Math.max(0, t.remainingMs - elapsed);
    if (remaining === 0) {
      playSound(t.soundId);
      if (t.repeating) {
        return {
          ...t,
          remainingMs: t.durationMs,
          completedCount: t.completedCount + 1,
          state: "running" as TimerState,
        };
      }
      return { ...t, remainingMs: 0, state: "completed" as TimerState, completedCount: t.completedCount + 1 };
    }
    return { ...t, remainingMs: remaining };
  });

  timers = next;
  persist();

  if (!anyRunning) {
    _stopTick();
  }
}

function _startTickIfNeeded(): void {
  const hasRunning = timers.some((t) => t.state === "running");
  if (hasRunning && _intervalId === null) {
    _lastTickAt = Date.now();
    _intervalId = setInterval(tick, TICK_MS);
  }
}

function _stopTick(): void {
  if (_intervalId !== null) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
}

// ─── Visibility Change — Recalculate from elapsed delta ─────

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    const now = Date.now();
    const elapsed = now - _lastTickAt;
    if (elapsed > TICK_MS) {
      // Apply elapsed time to all running timers immediately.
      timers = timers.map((t) => {
        if (t.state !== "running") return t;
        const remaining = Math.max(0, t.remainingMs - elapsed);
        if (remaining === 0) {
          playSound(t.soundId);
          if (t.repeating) {
            const periods = t.durationMs > 0 ? Math.floor(elapsed / t.durationMs) : 0;
            const remainder = t.durationMs > 0 ? t.durationMs - (elapsed % t.durationMs) : 0;
            return {
              ...t,
              remainingMs: remainder,
              completedCount: t.completedCount + periods + 1,
              state: "running" as TimerState,
            };
          }
          return { ...t, remainingMs: 0, state: "completed" as TimerState, completedCount: t.completedCount + 1 };
        }
        return { ...t, remainingMs: remaining };
      });
      _lastTickAt = now;
      persist();
    }
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

// ─── Exported Getters ───────────────────────────────────────

export function getTimers(): Timer[] {
  return timers;
}

export function getTimer(id: string): Timer | undefined {
  return timers.find((t) => t.id === id);
}

export function canAddTimer(): boolean {
  return timers.filter((t) => t.state !== "stopped").length < MAX_TIMERS;
}

// ─── Exported Mutations ─────────────────────────────────────

export interface CreateTimerOptions {
  label: string;
  durationMs: number;
  repeating: boolean;
  soundId: number;
  presetId?: string;
  launchSource?: "preset" | "custom" | "manual";
}

export function createTimer(opts: CreateTimerOptions): void {
  if (!canAddTimer()) return;
  const timer: Timer = {
    id: crypto.randomUUID(),
    label: opts.label.trim() || "Timer",
    durationMs: opts.durationMs,
    remainingMs: opts.durationMs,
    state: "running",
    repeating: opts.repeating,
    soundId: Math.max(0, Math.min(9, opts.soundId)),
    createdAt: Date.now(),
    completedCount: 0,
    presetId: opts.presetId,
    launchSource: opts.launchSource,
  };
  timers = [...timers, timer];
  persist();
  _startTickIfNeeded();
}

export function pauseTimer(id: string): void {
  timers = timers.map((t) =>
    t.id === id && t.state === "running" ? { ...t, state: "paused" as TimerState } : t
  );
  persist();
  if (!timers.some((t) => t.state === "running")) _stopTick();
}

export function resumeTimer(id: string): void {
  timers = timers.map((t) =>
    t.id === id && t.state === "paused" ? { ...t, state: "running" as TimerState } : t
  );
  persist();
  _startTickIfNeeded();
}

export function stopTimer(id: string): void {
  timers = timers.filter((t) => t.id !== id);
  persist();
  if (!timers.some((t) => t.state === "running")) _stopTick();
}

export function restartTimer(id: string): void {
  timers = timers.map((t) =>
    t.id === id
      ? { ...t, remainingMs: t.durationMs, state: "running" as TimerState, completedCount: 0 }
      : t
  );
  persist();
  _startTickIfNeeded();
}

export function setRepeating(id: string, repeating: boolean): void {
  timers = timers.map((t) => (t.id === id ? { ...t, repeating } : t));
  persist();
}

// ─── Launch Helpers ─────────────────────────────────────────

function formatDurationLabel(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

export function startTimerFromPreset(presetId: string): void {
  const preset = getPresetById(presetId);
  if (!preset) return;
  createTimer({
    label: preset.label,
    durationMs: preset.durationMs,
    repeating: false,
    soundId: 0,
    presetId: preset.id,
    launchSource: "preset",
  });
}

export function startCustomTimer(opts: {
  label?: string;
  durationMs: number;
  repeating?: boolean;
  soundId?: number;
}): void {
  createTimer({
    label: opts.label || formatDurationLabel(opts.durationMs),
    durationMs: opts.durationMs,
    repeating: opts.repeating ?? false,
    soundId: opts.soundId ?? 0,
    launchSource: "custom",
  });
}

// ─── Extend ─────────────────────────────────────────────────

export function extendTimer(id: string, ms: number): void {
  timers = timers.map((t) => {
    if (t.id !== id) return t;
    if (t.state === "running" || t.state === "paused") {
      return { ...t, remainingMs: t.remainingMs + ms, durationMs: t.durationMs + ms };
    }
    if (t.state === "completed") {
      return { ...t, remainingMs: ms, durationMs: ms, state: "running" as TimerState };
    }
    return t;
  });
  persist();
  _startTickIfNeeded();
}

// ─── Sorted Getter ──────────────────────────────────────────

export function getSortedVisibleTimers(): Timer[] {
  return timers
    .filter((t) => t.state !== "stopped")
    .sort((a, b) => {
      // completed first
      const ac = a.state === "completed" ? 0 : 1;
      const bc = b.state === "completed" ? 0 : 1;
      if (ac !== bc) return ac - bc;
      // then by remainingMs ascending
      if (a.remainingMs !== b.remainingMs) return a.remainingMs - b.remainingMs;
      // tie-breaker: oldest first
      return a.createdAt - b.createdAt;
    });
}
