<!--
  TimerBar.svelte — Persistent top bar showing all active timers.
  Renders only when at least one timer exists.
  Positioned between TitleBar and app-content in App.svelte.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { getTimers, loadFromStorage, canAddTimer } from "../lib/timer.svelte.js";
  import TimerPill from "./TimerPill.svelte";
  import TimerDetail from "./TimerDetail.svelte";
  import TimerCreate from "./TimerCreate.svelte";

  let selectedId = $state<string | null>(null);
  let showCreate = $state(false);
  let barEl = $state<HTMLElement | null>(null);
  let overlayTop = $state(44);
  let overlayLeft = $state(12);

  const timers = $derived(getTimers());
  const visibleTimers = $derived(timers.filter((t) => t.state !== "stopped"));
  const selectedTimer = $derived(timers.find((t) => t.id === selectedId) ?? null);

  onMount(() => {
    loadFromStorage();
  });

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
    // T — open new timer (when not typing in an input)
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

{#if visibleTimers.length > 0 || showCreate}
  <div class="timer-bar" role="toolbar" aria-label="Active timers" bind:this={barEl}>
    <div class="timer-bar-inner">
      {#each visibleTimers as timer (timer.id)}
        <TimerPill
          {timer}
          selected={selectedId === timer.id}
          onclick={() => selectTimer(timer.id)}
        />
      {/each}

      {#if canAddTimer()}
        <button class="btn-new" onclick={openCreate} title="New timer (T)" aria-label="Add new timer">
          + New
        </button>
      {/if}
    </div>

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
{:else}
  <!-- Always mount the keyboard handler even with no timers -->
  <div class="timer-bar-empty" role="toolbar" aria-label="Timers" bind:this={barEl}>
    <div class="timer-bar-inner">
      <button class="btn-new" onclick={openCreate} title="New timer (T)" aria-label="Add new timer">
        ⏱ Timer
      </button>
    </div>

    {#if showCreate}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="timer-overlay-backdrop" onclick={handleOverlayClick}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="timer-overlay-panel" style={`top:${overlayTop}px;left:${overlayLeft}px;`} onclick={(e) => e.stopPropagation()}>
          <TimerCreate onclose={closeCreate} />
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .timer-bar,
  .timer-bar-empty {
    display: flex;
    align-items: center;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    padding: 6px 12px;
    gap: 8px;
    min-height: 40px;
    flex-shrink: 0;
    position: relative;
    z-index: 50;
  }

  .timer-bar-empty {
    padding: 4px 12px;
    min-height: 32px;
  }

  .timer-bar-inner {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    flex-wrap: wrap;
    min-width: 0;
  }

  .btn-new {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: var(--radius);
    border: 1px dashed var(--border-light);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.82rem;
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
    line-height: 1;
  }

  .btn-new:hover {
    border-color: var(--accent-gold);
    color: var(--accent-gold);
    background: var(--bg-hover);
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
