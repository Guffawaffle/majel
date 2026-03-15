<!--
  TimerPill.svelte — A single timer pill in the TimerBar.
  Shows countdown/label and inline action buttons.
  Clicking the pill body opens TimerDetail; action buttons stopPropagation.
-->
<script lang="ts">
  import type { Timer } from "../lib/types.js";
  import { extendTimer, stopTimer, restartTimer } from "../lib/timer.svelte.js";

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

  function handleExtend30s(e: MouseEvent) {
    e.stopPropagation();
    extendTimer(timer.id, 30_000);
  }

  function handleExtend1m(e: MouseEvent) {
    e.stopPropagation();
    extendTimer(timer.id, 60_000);
  }

  function handleDone(e: MouseEvent) {
    e.stopPropagation();
    stopTimer(timer.id);
  }

  function handleAgain(e: MouseEvent) {
    e.stopPropagation();
    restartTimer(timer.id);
  }
</script>

<div
  class="timer-pill {stateClass}"
  class:selected
  role="button"
  tabindex="0"
  onclick={onclick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } }}
  title="{timer.label} — {formatTime(timer.remainingMs)}"
  aria-pressed={selected}
>
  <span class="pill-body">
    <span class="pill-icon">⏱</span>
    <span class="pill-time">{formatTime(timer.remainingMs)}</span>
    <span class="pill-label">{timer.label}</span>
    {#if timer.repeating}
      <span class="pill-repeat" title="Repeating">↺</span>
    {/if}
  </span>

  <span class="pill-actions">
    {#if timer.state === "completed"}
      <button class="pill-btn pill-btn-again" onclick={handleAgain} title="Restart timer">Again</button>
      <button class="pill-btn" onclick={handleExtend30s} title="Add 30 seconds">+30s</button>
      <button class="pill-btn pill-btn-dismiss" onclick={handleDone} title="Dismiss timer">Dismiss</button>
    {:else}
      <button class="pill-btn" onclick={handleExtend30s} title="Add 30 seconds">+30s</button>
      <button class="pill-btn" onclick={handleExtend1m} title="Add 1 minute">+1m</button>
      <button class="pill-btn pill-btn-done" onclick={handleDone} title="Stop and remove timer">Done</button>
    {/if}
  </span>
</div>

<style>
  .timer-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px 4px 10px;
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

  .pill-body {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .pill-icon { font-size: 0.75rem; opacity: 0.7; }
  .pill-time { font-variant-numeric: tabular-nums; font-weight: 600; }
  .pill-label { color: var(--text-secondary); max-width: 80px; overflow: hidden; text-overflow: ellipsis; }
  .pill-repeat { color: var(--accent-gold); font-size: 0.75rem; }

  .pill-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: 4px;
  }

  .pill-btn {
    padding: 2px 5px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-light);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    line-height: 1;
  }

  .pill-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-blue);
    background: var(--bg-hover);
  }

  .pill-btn-done:hover,
  .pill-btn-dismiss:hover {
    border-color: var(--accent-red);
    color: var(--accent-red);
  }

  .pill-btn-again:hover {
    border-color: var(--accent-green);
    color: var(--accent-green);
  }
</style>
