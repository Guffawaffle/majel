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
  import ImageLightbox from "./components/ImageLightbox.svelte";
  import TimerBar from "./components/TimerBar.svelte";
  import OfflineBanner from "./components/OfflineBanner.svelte";
  import { getCurrentView, views } from "./lib/router.svelte.js";
  import { fetchMe, isLoading, getError, hasRole, getUser } from "./lib/auth.svelte.js";
  import { initCache, teardownCache } from "./lib/cache/index.js";
  import { getOnline } from "./lib/network-status.svelte.js";
  import { getQueue, replayQueue } from "./lib/cache/sync-queue.svelte.js";
  import { loadUserSetting, saveUserSetting } from "./lib/api/user-settings.js";
  import LoadingScreen from "./components/LoadingScreen.svelte";
  import type { BootStep } from "./components/LoadingScreen.svelte";
  import type { Role } from "./lib/types.js";

  // Reactive boot steps — drives the LoadingScreen component.
  let bootSteps: BootStep[] = $state([
    { label: "Loading core systems",  status: "active"  },
    { label: "Authenticating",        status: "pending" },
    { label: "Loading preferences",   status: "pending" },
    { label: "Initializing cache",    status: "pending" },
    { label: "Ready",                 status: "pending" },
  ]);

  function advanceBoot(index: number, status: BootStep["status"]) {
    bootSteps[index] = { ...bootSteps[index], status };
  }

  import ChatView from "./views/ChatView.svelte";
  import CatalogView from "./views/CatalogView.svelte";
  import FleetView from "./views/FleetView.svelte";
  import WorkshopView from "./views/WorkshopView.svelte";
  import PlanView from "./views/PlanView.svelte";
  import StartSyncView from "./views/StartSyncView.svelte";
  import DiagnosticsView from "./views/DiagnosticsView.svelte";
  import AdmiralView from "./views/AdmiralView.svelte";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous Svelte component map
  const viewComponents: Record<string, any> = {
    chat: ChatView,
    startsync: StartSyncView,
    catalog: CatalogView,
    fleet: FleetView,
    crews: WorkshopView,
    plan: PlanView,
    diagnostics: DiagnosticsView,
    admiral: AdmiralView,
  };

  let sidebarOpen = $state(false);
  let helpOpen = $state(false);
  let helpPinned = $state(false);

  function toggleHelp() { helpOpen = !helpOpen; }

  function setHelpPinned(next: boolean) {
    helpPinned = next;
    if (next) helpOpen = true;
    saveUserSetting("display.helpPinned", next ? "true" : "false").catch(() => {
      // Non-fatal in offline/error modes.
    });
  }

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
    // Step 1 complete: Svelte has mounted
    advanceBoot(0, "done");

    // Step 2: Authenticate
    advanceBoot(1, "active");
    await fetchMe();
    if (getError()) {
      advanceBoot(1, "error");
      return;
    }
    advanceBoot(1, "done");

    // Step 3: Load preferences
    advanceBoot(2, "active");
    const pinnedSetting = await loadUserSetting("display.helpPinned", "false");
    helpPinned = pinnedSetting === "true" || pinnedSetting === "1";
    advanceBoot(2, "done");

    // Step 4: Initialize data cache
    advanceBoot(3, "active");
    const user = getUser();
    if (user) {
      await initCache(user.id);
    }
    advanceBoot(3, "done");

    // Step 5: Ready
    advanceBoot(4, "active");
    advanceBoot(4, "done");

    window.addEventListener("online", handleOnline);
  });

  onDestroy(() => {
    teardownCache();
    window.removeEventListener("online", handleOnline);
  });
</script>

{#if isLoading()}
  <LoadingScreen steps={bootSteps} error={getError()} />
{:else if getError()}
  <LoadingScreen steps={bootSteps} error={getError()} />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="app-shell" onkeydown={handleGlobalKeydown}>
    <Sidebar open={sidebarOpen} onclose={() => (sidebarOpen = false)} />

    <div class="app-main">
      <!-- Mobile header (hidden on desktop) -->
      <div class="mobile-header">
        <button class="sidebar-toggle" aria-label="Toggle navigation menu" onclick={() => (sidebarOpen = !sidebarOpen)}>☰</button>
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

    <HelpPanel
      open={helpOpen}
      pinned={helpPinned}
      onclose={() => (helpOpen = false)}
      ontogglepin={() => setHelpPinned(!helpPinned)}
    />
    <ConfirmDialog />
    <ProposalReview />
    <ImageLightbox />
  </div>
{/if}

<style>
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

