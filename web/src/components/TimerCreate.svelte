<!--
  TimerCreate.svelte — Form for creating a new timer.
-->
<script lang="ts">
  import { createTimer, canAddTimer, MAX_TIMERS } from "../lib/timer.svelte.js";
  import { SOUND_NAMES, playSound } from "../lib/timer-audio.js";

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  let label = $state("Timer");
  let hours = $state(0);
  let minutes = $state(5);
  let seconds = $state(0);
  let soundId = $state(0);
  let repeating = $state(false);

  const durationMs = $derived((hours * 3600 + minutes * 60 + seconds) * 1000);
  const isValid = $derived(durationMs > 0 && canAddTimer());

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (!isValid) return;
    createTimer({ label, durationMs, repeating, soundId });
    onclose();
  }

  function handlePreviewSound() {
    playSound(soundId);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onclose(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="timer-create" onkeydown={handleKeydown} role="dialog" aria-modal="true" aria-label="New Timer" tabindex="-1">
  <div class="create-header">
    <span class="create-title">New Timer</span>
    <button class="btn-icon" onclick={onclose} aria-label="Close">✕</button>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <form onsubmit={handleSubmit}>
    <div class="form-row">
      <label class="form-label" for="timer-label">Label</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="timer-label"
        class="form-input"
        type="text"
        bind:value={label}
        maxlength={40}
        autofocus
        placeholder="Timer label…"
      />
    </div>

    <div class="form-row">
      <span class="form-label" id="duration-label">Duration</span>
      <div class="duration-inputs" role="group" aria-labelledby="duration-label">
        <label class="dur-field">
          <input class="form-input dur-num" type="number" min="0" max="99" bind:value={hours} />
          <span class="dur-unit">h</span>
        </label>
        <label class="dur-field">
          <input class="form-input dur-num" type="number" min="0" max="59" bind:value={minutes} />
          <span class="dur-unit">m</span>
        </label>
        <label class="dur-field">
          <input class="form-input dur-num" type="number" min="0" max="59" bind:value={seconds} />
          <span class="dur-unit">s</span>
        </label>
      </div>
    </div>

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

    {#if !canAddTimer()}
      <p class="form-warning">Maximum {MAX_TIMERS} timers reached. Stop a timer to add more.</p>
    {/if}

    <div class="form-actions">
      <button type="button" class="btn btn-secondary" onclick={onclose}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={!isValid}>▶ Start</button>
    </div>
  </form>
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
    margin-bottom: 12px;
  }

  .create-title {
    font-weight: 600;
    color: var(--text-primary);
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

  .duration-inputs {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .dur-field {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .dur-num {
    width: 56px;
    text-align: right;
    padding: 6px 6px;
  }

  .dur-unit {
    font-size: 0.78rem;
    color: var(--text-secondary);
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
