<!--
  OfflineBanner.svelte — Shows banner when browser is offline.
  ADR-032 Phase 3: Offline indicator with cached data notice.
  Positioned below TimerBar, above app-content.
-->
<script lang="ts">
  import { getOnline } from "../lib/network-status.svelte.js";
  import { getQueue, isReplaying, replayQueue } from "../lib/cache/sync-queue.svelte.js";

  const online = $derived(getOnline());
  const queueSize = $derived(getQueue().length);
  const replaying = $derived(isReplaying());

  async function handleReplay() {
    await replayQueue();
  }
</script>

{#if !online}
  <div class="offline-banner" role="alert">
    <span class="offline-icon">⚡</span>
    <span class="offline-text">Offline — viewing cached data</span>
    {#if queueSize > 0}
      <span class="queue-count">{queueSize} pending</span>
    {/if}
  </div>
{:else if queueSize > 0}
  <div class="sync-banner" role="status">
    <span class="sync-icon">↻</span>
    <span class="sync-text">{queueSize} queued mutation{queueSize > 1 ? "s" : ""}</span>
    <button
      class="sync-btn"
      onclick={handleReplay}
      disabled={replaying}
    >
      {replaying ? "Syncing…" : "Sync now"}
    </button>
  </div>
{/if}

<style>
  .offline-banner,
  .sync-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    font-size: 0.82rem;
    font-weight: 500;
    flex-shrink: 0;
    z-index: 48;
  }

  .offline-banner {
    background: var(--accent-orange-dim, rgba(255, 165, 0, 0.15));
    border-bottom: 1px solid var(--accent-orange, #ff9900);
    color: var(--accent-orange, #ff9900);
  }

  .sync-banner {
    background: var(--accent-blue-dim, rgba(100, 160, 255, 0.12));
    border-bottom: 1px solid var(--accent-blue, #6699cc);
    color: var(--accent-blue, #6699cc);
  }

  .offline-icon,
  .sync-icon {
    font-size: 0.9rem;
  }

  .offline-text,
  .sync-text {
    flex: 1;
  }

  .queue-count {
    font-size: 0.75rem;
    padding: 2px 6px;
    border-radius: var(--radius-sm, 4px);
    background: var(--accent-orange, #ff9900);
    color: var(--bg-primary, #0a0a0a);
    font-weight: 600;
  }

  .sync-btn {
    padding: 3px 10px;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--accent-blue, #6699cc);
    background: transparent;
    color: var(--accent-blue, #6699cc);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition, 0.2s);
  }
  .sync-btn:hover:not(:disabled) {
    background: var(--accent-blue, #6699cc);
    color: var(--bg-primary, #0a0a0a);
  }
  .sync-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
