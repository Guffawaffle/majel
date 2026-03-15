/**
 * timer-presets.ts — Preset seed data and query helpers.
 *
 * Data-only module: no imports from timer.svelte.ts or timer-audio.ts.
 * Provides the default quick-launch presets and resolution helpers.
 * In v1, all presets are hardcoded defaults. In v2, this module will
 * merge defaults with user-created presets from localStorage.
 */

import type { QuickPreset } from "./types.js";

// ─── Default Presets (frozen seed data) ─────────────────────

const DEFAULT_PRESETS: readonly QuickPreset[] = Object.freeze([
  { id: "default-30s",  kind: "default", label: "30s",  durationMs: 30_000,  visible: true, sortOrder: 0 },
  { id: "default-1m",   kind: "default", label: "1m",   durationMs: 60_000,  visible: true, sortOrder: 1 },
  { id: "default-3m",   kind: "default", label: "3m",   durationMs: 180_000, visible: true, sortOrder: 2 },
  { id: "default-5m",   kind: "default", label: "5m",   durationMs: 300_000, visible: true, sortOrder: 3 },
  { id: "default-10m",  kind: "default", label: "10m",  durationMs: 600_000, visible: true, sortOrder: 4 },
] as const);

// ─── Query Helpers ──────────────────────────────────────────

/**
 * Returns visible presets sorted by sortOrder.
 * Always returns copies — never exposes seed references.
 */
export function getVisiblePresets(): QuickPreset[] {
  return DEFAULT_PRESETS
    .filter((p) => p.visible)
    .map((p) => ({ ...p }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Resolve a preset by ID. Returns a copy or undefined.
 * Conceptually: "resolve from the launcher source of truth."
 * Today reads defaults only; in v2 reads the effective merged set.
 */
export function getPresetById(id: string): QuickPreset | undefined {
  const found = DEFAULT_PRESETS.find((p) => p.id === id);
  return found ? { ...found } : undefined;
}
