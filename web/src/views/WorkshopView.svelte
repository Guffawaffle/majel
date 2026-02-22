<script lang="ts">
  /**
   * Workshop View — Composition workshop: cores, loadouts, policies & reservations.
   * Container with sub-tab bar; fetches shared reference data once and passes to tabs.
   * Ported from src/client/views/crews/crews.js (~1,512 LOC).
   */
  import { onMount } from "svelte";
  import {
    fetchBridgeCores,
    fetchBelowDeckPolicies,
    fetchCrewLoadouts,
  } from "../lib/api/crews-composition.js";
  import {
    fetchReservations,
  } from "../lib/api/crews-planning.js";
  import { fetchCatalogOfficers, fetchCatalogShips } from "../lib/api/catalog.js";
  import type {
    BridgeCoreWithMembers,
    BelowDeckPolicy,
    Loadout,
    OfficerReservation,
    CatalogOfficer,
    CatalogShip,
  } from "../lib/types.js";
  import CoresTab from "../components/workshop/CoresTab.svelte";
  import LoadoutsTab from "../components/workshop/LoadoutsTab.svelte";
  import PoliciesTab from "../components/workshop/PoliciesTab.svelte";
  import ReservationsTab from "../components/workshop/ReservationsTab.svelte";
  import ImportsTab from "../components/workshop/ImportsTab.svelte";
  import QuickCrewTab from "../components/workshop/QuickCrewTab.svelte";
  import CrewValidatorTab from "../components/workshop/CrewValidatorTab.svelte";
  import { consumeWorkshopLaunchIntent } from "../lib/view-intent.svelte.js";

  // ── Shared state ──

  type ModeId = "basic" | "advanced";
  type TabId = "quick" | "validate" | "cores" | "loadouts" | "policies" | "reservations" | "imports";

  const MODES: { id: ModeId; label: string }[] = [
    { id: "basic", label: "Basic" },
    { id: "advanced", label: "Advanced" },
  ];

  const BASIC_TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "quick", label: "Quick Crew", icon: "🧭" },
    { id: "validate", label: "Crew Check", icon: "🔍" },
  ];

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "quick", label: "Quick Crew", icon: "🧭" },
    { id: "cores", label: "Cores", icon: "👥" },
    { id: "loadouts", label: "Loadouts", icon: "📋" },
    { id: "policies", label: "Policies", icon: "📏" },
    { id: "reservations", label: "Reservations", icon: "🔒" },
    { id: "imports", label: "Imports", icon: "📥" },
  ];

  let mode = $state<ModeId>("basic");
  let activeTab = $state<TabId>("quick");
  let loading = $state(false);

  let bridgeCores = $state<BridgeCoreWithMembers[]>([]);
  let belowDeckPolicies = $state<BelowDeckPolicy[]>([]);
  let loadouts = $state<Loadout[]>([]);
  let reservations = $state<OfficerReservation[]>([]);
  let officers = $state<CatalogOfficer[]>([]);
  let ships = $state<CatalogShip[]>([]);

  // ── Data fetching ──

  async function refresh(forceNetwork = false) {
    loading = true;
    const net = forceNetwork || undefined;
    try {
      const [c, p, l, r, o, s] = await Promise.all([
        fetchBridgeCores({ forceNetwork: net }),
        fetchBelowDeckPolicies({ forceNetwork: net }),
        fetchCrewLoadouts(undefined, { forceNetwork: net }),
        fetchReservations({ forceNetwork: net }),
        fetchCatalogOfficers({ ownership: "owned" }, { forceNetwork: net }),
        fetchCatalogShips(undefined, { forceNetwork: net }),
      ]);
      bridgeCores = c;
      belowDeckPolicies = p;
      loadouts = l;
      reservations = r;
      officers = o;
      ships = s;
    } catch (err) {
      console.error("Workshop refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  async function refreshCoresScope() {
    try {
      const [c, l] = await Promise.all([
        fetchBridgeCores({ forceNetwork: true }),
        fetchCrewLoadouts(undefined, { forceNetwork: true }),
      ]);
      bridgeCores = c;
      loadouts = l;
    } catch (err) {
      console.error("Workshop cores-scope refresh failed:", err);
    }
  }

  async function refreshLoadoutsScope() {
    try {
      const l = await fetchCrewLoadouts(undefined, { forceNetwork: true });
      loadouts = l;
    } catch (err) {
      console.error("Workshop loadouts-scope refresh failed:", err);
    }
  }

  async function refreshPoliciesScope() {
    try {
      const [p, l] = await Promise.all([
        fetchBelowDeckPolicies({ forceNetwork: true }),
        fetchCrewLoadouts(undefined, { forceNetwork: true }),
      ]);
      belowDeckPolicies = p;
      loadouts = l;
    } catch (err) {
      console.error("Workshop policies-scope refresh failed:", err);
    }
  }

  async function refreshReservationsScope() {
    try {
      const r = await fetchReservations({ forceNetwork: true });
      reservations = r;
    } catch (err) {
      console.error("Workshop reservations-scope refresh failed:", err);
    }
  }

  onMount(() => {
    const launchIntent = consumeWorkshopLaunchIntent();
    if (launchIntent?.tab === "imports") {
      mode = "advanced";
      activeTab = "imports";
    }
    refresh();
  });

  function switchTab(id: TabId) {
    activeTab = id;
  }

  function switchMode(nextMode: ModeId) {
    mode = nextMode;
    if (nextMode === "basic") {
      activeTab = "quick";
      return;
    }
    if (activeTab === "quick" || activeTab === "validate") activeTab = "cores";
  }

  const visibleTabs = $derived(mode === "basic" ? BASIC_TABS : TABS.filter((tab) => tab.id !== "quick" && tab.id !== "validate"));
</script>

<div class="workshop">
  <div class="ws-modebar">
    {#each MODES as m}
      <button class="ws-modebtn" class:active={mode === m.id} onclick={() => switchMode(m.id)}>
        {m.label}
      </button>
    {/each}
  </div>

  <!-- Tab bar -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="ws-tabs" role="tablist">
    {#each visibleTabs as tab}
      <button
        class="ws-tab"
        class:active={activeTab === tab.id}
        role="tab"
        aria-selected={activeTab === tab.id}
        onclick={() => switchTab(tab.id)}
      >
        <span class="ws-tab-icon">{tab.icon}</span>
        {tab.label}
      </button>
    {/each}
  </nav>

  <!-- Loading -->
  {#if loading}
    <p class="ws-loading">Loading…</p>
  {:else}
    <!-- Tab panels -->
    <div class="ws-panel">
      {#if activeTab === "quick"}
        <QuickCrewTab
          {officers}
          {ships}
          {reservations}
          onRefresh={refreshCoresScope}
        />
      {:else if activeTab === "validate"}
        <CrewValidatorTab
          {officers}
        />
      {:else if activeTab === "cores"}
        <CoresTab
          {bridgeCores}
          {loadouts}
          {officers}
          onRefresh={refreshCoresScope}
        />
      {:else if activeTab === "loadouts"}
        <LoadoutsTab
          {loadouts}
          {bridgeCores}
          {belowDeckPolicies}
          {officers}
          {ships}
          onRefresh={refreshLoadoutsScope}
        />
      {:else if activeTab === "policies"}
        <PoliciesTab
          {belowDeckPolicies}
          {loadouts}
          {officers}
          onRefresh={refreshPoliciesScope}
        />
      {:else if activeTab === "reservations"}
        <ReservationsTab
          {reservations}
          {officers}
          onRefresh={refreshReservationsScope}
        />
      {:else if activeTab === "imports"}
        <ImportsTab onCommitted={() => refresh(true)} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .workshop {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 0;
    overflow: hidden;
  }

  .ws-modebar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px 8px;
    border-bottom: 1px solid var(--border);
  }
  .ws-modebtn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .ws-modebtn.active {
    color: var(--text-primary);
    border-color: var(--accent-gold-dim);
  }

  /* ── Tab bar ── */
  .ws-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .ws-tab {
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
  .ws-tab:hover { color: var(--text-primary); }
  .ws-tab.active {
    color: var(--accent-gold);
    border-bottom-color: var(--accent-gold);
  }
  .ws-tab-icon { font-size: 1rem; }

  /* ── Panel ── */
  .ws-panel {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    animation: fadeIn 0.2s ease;
  }
  .ws-loading {
    text-align: center;
    color: var(--text-muted);
    padding: 40px 0;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 768px) {
    .ws-tabs { overflow-x: auto; }
    .ws-tab { padding: 8px 12px; font-size: 0.82rem; }
    .ws-panel { padding: 12px; }
    .ws-modebar { padding: 8px 12px 6px; }
  }
</style>
