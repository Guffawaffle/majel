# ADR-045 — Timer UX Redesign: Preset Launcher + Active Stack

**Status:** Accepted  
**Date:** 2026-03-15  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect), Lex (Architecture Review / Project Lead)  
**Program umbrella:** #215  
**Depends on:** None (self-contained frontend feature)

---

## Context

Majel has a multi-timer system (up to 10 concurrent timers, Web Audio alerts, localStorage persistence). The current implementation treats timer creation as a form — label, three number inputs (h/m/s), sound picker, repeat checkbox — requiring 4–6 interactions before anything starts.

This is wrong for the use case. Majel's timers exist for STFC players who are actively playing. They need:

- **One-tap start** for common durations (30s, 1m, 3m, 5m, 10m)
- **Low cognitive load** — glance at a pill, tap to extend, move on
- **Inline actions** — extend/dismiss/restart without opening panels
- **Multiple simultaneous timers** with clear sort order

The current UI optimizes for configuration completeness on a feature that should optimize for speed-to-running:

- Duration input is precision-first (three h/m/s spinners), but most STFC timing is coarse
- The detail panel devotes space to inspection (progress bar, metadata, sound name) but has no extend action
- There are no presets, no memory of common durations
- Every timer starts from scratch with a 5-field form
- The completed state is a dead end: Restart or Stop, nothing else
- The pill bar is read-only until you click through to a detail overlay

### What This ADR Does NOT Cover

- **Preset management UI** — editing, reordering, hiding, or restoring presets. Deferred.
- **Named presets** — "Mining Check 3m", "Red Alert 5m". Deferred.
- **Auto-dismiss of completed timers** — may be added in v2 after testing.
- **Tap-to-pause gesture** — rejected as too easy to trigger accidentally.
- **Token streaming or chat integration** — unrelated.

## Decisions

### D1: Launcher Presets and Running Timers Are Distinct Models

A `QuickPreset` is a launcher slot — it defines what appears in the quick-start row. A `Timer` is a runtime countdown. They are separate types with separate storage.

**`QuickPreset`:**
```typescript
interface QuickPreset {
  id: string;              // stable, e.g. "default-30s"
  kind: "default" | "user";
  label: string;           // "30s", "1m", "3m", etc.
  durationMs: number;
  visible: boolean;
  sortOrder: number;
}
```

**`Timer` additions:**
```typescript
interface Timer {
  // ... existing fields unchanged ...
  presetId?: string;                              // which preset launched this
  launchSource?: "preset" | "custom" | "manual";  // how it was created
}
```

`presetId` and `launchSource` are optional. Existing callers are not forced into providing them. Launch helpers stamp provenance; `createTimer()` remains the lower-level primitive.

### D2: Custom Is an Action, Not a Preset

The "⚙ Custom" button is a hardcoded UI action rendered after the preset chips. It is never part of the preset data model. Presets are duration-based launcher slots. Custom is the escape hatch to the stepper form.

### D3: The Launcher Renders from Preset Data, Not Hardcoded UI Constants

`TimerBar` renders chips by calling `getVisiblePresets()`, not by iterating a hardcoded array of durations. In v1, `getVisiblePresets()` returns the 5 frozen defaults. In v2, it will merge defaults with user presets from localStorage.

Default presets for v1:

| ID | Label | Duration |
|---|---|---|
| `default-30s` | 30s | 30,000 ms |
| `default-1m` | 1m | 60,000 ms |
| `default-3m` | 3m | 180,000 ms |
| `default-5m` | 5m | 300,000 ms |
| `default-10m` | 10m | 600,000 ms |

### D4: Inline Timer Actions Are Primary; Detail Panel Is Secondary

Each timer pill shows inline action buttons:

**Running / Paused:**
- `+30s` — extends remaining time by 30 seconds
- `+1m` — extends remaining time by 1 minute
- `Done` — stops and removes the timer

**Completed:**
- `Again` — restarts with original duration
- `+30s` — sets remaining to 30s, state back to running
- `Dismiss` — stops and removes the timer

Clicking the pill body (not an action button) opens the detail panel for secondary controls (pause/resume, sound, repeat). Action button clicks use `stopPropagation()`.

### D5: Extension Semantics — `durationMs` Tracks Current Effective Duration

When `extendTimer()` is called:

- **Running / Paused:** `remainingMs += ms` AND `durationMs += ms`
- **Completed:** `remainingMs = ms`, `durationMs = ms`, state → running

`durationMs` is the **current effective duration**, not the original configured duration. This keeps the progress bar and duration metadata honest. If a 3m timer is extended by +1m at 1:30 remaining, the progress bar recalculates against a 4m total, not a 3m total.

