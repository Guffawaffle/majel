<script lang="ts">
  /**
   * Catalog View — browse all officers/ships with filtering, search, and overlay toggles.
   * Ported from src/client/views/catalog/catalog.js (~736 LOC).
   */
  import { onMount } from "svelte";
  import Badge from "../components/Badge.svelte";
  import {
    fetchCatalogOfficers,
    fetchCatalogShips,
    fetchCatalogCounts,
    setOfficerOverlay,
    setShipOverlay,
    bulkSetOfficerOverlay,
    bulkSetShipOverlay,
  } from "../lib/api/catalog.js";
  import type { OfficerFilters, ShipFilters } from "../lib/api/catalog.js";
  import type { CatalogOfficer, CatalogShip, CatalogCounts, OwnershipState } from "../lib/types.js";
  import { hullTypeLabel, officerClassShort, formatDuration } from "../lib/game-enums.js";

  // ── State ──

  let officers = $state<CatalogOfficer[]>([]);
  let ships = $state<CatalogShip[]>([]);
  let counts = $state<CatalogCounts | null>(null);
  let activeTab = $state<"officers" | "ships">("officers");
  let searchQuery = $state("");
  let letterFilter = $state("");
  let loading = $state(false);

  // Filters
  let filterOwnership = $state("");
  let filterTarget = $state("");
  let filterOfficerClass = $state("");
  let filterHullType = $state("");

  // Bulk undo
  interface UndoEntry {
    type: "officers" | "ships";
    refIds: string[];
    previousStates: Map<string, { ownershipState: OwnershipState; target: boolean }>;
    count: number;
  }
  let undoStack = $state<UndoEntry[]>([]);

  // Debounce
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchInputEl: HTMLInputElement | undefined;

  // ── Derived ──

  const items = $derived(activeTab === "officers" ? officers : ships) as (CatalogOfficer | CatalogShip)[];

  const filteredItems = $derived.by(() => {
    if (!letterFilter) return items;
    return items.filter((it) => it.name.charAt(0).toUpperCase() === letterFilter);
  });

  const letters = $derived.by(() => {
    const set = new Set<string>();
    for (const it of items) {
      const ch = it.name.charAt(0).toUpperCase();
      if (ch >= "A" && ch <= "Z") set.add(ch);
    }
    return set;
  });

  const tabOfficerCount = $derived(counts?.reference.officers ?? officers.length);
  const tabShipCount = $derived(counts?.reference.ships ?? ships.length);
  const ownedOfficerCount = $derived(counts?.overlay.officers.owned ?? 0);
  const ownedShipCount = $derived(counts?.overlay.ships.owned ?? 0);
  const resultCount = $derived(filteredItems.length);
  const totalCount = $derived(items.length);

  // ── Actions ──

  async function refresh() {
    loading = true;
    try {
      const oFilters: OfficerFilters = {};
      const sFilters: ShipFilters = {};
      if (searchQuery) { oFilters.q = searchQuery; sFilters.q = searchQuery; }
      if (filterOwnership) { oFilters.ownership = filterOwnership; sFilters.ownership = filterOwnership; }
      if (filterTarget) { oFilters.target = filterTarget; sFilters.target = filterTarget; }
      if (filterOfficerClass) oFilters.officerClass = filterOfficerClass;
      if (filterHullType) sFilters.hullType = filterHullType;

      const [o, s, c] = await Promise.all([
        fetchCatalogOfficers(oFilters),
        fetchCatalogShips(sFilters),
        fetchCatalogCounts(),
      ]);
      officers = o;
      ships = s;
      counts = c;
    } catch (err) {
      console.error("Catalog refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  function switchTab(tab: "officers" | "ships") {
    activeTab = tab;
    searchQuery = "";
    letterFilter = "";
    filterOwnership = "";
    filterTarget = "";
    filterOfficerClass = "";
    filterHullType = "";
    undoStack = [];
    refresh();
  }

  function handleSearch(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = val;
      letterFilter = "";
      refresh();
    }, 200);
  }

  function clearSearch() {
    searchQuery = "";
    letterFilter = "";
    searchInputEl?.focus();
    refresh();
  }

  function setLetterFilter(letter: string) {
    letterFilter = letterFilter === letter ? "" : letter;
  }

  function setFilterOwnership(val: string) {
    filterOwnership = filterOwnership === val ? "" : val;
    refresh();
  }

  function setFilterTarget(val: string) {
    filterTarget = filterTarget === val ? "" : val;
    refresh();
  }

  function setFilterOfficerClass(e: Event) {
    filterOfficerClass = (e.target as HTMLSelectElement).value;
    refresh();
  }

  function setFilterHullType(e: Event) {
    filterHullType = (e.target as HTMLSelectElement).value;
    refresh();
  }

  function clearAllFilters() {
    searchQuery = "";
    letterFilter = "";
    filterOwnership = "";
    filterTarget = "";
    filterOfficerClass = "";
    filterHullType = "";
    refresh();
  }

  const hasFilters = $derived(
    !!searchQuery || !!letterFilter || !!filterOwnership || !!filterTarget ||
    !!filterOfficerClass || !!filterHullType,
  );

  // ── Overlay toggles ──

  async function toggleOwned(item: CatalogOfficer | CatalogShip) {
    const next: OwnershipState = item.ownershipState === "owned" ? "unowned" : "owned";
    try {
      if (activeTab === "officers") {
        await setOfficerOverlay(item.id, { ownershipState: next });
      } else {
        await setShipOverlay(item.id, { ownershipState: next });
      }
      item.ownershipState = next;
      counts = await fetchCatalogCounts();
    } catch (err) {
      console.error("Toggle owned failed:", err);
    }
  }

  async function toggleTarget(item: CatalogOfficer | CatalogShip) {
    const next = !item.target;
    try {
      if (activeTab === "officers") {
        await setOfficerOverlay(item.id, { target: next });
      } else {
        await setShipOverlay(item.id, { target: next });
      }
      item.target = next;
      counts = await fetchCatalogCounts();
    } catch (err) {
      console.error("Toggle target failed:", err);
    }
  }

  // ── Bulk actions ──

  async function bulkOwnership(state: OwnershipState) {
    const visible = filteredItems;
    if (!visible.length) return;
    const refIds = visible.map((it) => it.id);
    const previous = new Map(
      visible.map((it) => [it.id, { ownershipState: it.ownershipState, target: it.target }]),
    );
    try {
      if (activeTab === "officers") {
        await bulkSetOfficerOverlay(refIds, { ownershipState: state });
      } else {
        await bulkSetShipOverlay(refIds, { ownershipState: state });
      }
      undoStack = [...undoStack, { type: activeTab, refIds, previousStates: previous, count: refIds.length }];
      await refresh();
    } catch (err) {
      console.error("Bulk ownership failed:", err);
    }
  }

  async function bulkToggleTarget() {
    const visible = filteredItems;
    if (!visible.length) return;
    const anyNotTargeted = visible.some((it) => !it.target);
    const refIds = visible.map((it) => it.id);
    const previous = new Map(
      visible.map((it) => [it.id, { ownershipState: it.ownershipState, target: it.target }]),
    );
    try {
      if (activeTab === "officers") {
        await bulkSetOfficerOverlay(refIds, { target: anyNotTargeted });
      } else {
        await bulkSetShipOverlay(refIds, { target: anyNotTargeted });
      }
      undoStack = [...undoStack, { type: activeTab, refIds, previousStates: previous, count: refIds.length }];
      await refresh();
    } catch (err) {
      console.error("Bulk target failed:", err);
    }
  }

  async function undoLast() {
    if (!undoStack.length) return;
    const entry = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    try {
      const ownedIds = [...entry.previousStates.entries()]
        .filter(([, v]) => v.ownershipState === "owned")
        .map(([k]) => k);
      const unownedIds = [...entry.previousStates.entries()]
        .filter(([, v]) => v.ownershipState === "unowned")
        .map(([k]) => k);
      const unknownIds = [...entry.previousStates.entries()]
        .filter(([, v]) => v.ownershipState === "unknown")
        .map(([k]) => k);
      const fn = entry.type === "officers" ? bulkSetOfficerOverlay : bulkSetShipOverlay;
      if (ownedIds.length) await fn(ownedIds, { ownershipState: "owned" });
      if (unownedIds.length) await fn(unownedIds, { ownershipState: "unowned" });
      if (unknownIds.length) await fn(unknownIds, { ownershipState: "unknown" });
      await refresh();
    } catch (err) {
      console.error("Undo failed:", err);
    }
  }

  // ── Helpers ──

  function isOfficer(item: CatalogOfficer | CatalogShip): item is CatalogOfficer {
    return "officerClass" in item;
  }

  // ── Init ──

  onMount(() => { refresh(); });
