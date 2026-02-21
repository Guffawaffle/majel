<!--
  TimerPill.svelte — A single timer pill in the TimerBar.
  Shows countdown and label. Clicking opens TimerDetail.
-->
<script lang="ts">
  import type { Timer } from "../lib/types.js";

  interface Props {
    timer: Timer;
    selected: boolean;
    onclick: () => void;
  }

  let { timer, selected, onclick }: Props = $props();

  function formatTime(ms: number): string {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const stateClass = $derived.by(() => {
    if (timer.state === "completed") return "pill-completed";
    if (timer.state === "paused") return "pill-paused";
    return "pill-running";
  });
</script>

<button
  class="timer-pill {stateClass}"
  class:selected
  onclick={onclick}
  title="{timer.label} — {formatTime(timer.remainingMs)}"
  aria-pressed={selected}
>
  <span class="pill-icon">⏱</span>
  <span class="pill-time">{formatTime(timer.remainingMs)}</span>
  <span class="pill-label">{timer.label}</span>
  {#if timer.repeating}
    <span class="pill-repeat" title="Repeating">↺</span>
  {/if}
</button>

<style>
  .timer-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border-light);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
    line-height: 1;
  }

  .timer-pill:hover,
  .timer-pill.selected {
    background: var(--bg-hover);
    border-color: var(--accent-blue);
  }

  .pill-running { border-color: var(--border-light); }
  .pill-running .pill-time { color: var(--accent-green); }
  .pill-paused { border-color: var(--accent-gold-dim); }
  .pill-paused .pill-time { color: var(--accent-gold); }
  .pill-completed { border-color: var(--accent-blue-dim); }
  .pill-completed .pill-time { color: var(--accent-blue); }

  .pill-icon { font-size: 0.75rem; opacity: 0.7; }
  .pill-time { font-variant-numeric: tabular-nums; font-weight: 600; }
  .pill-label { color: var(--text-secondary); max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
  .pill-repeat { color: var(--accent-gold); font-size: 0.75rem; }
</style>
