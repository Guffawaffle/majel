<!--
  TimerCreate.svelte — Stepper-based custom timer creation.
  Duration display + stepper buttons, optional label, collapsed options.
-->
<script lang="ts">
  import { startCustomTimer, canAddTimer, MAX_TIMERS } from "../lib/timer.svelte.js";
  import { SOUND_NAMES, playSound } from "../lib/timer-audio.js";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const MIN_MS = 10_000;      // 10s floor
  const DEFAULT_MS = 180_000; // 3m starting value

  let durationMs = $state(DEFAULT_MS);
  let label = $state("");
  let soundId = $state(0);
  let repeating = $state(false);
  let showOptions = $state(false);

  const isValid = $derived(durationMs >= MIN_MS && canAddTimer());

  function formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m === 0) return `${s}s`;
    if (s === 0) return `${m}m 00s`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function adjust(deltaMs: number) {
    durationMs = Math.max(MIN_MS, durationMs + deltaMs);
  }

  function handleStart() {
    if (!isValid) return;
    startCustomTimer({
      label: label.trim() || undefined,
      durationMs,
      repeating,
      soundId,
    });
    onclose();
  }

  function handlePreviewSound() {
    playSound(soundId);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onclose(); }
    if (e.key === "Enter") { e.preventDefault(); handleStart(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="timer-create" onkeydown={handleKeydown} role="dialog" aria-modal="true" aria-label="Custom Timer" tabindex="-1">
  <div class="create-header">
    <span class="create-title">Custom Timer</span>
    <button class="btn-icon" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <div class="duration-display" aria-live="polite">{formatDuration(durationMs)}</div>

  <div class="stepper-row" role="group" aria-label="Adjust duration">
    <button class="stepper-btn stepper-minus" onclick={() => adjust(-60_000)} disabled={durationMs <= MIN_MS + 60_000} title="−1m">−1m</button>
    <button class="stepper-btn stepper-minus" onclick={() => adjust(-30_000)} disabled={durationMs <= MIN_MS + 30_000} title="−30s">−30s</button>
    <button class="stepper-btn stepper-plus" onclick={() => adjust(30_000)} title="+30s">+30s</button>
    <button class="stepper-btn stepper-plus" onclick={() => adjust(60_000)} title="+1m">+1m</button>
    <button class="stepper-btn stepper-plus" onclick={() => adjust(300_000)} title="+5m">+5m</button>
  </div>

  <div class="form-row">
    <label class="form-label" for="timer-label">Label <span class="optional">(optional)</span></label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="timer-label"
      class="form-input"
      type="text"
      bind:value={label}
      maxlength={40}
      autofocus
      placeholder="defaults to duration…"
    />
  </div>

  <button class="options-toggle" onclick={() => showOptions = !showOptions} type="button">
    {showOptions ? "▾" : "▸"} More options
  </button>

  {#if showOptions}
    <div class="options-panel">
      <div class="form-row">
        <label class="form-label" for="timer-sound">Sound</label>
        <div class="sound-row">
          <select id="timer-sound" class="form-input form-select" bind:value={soundId}>
            {#each SOUND_NAMES as name, i}
              <option value={i}>{i} — {name}</option>
            {/each}
          </select>
          <button type="button" class="btn-icon preview-btn" onclick={handlePreviewSound} title="Preview sound" aria-label="Preview sound">
            ▶
          </button>
        </div>
      </div>

      <div class="form-row form-row-check">
        <label class="check-label">
          <input type="checkbox" bind:checked={repeating} />
          Repeat when done
        </label>
      </div>
    </div>
  {/if}

  {#if !canAddTimer()}
    <p class="form-warning">Maximum {MAX_TIMERS} timers reached. Stop a timer to add more.</p>
  {/if}

  <div class="form-actions">
    <button type="button" class="btn btn-secondary" onclick={onclose}>Cancel</button>
    <button type="button" class="btn btn-primary" disabled={!isValid} onclick={handleStart}>▶ Start</button>
  </div>
</div>

<style>
  .timer-create {
    background: var(--bg-secondary);
    border: 1px solid var(--border-light);
    border-radius: var(--radius);
    padding: 14px 16px;
    min-width: 280px;
    max-width: 360px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }

  .create-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .create-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .duration-display {
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--accent-gold);
    text-align: center;
    margin: 4px 0 8px;
    line-height: 1;
  }

  .stepper-row {
    display: flex;
    justify-content: center;
    gap: 4px;
    margin-bottom: 12px;
  }

  .stepper-btn {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-light);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    line-height: 1.3;
  }

  .stepper-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--accent-blue);
  }

  .stepper-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .stepper-minus:hover:not(:disabled) {
    border-color: var(--accent-orange);
    color: var(--accent-orange);
  }

  .stepper-plus:hover:not(:disabled) {
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }

  .form-row-check {
    flex-direction: row;
    align-items: center;
  }

  .form-label {
    font-size: 0.78rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .optional {
    font-weight: 400;
    opacity: 0.7;
  }

  .form-input {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    padding: 6px 8px;
    font-size: 0.85rem;
    transition: border-color var(--transition);
  }
  .form-input:focus {
    outline: none;
    border-color: var(--accent-blue);
  }

  .form-select { cursor: pointer; flex: 1; }

  .options-toggle {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    padding: 2px 0;
    margin-bottom: 6px;
    transition: color var(--transition);
  }
  .options-toggle:hover { color: var(--text-primary); }

  .options-panel {
    padding-left: 4px;
    margin-bottom: 4px;
  }

  .sound-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .preview-btn {
    font-size: 0.85rem;
    padding: 4px 8px;
    color: var(--accent-blue);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition);
  }
  .preview-btn:hover { background: var(--bg-hover); }

  .check-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .check-label input { accent-color: var(--accent-gold); cursor: pointer; }

  .form-warning {
    font-size: 0.78rem;
    color: var(--accent-orange);
    margin-bottom: 8px;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .btn {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-light);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    transition: all var(--transition);
    line-height: 1.4;
  }

  .btn-primary {
    background: var(--accent-gold);
    color: var(--bg-primary);
    border-color: var(--accent-gold);
  }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .btn-secondary:hover { background: var(--bg-hover); }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0 2px;
    font-size: 0.8rem;
    line-height: 1;
    transition: color var(--transition);
  }
  .btn-icon:hover { color: var(--text-primary); }
</style>
