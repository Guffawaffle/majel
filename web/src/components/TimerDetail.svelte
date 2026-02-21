<!--
  TimerDetail.svelte — Expanded controls for a selected timer.
  Shown below the timer bar when a pill is clicked.
-->
<script lang="ts">
  import type { Timer } from "../lib/types.js";
  import { pauseTimer, resumeTimer, stopTimer, restartTimer, setRepeating } from "../lib/timer.svelte.js";
  import { SOUND_NAMES, playSound } from "../lib/timer-audio.js";

  interface Props {
    timer: Timer;
    onclose: () => void;
  }

  let { timer, onclose }: Props = $props();

  function formatTime(ms: number): string {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(" ");
  }

  function handlePause() { pauseTimer(timer.id); }
  function handleResume() { resumeTimer(timer.id); }
  function handleStop() { stopTimer(timer.id); onclose(); }
  function handleRestart() { restartTimer(timer.id); }
  function handleRepeatingToggle() { setRepeating(timer.id, !timer.repeating); }
  function handlePreviewSound() { playSound(timer.soundId); }

  const progressPct = $derived(
    timer.durationMs > 0 ? (1 - timer.remainingMs / timer.durationMs) * 100 : 0
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="timer-detail" onclick={(e) => e.stopPropagation()}>
  <div class="detail-header">
    <span class="detail-label">{timer.label}</span>
    <span class="detail-sound" title="Sound">
      {SOUND_NAMES[timer.soundId] ?? "–"}
      <button class="btn-icon" onclick={handlePreviewSound} title="Preview sound" aria-label="Preview sound">▶</button>
    </span>
    <button class="btn-icon close-btn" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="detail-countdown">{formatTime(timer.remainingMs)}</div>

  <div class="detail-progress">
    <div class="progress-bar" style="width: {progressPct}%"></div>
  </div>

  <div class="detail-meta">
    <span>Duration: {formatDuration(timer.durationMs)}</span>
    {#if timer.completedCount > 0}
      <span>Completed: {timer.completedCount}×</span>
    {/if}
    {#if timer.state === "completed"}
      <span class="state-completed">✓ Done</span>
    {:else if timer.state === "paused"}
      <span class="state-paused">⏸ Paused</span>
    {/if}
  </div>

  <div class="detail-controls">
    {#if timer.state === "running"}
      <button class="btn btn-secondary" onclick={handlePause}>⏸ Pause</button>
    {:else if timer.state === "paused"}
      <button class="btn btn-primary" onclick={handleResume}>▶ Resume</button>
    {:else if timer.state === "completed"}
      <button class="btn btn-primary" onclick={handleRestart}>↺ Restart</button>
    {/if}
    <button class="btn btn-danger" onclick={handleStop}>✕ Stop</button>

    <label class="repeat-toggle">
      <input type="checkbox" checked={timer.repeating} onchange={handleRepeatingToggle} />
      Repeat
    </label>
  </div>
</div>

<style>
  .timer-detail {
    background: var(--bg-secondary);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 12px 16px;
    min-width: 260px;
    max-width: 340px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .detail-label {
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-sound {
    font-size: 0.78rem;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .close-btn {
    margin-left: auto;
    color: var(--text-secondary);
  }

  .detail-countdown {
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--accent-green);
    text-align: center;
    margin: 6px 0;
    line-height: 1;
  }

  .detail-progress {
    height: 3px;
    background: var(--bg-tertiary);
    border-radius: 2px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--accent-blue);
    border-radius: 2px;
    transition: width 0.25s linear;
  }

  .detail-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }

  .state-completed { color: var(--accent-green); }
  .state-paused { color: var(--accent-gold); }

  .detail-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .btn {
    padding: 5px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-light);
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 500;
    transition: all var(--transition);
    line-height: 1.4;
  }

  .btn-primary {
    background: var(--accent-blue);
    color: var(--bg-primary);
    border-color: var(--accent-blue);
  }
  .btn-primary:hover { opacity: 0.85; }

  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  .btn-danger {
    background: transparent;
    color: var(--accent-red);
    border-color: var(--accent-red);
  }
  .btn-danger:hover { background: var(--accent-red); color: var(--bg-primary); }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0 2px;
    font-size: 0.75rem;
    line-height: 1;
    transition: color var(--transition);
  }
  .btn-icon:hover { color: var(--text-primary); }

  .repeat-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.82rem;
    color: var(--text-secondary);
    cursor: pointer;
    margin-left: auto;
  }
  .repeat-toggle input { cursor: pointer; accent-color: var(--accent-gold); }
</style>
