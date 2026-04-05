# ADR-033: Timer Overlay — Multi-Timer with Audio Alerts

**Status:** Accepted  
**Date:** 2026-02-20  
**Authors:** Guff, Opie (Claude)  
**References:** ADR-031 (Svelte Migration)

---

## Context

STFC players constantly set timers for ship travel durations, resource refresh cycles, and other game events. Currently, users rely on external timer apps (phone, browser extensions) which breaks workflow — context-switching away from Majel to manage timers.

### Use Cases

1. **Ship travel** — "Flying to Borg space, 6m 42s" — one-shot timer, notification when done
2. **Resource refresh** — "Mining permits reset every 2h" — repeating timer
3. **Event cadence** — "Check alliance donations every 30m" — repeating timer
4. **Multi-task** — User commonly runs 3–5 timers simultaneously across different game activities

### Requirements (from Guff)

- Up to **10 concurrent timers**
- **10 distinct sounds** — each timer gets its own audio alert
- **Overlay on any screen** — persistent top bar, doesn't interfere with view content
- **Start / stop / pause** controls
- **Repeating mode** — timer auto-restarts when it completes
- **Simple, quick, easy** — minimal UI, zero friction to create a timer

---

## Decision

Implement a **timer overlay system** as a Svelte component that renders a persistent bar at the top of the app shell, above the view content area. Timers are managed entirely client-side with `setInterval` and the Web Audio API.

### UI Design

```
┌─────────────────────────────────────────────────────────┐
│ [⏱ 5:42 Mining] [⏱ 2:11 Travel] [⏱ +New]              │  ← Timer Bar (collapsed)
├─────────────────────────────────────────────────────────┤
│                                                         │
│                   Current View                          │
│                   (Chat, Fleet, etc.)                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Clicking a running timer pill opens a **timer detail overlay** (small positioned panel, not a full modal):

```
┌───────────────────────────┐
│  Mining Permit Refresh    │
│  ⏱ 02:11:34              │
│  🔊 Bosun Whistle         │
│                           │
│  [⏸ Pause] [⏹ Stop]  [🔁]│
│  ☐ Repeating              │
└───────────────────────────┘
```

The `[+New]` button opens a **create timer** panel:

```
┌───────────────────────────┐
│  New Timer                │
│                           │
│  Label: [Mining Permit  ] │
│                           │
│  Hours: [0] Min: [30]     │
│  Sec:   [0]               │
│                           │
│  Sound: [🔔 Bosun Whistle▾]│
│  ☐ Repeating              │
│                           │
│  [Start Timer]            │
└───────────────────────────┘
```

### Component Structure

```
web/src/lib/components/
  TimerBar.svelte          — top bar with timer pills + [+New] button
  TimerPill.svelte         — individual timer badge (label + countdown)
  TimerDetail.svelte       — expanded view with controls (pause/stop/repeat)
  TimerCreate.svelte       — new timer creation form

web/src/lib/
  timer.svelte.ts          — reactive timer store (state management)
  timer-audio.ts           — Web Audio API sound playback
```

### Data Model

```typescript
interface Timer {
  id: string;              // crypto.randomUUID()
  label: string;           // user-provided label ("Mining Permit")
  durationMs: number;      // total duration in ms
  remainingMs: number;     // current remaining (ticks down)
  state: "running" | "paused" | "stopped" | "completed";
  repeating: boolean;      // auto-restart on completion
  soundId: number;         // 0–9, index into SOUNDS array
  createdAt: number;       // Date.now()
  completedCount: number;  // how many times fired (for repeating)
}

