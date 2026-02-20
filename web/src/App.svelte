<!--
  App.svelte — Root shell: sidebar + title bar + routed view content.
  Phase 1 (#96) of the Svelte migration.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TitleBar from "./components/TitleBar.svelte";
  import { getCurrentView } from "./lib/router.svelte.js";
  import { fetchMe, isLoading, getError } from "./lib/auth.svelte.js";

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

  onMount(() => {
    fetchMe();
  });
</script>

{#if isLoading()}
  <div class="app-loading">
    <span class="loading-logo">⟐ ARIADNE</span>
    <span class="loading-text">Authenticating…</span>
  </div>
{:else if getError()}
  <div class="app-loading">
    <span class="loading-logo">⟐ ARIADNE</span>
    <span class="loading-error">{getError()}</span>
  </div>
{:else}
  <div class="app-shell">
    <Sidebar open={sidebarOpen} onclose={() => (sidebarOpen = false)} />

    <div class="app-main">
      <!-- Mobile header (hidden on desktop) -->
      <div class="mobile-header">
        <button class="sidebar-toggle" onclick={() => (sidebarOpen = !sidebarOpen)}>☰</button>
        <span class="title">ARIADNE</span>
      </div>

      <TitleBar />

      <div class="app-content">
        {#each Object.entries(viewComponents) as [name, Component]}
          {#if getCurrentView() === name}
            <Component />
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
</style>