</script>

<div class="catalog-area">
  <!-- Tab Bar -->
  <div class="cat-tabs" role="tablist">
    <button
      class="cat-tab"
      class:active={activeTab === "officers"}
      role="tab"
      aria-selected={activeTab === "officers"}
      onclick={() => switchTab("officers")}
    >
      👤 Officers
      <span class="cat-tab-count">{tabOfficerCount}</span>
      <span class="cat-tab-owned">{ownedOfficerCount} owned</span>
    </button>
    <button
      class="cat-tab"
      class:active={activeTab === "ships"}
      role="tab"
      aria-selected={activeTab === "ships"}
      onclick={() => switchTab("ships")}
    >
      🚀 Ships
      <span class="cat-tab-count">{tabShipCount}</span>
      <span class="cat-tab-owned">{ownedShipCount} owned</span>
    </button>
  </div>

  <!-- Toolbar -->
  <div class="cat-toolbar">
    <div class="cat-search-wrap">
      <span class="cat-search-icon">🔍</span>
      <input
        bind:this={searchInputEl}
        class="cat-search"
        type="text"
        placeholder="Search {activeTab}…"
        value={searchQuery}
        oninput={handleSearch}
        onkeydown={(e) => e.key === "Escape" && clearSearch()}
        aria-label="Search {activeTab}"
      />
      {#if searchQuery}
        <button class="cat-search-clear" onclick={clearSearch} aria-label="Clear search">✕</button>
      {/if}
    </div>
    <span class="cat-result-count">{resultCount} / {totalCount}</span>
  </div>

  <!-- Letter Bar -->
  <div class="cat-letter-bar" role="toolbar" aria-label="Filter by letter">
    <button
      class="cat-letter"
      class:active={!letterFilter}
      onclick={() => { letterFilter = ""; }}
    >All</button>
    {#each "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") as letter}
      <button
        class="cat-letter"
        class:active={letterFilter === letter}
        class:has-items={letters.has(letter)}
        disabled={!letters.has(letter)}
        onclick={() => setLetterFilter(letter)}
      >{letter}</button>
    {/each}
  </div>

  <!-- Filter Chips -->
  <div class="cat-filters">
    <div class="cat-chip-group">
      <button class="cat-chip" class:active={filterOwnership === "owned"} onclick={() => setFilterOwnership("owned")}>Owned</button>
      <button class="cat-chip" class:active={filterOwnership === "unowned"} onclick={() => setFilterOwnership("unowned")}>Unowned</button>
    </div>
    <div class="cat-chip-group">
      <button class="cat-chip" class:active={filterTarget === "true"} onclick={() => setFilterTarget("true")}>🎯 Targeted</button>
    </div>
    {#if activeTab === "officers"}
      <select class="cat-dropdown" value={filterOfficerClass} onchange={setFilterOfficerClass} aria-label="Filter by officer class">
        <option value="">All Classes</option>
        <option value="1">Command</option>
        <option value="2">Science</option>
        <option value="3">Engineering</option>
      </select>
    {:else}
      <select class="cat-dropdown" value={filterHullType} onchange={setFilterHullType} aria-label="Filter by hull type">
        <option value="">All Hull Types</option>
        <option value="0">Destroyer</option>
        <option value="1">Survey</option>
        <option value="2">Explorer</option>
        <option value="3">Battleship</option>
        <option value="4">Defense Platform</option>
        <option value="5">Armada</option>
      </select>
    {/if}
    {#if hasFilters}
      <button class="cat-chip cat-chip-clear" onclick={clearAllFilters}>Clear Filters</button>
    {/if}
  </div>

  <!-- Bulk Actions -->
  <div class="cat-bulk-actions">
    <button class="cat-bulk-btn" onclick={() => bulkOwnership("owned")} disabled={!filteredItems.length}>
      Mark Owned ({resultCount})
    </button>
    <button class="cat-bulk-btn" onclick={() => bulkOwnership("unowned")} disabled={!filteredItems.length}>
      Mark Unowned ({resultCount})
    </button>
    <button class="cat-bulk-btn" onclick={bulkToggleTarget} disabled={!filteredItems.length}>
      Toggle Target ({resultCount})
    </button>
  </div>

  <!-- Undo Bar -->
  {#if undoStack.length > 0}
    <div class="cat-undo-bar">
      <span>Updated {undoStack[undoStack.length - 1].count} {undoStack[undoStack.length - 1].type}</span>
      <button onclick={undoLast}>Undo</button>
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="cat-loading">Loading…</div>
  {/if}

  <!-- Grid -->
  <div class="cat-grid" role="list">
    {#each filteredItems as item (item.id)}
      <div
        class="cat-card"
        class:owned={item.ownershipState === "owned"}
        class:targeted={item.target}
        role="listitem"
      >
        <div class="cat-card-header">
          <span class="cat-card-name">{item.name}</span>
          <div class="cat-card-badges">
            {#if item.rarity}
              <Badge kind="rarity" value={item.rarity} />
            {/if}
            {#if isOfficer(item) && item.officerClass}
              <Badge kind="class" value={item.officerClass} />
            {/if}
            {#if !isOfficer(item) && (item as CatalogShip).hullType != null}
              <Badge kind="hull" value={(item as CatalogShip).hullType} />
            {/if}
            {#if isOfficer(item) && item.groupName}
              <Badge kind="group" value={item.groupName} />
            {/if}
            {#if isOfficer(item) && item.faction?.name}
              <Badge kind="faction" value={item.faction.name} />
            {/if}
            {#if !isOfficer(item) && (item as CatalogShip).faction}
              <Badge kind="faction" value={(item as CatalogShip).faction} />
            {/if}
            {#if item.target}
              <Badge kind="target" value="target" />
            {/if}
          </div>
        </div>

        <!-- Officer abilities -->
        {#if isOfficer(item)}
          <div class="cat-card-abilities">
            {#if item.captainManeuver}
              <div class="cat-ability"><span class="cat-ability-label">CM:</span> {item.captainManeuver}</div>
            {/if}
            {#if item.officerAbility}
              <div class="cat-ability"><span class="cat-ability-label">OA:</span> {item.officerAbility}</div>
            {/if}
            {#if item.belowDeckAbility}
              <div class="cat-ability cat-ability-bda"><span class="cat-ability-label">BD:</span> {item.belowDeckAbility}</div>
            {/if}
          </div>
        {/if}

        <!-- Ship meta -->
        {#if !isOfficer(item)}
          {@const ship = item as CatalogShip}
          <div class="cat-card-meta">
            {#if ship.maxTier}<span>Max Tier {ship.maxTier}</span>{/if}
            {#if ship.maxLevel}<span>Max Level {ship.maxLevel}</span>{/if}
            {#if ship.buildTimeInSeconds}<span>{formatDuration(ship.buildTimeInSeconds)}</span>{/if}
          </div>
        {/if}

        <!-- Actions -->
        <div class="cat-card-actions">
          <button
            class="cat-action-btn"
            class:active={item.ownershipState === "owned"}
            onclick={() => toggleOwned(item)}
            aria-label={item.ownershipState === "owned" ? "Mark unowned" : "Mark owned"}
          >
            {item.ownershipState === "owned" ? "✓ Owned" : "Mark Owned"}
          </button>
          <button
            class="cat-action-btn"
            class:active={item.target}
            onclick={() => toggleTarget(item)}
            aria-label={item.target ? "Remove target" : "Set target"}
          >
            {item.target ? "🎯 Targeted" : "Target"}
          </button>
        </div>
      </div>
    {:else}
      <div class="cat-empty">
        {#if hasFilters}
          No {activeTab} match your filters.
          <button class="cat-chip cat-chip-clear" onclick={clearAllFilters}>Clear Filters</button>
        {:else}
          No {activeTab} data available.
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .catalog-area {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Tabs */
  .cat-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 16px;
    border-bottom: 2px solid var(--border);
  }
  .cat-tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 20px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    transition: all 0.15s;
  }
  .cat-tab:hover { color: var(--text-secondary); }
  .cat-tab.active { color: var(--accent-gold); border-bottom-color: var(--accent-gold); }
  .cat-tab-count {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-weight: 600;
  }
  .cat-tab.active .cat-tab-count { background: rgba(240, 160, 48, 0.15); color: var(--accent-gold); }
  .cat-tab-owned { font-size: 10px; color: var(--accent-green); font-weight: 500; }

  /* Toolbar */
  .cat-toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
    align-items: center;
  }
  .cat-search-wrap { flex: 1; position: relative; }
  .cat-search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--text-muted); pointer-events: none; font-size: 13px;
  }
  .cat-search {
    width: 100%; padding: 8px 32px 8px 32px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text-primary); font-size: 14px;
    outline: none;
  }
  .cat-search:focus { border-color: var(--accent-gold); box-shadow: 0 0 0 2px rgba(240, 160, 48, 0.15); }
  .cat-search::placeholder { color: var(--text-muted); }
  .cat-search-clear {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 13px; padding: 2px 4px; border-radius: 4px;
  }
  .cat-search-clear:hover { color: var(--text-primary); background: var(--bg-hover); }
  .cat-result-count { font-size: 12px; color: var(--text-muted); white-space: nowrap; }

  /* Letter Bar */
  .cat-letter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-bottom: 10px;
  }
  .cat-letter {
    padding: 3px 7px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    min-width: 24px;
    text-align: center;
  }
  .cat-letter:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-gold); }
  .cat-letter.active { background: var(--accent-gold); color: var(--bg-primary); border-color: var(--accent-gold); }
  .cat-letter:disabled { opacity: 0.3; cursor: default; }
  .cat-letter.has-items { color: var(--text-secondary); }

  /* Filters */
  .cat-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
    align-items: center;
  }
  .cat-chip-group { display: flex; gap: 4px; }
  .cat-chip {
    padding: 4px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .cat-chip:hover { color: var(--text-primary); border-color: var(--accent-gold); }
  .cat-chip.active { background: rgba(240, 160, 48, 0.15); color: var(--accent-gold); border-color: var(--accent-gold); }
  .cat-chip-clear { color: var(--accent-red, #f44); border-color: var(--accent-red, #f44); }
  .cat-dropdown {
    padding: 4px 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 12px;
  }

  /* Bulk Actions */
  .cat-bulk-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .cat-bulk-btn {
    padding: 5px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .cat-bulk-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-gold); }
  .cat-bulk-btn:disabled { opacity: 0.4; cursor: default; }

  /* Undo Bar */
  .cat-undo-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: rgba(240, 160, 48, 0.1);
    border: 1px solid var(--accent-gold);
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--accent-gold);
  }
  .cat-undo-bar button {
    padding: 3px 12px;
    background: var(--accent-gold);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  }

  /* Loading */
  .cat-loading {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }

  /* Grid */
  .cat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    padding-bottom: 24px;
  }

  /* Card */
  .cat-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 0.15s;
  }
  .cat-card:hover { border-color: var(--text-muted); }
  .cat-card.owned { border-left: 3px solid var(--accent-green); }
  .cat-card.targeted { border-right: 3px solid var(--accent-gold); }

  .cat-card-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cat-card-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text-primary);
  }
  .cat-card-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .cat-card-abilities {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .cat-ability-label {
    font-weight: 600;
    color: var(--accent-gold);
    font-size: 11px;
  }
  .cat-ability-bda { color: var(--text-muted); }

  .cat-card-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .cat-card-actions {
    display: flex;
    gap: 6px;
    margin-top: auto;
    padding-top: 4px;
  }
  .cat-action-btn {
    flex: 1;
    padding: 5px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    text-align: center;
  }
  .cat-action-btn:hover { color: var(--text-primary); border-color: var(--accent-gold); }
  .cat-action-btn.active {
    background: rgba(76, 175, 80, 0.15);
    color: var(--accent-green);
    border-color: var(--accent-green);
  }

  /* Empty State */
  .cat-empty {
    grid-column: 1 / -1;
    padding: 48px 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }

  @media (max-width: 768px) {
    .catalog-area { padding: 12px; }
    .cat-grid { grid-template-columns: 1fr; }
    .cat-letter-bar { display: none; }
    .cat-bulk-actions { flex-wrap: wrap; }
  }
</style>
