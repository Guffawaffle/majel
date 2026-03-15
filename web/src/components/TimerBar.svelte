<!--
  TimerBar.svelte — Persistent top bar showing all active timers.
  Two-row layout: preset chips (launcher) + active timer pills.
  Always visible — presets are always accessible.
  Positioned between TitleBar and app-content in App.svelte.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { getTimers, loadFromStorage, canAddTimer, getSortedVisibleTimers, startTimerFromPreset } from "../lib/timer.svelte.js";
  import { getVisiblePresets } from "../lib/timer-presets.js";
  import TimerPill from "./TimerPill.svelte";
  import TimerDetail from "./TimerDetail.svelte";
  import TimerCreate from "./TimerCreate.svelte";

  let selectedId = $state<string | null>(null);
  let showCreate = $state(false);
  let barEl = $state<HTMLElement | null>(null);
  let overlayTop = $state(44);
  let overlayLeft = $state(12);

  const timers = $derived(getTimers());
  const visibleTimers = $derived(getSortedVisibleTimers());
  const presets = $derived(getVisiblePresets());
  const selectedTimer = $derived(timers.find((t) => t.id === selectedId) ?? null);

  onMount(() => {
    loadFromStorage();
  });

  function handlePresetClick(presetId: string) {
    if (!canAddTimer()) return;
    startTimerFromPreset(presetId);
  }

  function selectTimer(id: string) {
    if (selectedId === id) {
      selectedId = null;
    } else {
      selectedId = id;
      showCreate = false;
      requestAnimationFrame(updateOverlayPosition);
    }
  }

  function openCreate() {
    showCreate = true;
    selectedId = null;
    requestAnimationFrame(updateOverlayPosition);
  }

  function closeCreate() {
    showCreate = false;
  }

  function closeDetail() {
    selectedId = null;
  }

  function handleOverlayClick() {
    selectedId = null;
    showCreate = false;
  }

  function updateOverlayPosition() {
    if (!barEl) return;
    const rect = barEl.getBoundingClientRect();
    overlayTop = Math.round(rect.bottom + 2);
    overlayLeft = Math.round(rect.left + 12);
  }

  $effect(() => {
    if (!(showCreate || selectedTimer !== null)) return;
    const update = () => updateOverlayPosition();
    requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  });

  /** Global keyboard shortcuts */
  function handleKeydown(e: KeyboardEvent) {
    // T — open custom timer (when not typing in an input)
    if (
      e.key === "t" &&
      !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)
    ) {
      e.preventDefault();
      openCreate();
    }
    // Escape — close open panels
    if (e.key === "Escape") {
      if (showCreate) { showCreate = false; return; }
      if (selectedId !== null) { selectedId = null; return; }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="timer-bar" role="toolbar" aria-label="Timers" bind:this={barEl}>
  <!-- Row 1: Preset launcher chips -->
  <div class="timer-bar-presets">
    {#each presets as preset (preset.id)}
      <button
        class="preset-chip"
        onclick={() => handlePresetClick(preset.id)}
        disabled={!canAddTimer()}
        title="Start {preset.label} timer"
        aria-label="Start {preset.label} timer"
      >{preset.label}</button>
    {/each}
    <button
      class="preset-chip preset-chip-custom"
      onclick={openCreate}
      title="Custom timer (T)"
      aria-label="Custom timer"
    >&#9881; Custom</button>
  </div>

  <!-- Row 2: Active timer pills (only when timers exist) -->
  {#if visibleTimers.length > 0}
    <div class="timer-bar-pills">
      {#each visibleTimers as timer (timer.id)}
        <TimerPill
          {timer}
          selected={selectedId === timer.id}
          onclick={() => selectTimer(timer.id)}
        />
      {/each}
    </div>
  {/if}

  {#if showCreate || (selectedTimer !== null)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="timer-overlay-backdrop" onclick={handleOverlayClick}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="timer-overlay-panel" style={`top:${overlayTop}px;left:${overlayLeft}px;`} onclick={(e) => e.stopPropagation()}>
        {#if showCreate}
          <TimerCreate onclose={closeCreate} />
        {:else if selectedTimer !== null}
          <TimerDetail timer={selectedTimer} onclose={closeDetail} />
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .timer-bar {
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 6px 12px;
    gap: 4px;
    flex-shrink: 0;
    position: relative;
    z-index: 50;
  }

  .timer-bar-presets {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .preset-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border-light);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
    line-height: 1.3;
  }

  .preset-chip:hover:not(:disabled) {
    border-color: var(--accent-gold);
    color: var(--accent-gold);
    background: var(--bg-hover);
  }

  .preset-chip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .preset-chip-custom {
    border-style: dashed;
  }

  .timer-bar-pills {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }

  /* Dropdown overlay */
  .timer-overlay-backdrop {
    position: fixed;
    inset: 0;
    z-index: 49;
  }

  .timer-overlay-panel {
    position: fixed;
    z-index: 51;
    animation: slide-down 0.15s ease;
  }

  @keyframes slide-down {
    from { transform: translateY(-6px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