const MAX_TIMERS = 10;
```

### Sound System

10 built-in sounds generated via the **Web Audio API** (OscillatorNode) — no audio file dependencies:

| # | Name | Description | Waveform |
|---|------|-------------|----------|
| 0 | Bridge Bell | Two-tone ascending chime | sine 880→1320 Hz |
| 1 | Bosun Whistle | Classic naval whistle sweep | sine 1000→2000→1000 Hz |
| 2 | Red Alert | Urgent pulsing alarm | square 440 Hz, 4 pulses |
| 3 | Hail | Communicator chirp | triangle 1200→800 Hz |
| 4 | Warp | Rising whoosh | sawtooth 200→2000 Hz |
| 5 | Chime | Simple ding | sine 1047 Hz, decay |
| 6 | Drum | Low double tap | sine 150 Hz, 2 pulses |
| 7 | Beacon | Repeating ping (3×) | sine 2000 Hz, 3 short pulses |
| 8 | Klaxon | Horn blast | square 220→440 Hz |
| 9 | Sonar | Submarine ping | sine 1500 Hz, long decay |

All sounds are ~0.5–1.5s duration, generated procedurally. No audio files to load or bundle.

### Tick Engine

```typescript
// timer.svelte.ts — core logic (sketch)
let timers = $state<Timer[]>([]);
let intervalId: ReturnType<typeof setInterval> | null = null;

function startTick() {
  if (intervalId) return;
  intervalId = setInterval(() => {
    const now = Date.now();
    for (const t of timers) {
      if (t.state !== "running") continue;
      t.remainingMs = Math.max(0, t.remainingMs - 250); // 250ms tick
      if (t.remainingMs <= 0) {
        playSound(t.soundId);
        t.completedCount++;
        if (t.repeating) {
          t.remainingMs = t.durationMs; // restart
        } else {
          t.state = "completed";
        }
      }
    }
    // Stop ticking when no running timers
    if (!timers.some(t => t.state === "running")) stopTick();
  }, 250);
}
```

We use 250ms ticks for smooth countdown display (shows tenths of seconds when < 10s remaining) while keeping CPU usage negligible.

### Persistence

Timers persist to **localStorage** (not IndexedDB — timers are tiny, simple, and synchronous access is fine):

```typescript
// On every state change:
localStorage.setItem("majel-timers", JSON.stringify(timers));

// On app load:
const saved = localStorage.getItem("majel-timers");
if (saved) timers = JSON.parse(saved);
// Recalculate remaining time based on elapsed time since save
```

This means timers survive page refreshes and browser restarts. The tick engine recalculates remaining time on load using the delta between `Date.now()` and the saved state.

### Integration with App Shell

The `TimerBar` mounts in `App.svelte` **above** the view router, so it's always visible regardless of which view is active:

```svelte
<!-- App.svelte -->
<TimerBar />

<main class="view-container">
  {#if getCurrentView() === "chat"}
    <ChatView />
  {:else if ...}
  {/if}
</main>
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `T` | Open new timer panel (when not in text input) |
| `Escape` | Close timer detail/create overlay |

---

## Alternatives Considered

### Audio files (MP3/WAV)
**Cons:** Adds 50–200 KB to bundle, licensing concerns, harder to customize.  
**Decision:** Web Audio API gives us zero-dependency, procedurally-generated sounds that are LCARS-themed.

### Service Worker timer (Background)
**Pros:** Timers tick even when tab is inactive.  
**Cons:** Complex, SW lifecycle management, audio can't play from SW.  
**Decision:** Use `setInterval` + `document.visibilitychange` to recalculate on tab return. The Notification API provides alerts even when the tab is backgrounded (with user permission).

### Notification API for background alerts
**Decision:** Yes, as a Phase 2 enhancement. Request notification permission on first timer creation. When tab is hidden and timer completes, fire a browser notification alongside the audio alert.

---

## Implementation Plan

Single-phase delivery — this is a self-contained feature, ~400 LOC total:

1. `timer.svelte.ts` — state management + tick engine + localStorage persistence (~100 LOC)
2. `timer-audio.ts` — Web Audio API sound definitions + `playSound()` (~80 LOC)
3. `TimerBar.svelte` — top bar with pills + new button (~50 LOC)
4. `TimerPill.svelte` — countdown badge component (~30 LOC)
5. `TimerDetail.svelte` — expanded controls overlay (~60 LOC)
6. `TimerCreate.svelte` — new timer form (~50 LOC)
7. CSS — LCARS-themed timer styling (~30 LOC)
8. Tests — timer store unit tests, sound playback tests (~100 LOC)

**Estimated total: ~500 LOC + ~100 LOC tests.**

---

## References

- [Web Audio API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [Notification API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [Page Visibility API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
