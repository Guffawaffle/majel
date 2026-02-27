<script lang="ts">
  /**
   * Plan View — Fleet state, docks, presets & assignments.
   * Container with sub-tab bar; fetches all reference data and effective state.
   * Ported from src/client/views/plan/plan.js (~1,054 LOC).
   */
  import { onMount } from "svelte";
  import {
    fetchEffectiveState,
    fetchFleetPresets,
    fetchCrewPlanItems,
    fetchCrewDocks,
  } from "../lib/api/crews-planning.js";
  import {
    fetchCrewLoadouts,
    fetchBridgeCores,
    fetchBelowDeckPolicies,
  } from "../lib/api/crews-composition.js";
  import { fetchCatalogOfficers } from "../lib/api/catalog.js";
  import type {
    EffectiveDockState,
    FleetPresetWithSlots,
    PlanItem,
    Loadout,
    BridgeCoreWithMembers,
    BelowDeckPolicy,
    Dock,
    CatalogOfficer,
  } from "../lib/types.js";
  import EffectiveStateTab from "../components/plan/EffectiveStateTab.svelte";
  import DocksTab from "../components/plan/DocksTab.svelte";
  import PresetsTab from "../components/plan/PresetsTab.svelte";
  import PlanItemsTab from "../components/plan/PlanItemsTab.svelte";

  // ── Tab definition ──

  type TabId = "state" | "docks" | "presets" | "items";
  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "state", label: "Effective State", icon: "📊" },
    { id: "docks", label: "Docks", icon: "⚓" },
    { id: "presets", label: "Fleet Presets", icon: "💾" },
    { id: "items", label: "Plan Items", icon: "📋" },
  ];

  let activeTab = $state<TabId>("state");
  let loading = $state(false);
  let error = $state("");

  // ── Shared state ──

  let effectiveState = $state<EffectiveDockState | null>(null);
  let fleetPresets = $state<FleetPresetWithSlots[]>([]);
  let planItems = $state<PlanItem[]>([]);
  let loadouts = $state<Loadout[]>([]);
  let bridgeCores = $state<BridgeCoreWithMembers[]>([]);
  let belowDeckPolicies = $state<BelowDeckPolicy[]>([]);
  let docks = $state<Dock[]>([]);
  let officers = $state<CatalogOfficer[]>([]);

  // ── Data fetching ──

  async function refresh(forceNetwork = false) {
    loading = true;
    const net = forceNetwork || undefined;
    try {
      const [es, fp, pi, lo, bc, bdp, dk, off] = await Promise.all([
        fetchEffectiveState({ forceNetwork: net }),
        fetchFleetPresets({ forceNetwork: net }),
        fetchCrewPlanItems(undefined, { forceNetwork: net }),
        fetchCrewLoadouts(undefined, { forceNetwork: net }),
        fetchBridgeCores({ forceNetwork: net }),
        fetchBelowDeckPolicies({ forceNetwork: net }),
        fetchCrewDocks({ forceNetwork: net }),
        fetchCatalogOfficers({ ownership: "owned" }, { forceNetwork: net }),
      ]);
      effectiveState = es;
      fleetPresets = fp;
      planItems = pi;
      loadouts = lo;
      bridgeCores = bc;
      belowDeckPolicies = bdp;
      docks = dk;
      officers = off;
      error = "";
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load plan data.";
      console.error("Plan refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  async function refreshStateScope() {
    try {
      const [es, pi] = await Promise.all([
        fetchEffectiveState({ forceNetwork: true }),
        fetchCrewPlanItems(undefined, { forceNetwork: true }),
      ]);
      effectiveState = es;
      planItems = pi;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to refresh state.";
      console.error("Plan state-scope refresh failed:", err);
    }
  }

  async function refreshDocksScope() {
    try {
      const [dk, es, pi] = await Promise.all([
        fetchCrewDocks({ forceNetwork: true }),
        fetchEffectiveState({ forceNetwork: true }),
        fetchCrewPlanItems(undefined, { forceNetwork: true }),
      ]);
      docks = dk;
      effectiveState = es;
      planItems = pi;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to refresh docks.";
      console.error("Plan docks-scope refresh failed:", err);
    }
  }

  async function refreshPresetsScope() {
    try {
      const [fp, es] = await Promise.all([
        fetchFleetPresets({ forceNetwork: true }),
        fetchEffectiveState({ forceNetwork: true }),
      ]);
      fleetPresets = fp;
      effectiveState = es;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to refresh presets.";
      console.error("Plan presets-scope refresh failed:", err);
    }
  }

  async function refreshPlanItemsScope() {
    try {
      const [pi, es] = await Promise.all([
        fetchCrewPlanItems(undefined, { forceNetwork: true }),
        fetchEffectiveState({ forceNetwork: true }),
      ]);
      planItems = pi;
      effectiveState = es;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to refresh plan items.";
      console.error("Plan items-scope refresh failed:", err);
    }
  }

  onMount(() => { refresh(); });

  function switchTab(id: TabId) {
    activeTab = id;
  }
</script>

<div class="plan">
  {#if error}
    <div class="pl-error-banner" role="alert">
      <span>⚠ {error}</span>
      <button onclick={() => { error = ""; refresh(true); }}>Retry</button>
      <button onclick={() => { error = ""; }}>✕</button>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="pl-tabs" role="tablist">
    {#each TABS as tab}
      <button
        class="pl-tab"
        class:active={activeTab === tab.id}
        role="tab"
        aria-selected={activeTab === tab.id}
        onclick={() => switchTab(tab.id)}
      >
        <span class="pl-tab-icon">{tab.icon}</span>
        {tab.label}
        {#if tab.id === "docks"}
          <span class="pl-tab-count">{docks.length}</span>
        {/if}
      </button>
    {/each}
  </nav>

  {#if loading}
    <p class="pl-loading">Loading…</p>
  {:else}
    <div class="pl-panel">
      {#if activeTab === "state"}
        <EffectiveStateTab
          {effectiveState}
          {fleetPresets}
          {loadouts}
          {officers}
          onRefresh={refreshStateScope}
        />
      {:else if activeTab === "docks"}
        <DocksTab
          {docks}
          onRefresh={refreshDocksScope}
        />
      {:else if activeTab === "presets"}
        <PresetsTab
          {fleetPresets}
          {loadouts}
          onRefresh={refreshPresetsScope}
        />
      {:else if activeTab === "items"}
        <PlanItemsTab
          {planItems}
          {loadouts}
          {officers}
          onRefresh={refreshPlanItemsScope}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .plan {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 0;
    overflow: hidden;
  }

  .pl-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .pl-tab {
    padding: 10px 18px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 0.88rem;
    cursor: pointer;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: color 0.15s, border-color 0.15s;
  }
  .pl-tab:hover { color: var(--text-primary); }
  .pl-tab.active {
    color: var(--accent-gold);
    border-bottom-color: var(--accent-gold);
  }
  .pl-tab-icon { font-size: 1rem; }
  .pl-tab-count {
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 0.72rem;
  }

  .pl-panel {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    animation: fadeIn 0.2s ease;
  }
  .pl-loading {
    text-align: center;
    color: var(--text-muted);
    padding: 40px 0;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 768px) {
    .pl-tab { padding: 8px 12px; font-size: 0.82rem; }
    .pl-panel { padding: 12px; }
  }
</style>
