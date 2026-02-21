<!--
  App.svelte — Root shell: sidebar + title bar + routed view content.
  Phase 1 (#96) of the Svelte migration.
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TitleBar from "./components/TitleBar.svelte";
  import HelpPanel from "./components/HelpPanel.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import ProposalReview from "./components/ProposalReview.svelte";
  import TimerBar from "./components/TimerBar.svelte";
  import OfflineBanner from "./components/OfflineBanner.svelte";
  import { getCurrentView, views } from "./lib/router.svelte.js";
  import { fetchMe, isLoading, getError, hasRole, getUser } from "./lib/auth.svelte.js";
  import { initCache, teardownCache } from "./lib/cache/index.js";
  import { getOnline } from "./lib/network-status.svelte.js";
  import { getQueue, replayQueue } from "./lib/cache/sync-queue.svelte.js";
  import type { Role } from "./lib/types.js";

  import ChatView from "./views/ChatView.svelte";
  import CatalogView from "./views/CatalogView.svelte";
  import FleetView from "./views/FleetView.svelte";
  import WorkshopView from "./views/WorkshopView.svelte";
  import PlanView from "./views/PlanView.svelte";
  import DiagnosticsView from "./views/DiagnosticsView.svelte";
  import AdmiralView from "./views/AdmiralView.svelte";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Svelte component map
  const viewComponents: Record<string, any> = {
    chat: ChatView,
    catalog: CatalogView,
    fleet: FleetView,
    crews: WorkshopView,
    plan: PlanView,
    diagnostics: DiagnosticsView,
    admiral: AdmiralView,
  };

  let sidebarOpen = $state(false);
  let helpOpen = $state(false);

  function toggleHelp() { helpOpen = !helpOpen; }

  /** Global ? keyboard shortcut (only when not typing in an input). */
  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === "?" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      toggleHelp();
    }
  }

  // Auto-replay queued mutations when coming back online
  function handleOnline() {
    if (getQueue().length > 0) {
      replayQueue();
    }
  }

  onMount(async () => {
    await fetchMe();
    const user = getUser();
    if (user) {
      await initCache(user.id);
    }
    window.addEventListener("online", handleOnline);
  });

  onDestroy(() => {
    teardownCache();
    window.removeEventListener("online", handleOnline);
  });
</script>

{#if isLoading()}
  <div class="app-loading">
    <span class="loading-logo">⟐ ARIADNE</span>
    <span class="loading-text">Authenticating…</span>
  </div>
{:else if getError()}
  <div class="app-loading" aria-live="assertive" role="alert">
    <span class="loading-logo">⟐ ARIADNE</span>
    <span class="loading-error">{getError()}</span>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="app-shell" onkeydown={handleGlobalKeydown}>
    <Sidebar open={sidebarOpen} onclose={() => (sidebarOpen = false)} />

    <div class="app-main">
      <!-- Mobile header (hidden on desktop) -->
      <div class="mobile-header">
        <button class="sidebar-toggle" onclick={() => (sidebarOpen = !sidebarOpen)}>☰</button>
        <span class="title">ARIADNE</span>
      </div>

      <TitleBar helpOpen={helpOpen} ontogglehelp={toggleHelp} />
      <TimerBar />
      <OfflineBanner />

      <div class="app-content">
        {#each Object.entries(viewComponents) as [name, Component]}
          {@const gate = views.find(v => v.name === name)?.gate}
          {#if getCurrentView() === name}
            {#if !gate || hasRole(gate as Role)}
              <Component />
            {:else}
              <div class="gate-denied">
                <p>🔒 You don't have permission to view this page.</p>
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    </div>

    <!-- Mobile overlay -->
    {#if sidebarOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="sidebar-overlay" onclick={() => (sidebarOpen = false)}></div>
    {/if}

    <HelpPanel open={helpOpen} onclose={() => (helpOpen = false)} />
    <ConfirmDialog />
    <ProposalReview />
  </div>
{/if}

<style>
  .app-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 16px;
    background: var(--bg-primary);
  }

  .loading-logo {
    font-size: 24px;
    font-weight: 700;
    color: var(--accent-gold);
    letter-spacing: 4px;
    animation: pulse 1.5s infinite;
  }

  .loading-text {
    font-size: 14px;
    color: var(--text-muted);
  }

  .loading-error {
    font-size: 14px;
    color: var(--accent-red, #e74c3c);
    text-align: center;
    max-width: 400px;
    line-height: 1.5;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .sidebar-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 90;
  }

  .gate-denied {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 16px;
  }
</style>

