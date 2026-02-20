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
    fetchReservations,
  } from "../lib/api/crews.js";
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

  // ── Shared state ──

  type TabId = "cores" | "loadouts" | "policies" | "reservations";
  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "cores", label: "Cores", icon: "👥" },
    { id: "loadouts", label: "Loadouts", icon: "📋" },
    { id: "policies", label: "Policies", icon: "📏" },
    { id: "reservations", label: "Reservations", icon: "🔒" },
  ];

  let activeTab = $state<TabId>("cores");
  let loading = $state(false);

  let bridgeCores = $state<BridgeCoreWithMembers[]>([]);
  let belowDeckPolicies = $state<BelowDeckPolicy[]>([]);
  let loadouts = $state<Loadout[]>([]);
  let reservations = $state<OfficerReservation[]>([]);
  let officers = $state<CatalogOfficer[]>([]);
  let ships = $state<CatalogShip[]>([]);

  // ── Data fetching ──

  async function refresh() {
    loading = true;
    try {
      const [c, p, l, r, o, s] = await Promise.all([
        fetchBridgeCores(),
        fetchBelowDeckPolicies(),
        fetchCrewLoadouts(),
        fetchReservations(),
        fetchCatalogOfficers({ ownership: "owned" }),
        fetchCatalogShips(),
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

  onMount(() => { refresh(); });

  function switchTab(id: TabId) {
    activeTab = id;
  }
</script>

<div class="workshop">
  <!-- Tab bar -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="ws-tabs" role="tablist">
    {#each TABS as tab}
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
      {#if activeTab === "cores"}
        <CoresTab
          {bridgeCores}
          {loadouts}
          {officers}
          onRefresh={refresh}
        />
      {:else if activeTab === "loadouts"}
        <LoadoutsTab
          {loadouts}
          {bridgeCores}
          {belowDeckPolicies}
          {officers}
          {ships}
          onRefresh={refresh}
        />
      {:else if activeTab === "policies"}
        <PoliciesTab
          {belowDeckPolicies}
          {loadouts}
          {officers}
          onRefresh={refresh}
        />
      {:else if activeTab === "reservations"}
        <ReservationsTab
          {reservations}
          {officers}
          onRefresh={refresh}
        />
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
  }
</style>