`restartTimer()` continues to use the current `durationMs` — which may have been extended. This is intentional: if you ran a 3m timer, extended it to 4m, and hit "Again", you get a 4m timer. The "natural" duration for this timer is the one you actually used.

### D6: Completed Timers Persist Until Acknowledged

No auto-dismiss in v1. Completed pills stay in the bar until the player taps `Again` or `Dismiss`. If clutter becomes a problem, auto-dismiss or collapse behavior can be added in v2 after play-testing.

### D7: Sort Order for Active Timer Pills

Completed timers sort first (need attention), then running/paused by remaining time ascending (soonest alert at the left). Tie-breaker: `createdAt` ascending (oldest first — positional stability).

```
completed first → remainingMs ascending → createdAt ascending
```

### D8: Multiple Simultaneous Timers Stay

Multi-timer (up to 10) remains. The inline action model makes multi-timer cheaper than the current approach because extending/dismissing doesn't require opening a detail panel.

### D9: Stepper-First Custom Timer Creation

The custom form replaces three h/m/s number inputs with:

- A duration display (e.g., "3m 00s")
- Stepper buttons: `-1m`, `-30s`, `+30s`, `+1m`, `+5m`
- Starting value: 3m (180,000 ms), floor: 10s
- Optional label field (defaults to formatted duration)
- Sound and repeat collapsed under "More options"

### D10: Preset Model Future Semantics

These rules are established now but not implemented until v2:

- Default presets are never permanently destroyed
- "Removing" a default means setting `visible: false` in a localStorage override layer
- "Restore defaults" re-shows hidden defaults without deleting user-created presets
- `kind: "default" | "user"` distinguishes the two for restore logic

`getPresetById()` is conceptually "resolve from the launcher source of truth." Today it reads defaults. Later it reads the effective merged set.

## Module Layering

| File | Responsibility | Imports from |
|---|---|---|
| `timer-presets.ts` | Preset seed data, `getVisiblePresets()`, `getPresetById()`. Data-only — no runtime behavior. | `types.js` only |
| `timer.svelte.ts` | Timer state, tick engine, mutations, launch helpers (`startTimerFromPreset`, `startCustomTimer`, `extendTimer`), sorted getters | `types.js`, `timer-presets.js`, `timer-audio.js` |
| `TimerBar.svelte` | Renders preset chips + active pills, invokes launch helpers | `timer-presets.js`, `timer.svelte.js` |
| `TimerCreate.svelte` | Stepper input, calls `startCustomTimer()` | `timer.svelte.js` |
| `TimerPill.svelte` | Inline actions (`extendTimer`, `stopTimer`, `restartTimer`) | `timer.svelte.js` |
| `TimerDetail.svelte` | Secondary controls (pause/resume, extend, repeat, sound) | `timer.svelte.js` |

Dependency direction: `timer-presets.ts` never imports from `timer.svelte.ts`. The store imports from presets only for `getPresetById()` resolution.

## Phased Implementation

### Phase 1 — Timer Domain/Model Groundwork (#216)

- `QuickPreset` type in `misc-domain.ts`
- `timer-presets.ts` with frozen defaults, `getVisiblePresets()`, `getPresetById()`
- `Timer` type gains `presetId?`, `launchSource?`
- `createTimer()` accepts optional provenance fields
- `startTimerFromPreset(presetId)` and `startCustomTimer(opts)` launch helpers
- `extendTimer(id, ms)` — updates both `remainingMs` and `durationMs`
- `getSortedVisibleTimers()` — completed first, remainingMs asc, createdAt asc
- Unit tests for all new functions

### Phase 2 — Active Timer Interaction Redesign (#217)

- Inline pill actions: `+30s`, `+1m`, `Done` / `Again`, `+30s`, `Dismiss`
- Sorted active pill stack in `TimerBar`
- Extend buttons in `TimerDetail`

### Phase 3 — Launcher + Custom Timer UX (#218)

- Preset chip row in `TimerBar` (from `getVisiblePresets()`)
- Custom action button (⚙)
- Stepper-based `TimerCreate` redesign
- Remove old empty-bar branch

## Consequences

- Timer creation drops from 4–6 interactions to 1 tap for common durations
- Every running timer has inline extend/dismiss — no detail panel needed for primary actions
- The preset data model is v2-ready: stable IDs, kind flags, visible/sortOrder fields
- No preset management UI debt — v1 is hardcoded defaults rendered from data
- `durationMs` honestly tracks effective duration after extension
- Progress bar and duration metadata remain truthful after extend operations
- Launch provenance enables future "Pin as preset" without refactoring Timer
- The detail panel becomes a secondary control surface, not the primary one

## Related

- ADR-043 — Chat Run Control & Live Status UX (same frontend, shipped components pattern)
