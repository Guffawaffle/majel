<script lang="ts">
  /**
   * Fleet View — owned roster with inline editing, cross-references, and reservations.
   * Ported from src/client/views/fleet/fleet.js (~914 LOC).
   */
  import { onMount, onDestroy } from "svelte";
  import Badge from "../components/Badge.svelte";
  import {
    fetchCatalogOfficers,
    fetchCatalogShips,
    setOfficerOverlay,
    setShipOverlay,
  } from "../lib/api/catalog.js";
  import {
    fetchBridgeCores,
    fetchCrewLoadouts,
    fetchBelowDeckPolicies,
    fetchReservations,
    fetchEffectiveState,
    fetchCrewDocks,
    setReservation,
    deleteReservation,
  } from "../lib/api/crews.js";
  import { loadUserSetting, saveUserSetting } from "../lib/api/user-settings.js";
  import type {
    CatalogOfficer,
    CatalogShip,
    OfficerReservation,
    OfficerConflict,
    BridgeCoreWithMembers,
    Loadout,
    BelowDeckPolicy,
    Dock,
    EffectiveDockState,
  } from "../lib/types.js";
  import {
    officerClassShort,
    hullTypeLabel,
    rarityRank,
    formatPower,
  } from "../lib/game-enums.js";

  // ── State ──

  let officers = $state<CatalogOfficer[]>([]);
  let ships = $state<CatalogShip[]>([]);
  let activeTab = $state<"officers" | "ships">("officers");
  let viewMode = $state<"cards" | "list">("cards");
  let searchQuery = $state("");
  let sortField = $state("name");
  let sortDir = $state<"asc" | "desc">("asc");
  let loading = $state(false);

  // Cross-reference maps
  let officerUsedIn = $state<Map<string, string[]>>(new Map());
  let shipUsedIn = $state<Map<string, string[]>>(new Map());
  let officerConflicts = $state<Map<string, OfficerConflict>>(new Map());
  let shipDockMap = $state<Map<string, string>>(new Map());
  let reservationMap = $state<Map<string, OfficerReservation>>(new Map());

  // Save feedback
  let saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let saveStatus = $state<Map<string, "saving" | "saved" | "error">>(new Map());

  // Reservation editing
  let editingReservation = $state<string | null>(null);
  let reservationText = $state("");
  let reservationLocked = $state(false);

  const FLEET_VIEW_MODE_KEY = "display.fleetViewMode";

  // ── Derived ──

  const items = $derived(activeTab === "officers" ? officers : ships) as (CatalogOfficer | CatalogShip)[];

  const filtered = $derived.by(() => {
    let list = items;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((it) => it.name.toLowerCase().includes(q));
    }
    return list;
  });

  const sorted = $derived.by(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "level":
          cmp = ((a as CatalogOfficer).userLevel ?? 0) - ((b as CatalogOfficer).userLevel ?? 0);
          break;
        case "power":
          cmp = (a.userPower ?? 0) - (b.userPower ?? 0);
          break;
        case "rarity":
          cmp = rarityRank(a.rarity) - rarityRank(b.rarity);
          break;
        default:
          cmp = a.name.localeCompare(b.name);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  });

  // Stats
  const statCount = $derived(filtered.length);
  const statAvgLevel = $derived.by(() => {
    const arr = filtered.filter((it) => (it as CatalogOfficer).userLevel != null);
    if (!arr.length) return 0;
    const sum = arr.reduce((s, it) => s + ((it as CatalogOfficer).userLevel ?? 0), 0);
    return Math.round(sum / arr.length);
  });
  const statTotalPower = $derived.by(() => {
    return filtered.reduce((s, it) => s + (it.userPower ?? 0), 0);
  });
  const statTargetedCount = $derived(filtered.filter((it) => it.target).length);

  // ── Cross-ref builder ──

  async function buildCrossRefs() {
    try {
      const [cores, loadouts, policies, reservations, effective, docks] = await Promise.all([
        fetchBridgeCores(),
        fetchCrewLoadouts(),
        fetchBelowDeckPolicies(),
        fetchReservations(),
        fetchEffectiveState(),
        fetchCrewDocks(),
      ]);

      // Officer used-in map
      const oUsed = new Map<string, string[]>();
      for (const core of cores) {
        for (const m of core.members) {
          const list = oUsed.get(m.officerId) ?? [];
          list.push(`Bridge: ${core.name} (${m.slot})`);
          oUsed.set(m.officerId, list);
        }
      }

      // Ship used-in map + dock map
      const sUsed = new Map<string, string[]>();
      const sDock = new Map<string, string>();
      for (const loadout of loadouts) {
        const label = loadout.name || `Loadout #${loadout.id}`;
        const list = sUsed.get(loadout.shipId) ?? [];
        list.push(label);
        sUsed.set(loadout.shipId, list);
      }

      // Effective state — dock assignments
      for (const entry of effective?.docks ?? []) {
        if (entry.loadout) {
          const ld = entry.loadout as { shipId?: string; name?: string };
          if (ld.shipId) {
            const dock = docks.find((d) => d.dockNumber === entry.dockNumber);
            const label = dock?.label ?? `Dock ${entry.dockNumber}`;
            sDock.set(ld.shipId, label);
          }
        }
      }

      // Conflicts
      const oConflicts = new Map<string, OfficerConflict>();
      for (const c of effective?.conflicts ?? []) {
        oConflicts.set(c.officerId, c);
      }

      // Reservations
      const rMap = new Map<string, OfficerReservation>();
      for (const r of reservations) {
        rMap.set(r.officerId, r);
      }

      officerUsedIn = oUsed;
      shipUsedIn = sUsed;
      officerConflicts = oConflicts;
      shipDockMap = sDock;
      reservationMap = rMap;
    } catch (err) {
      console.error("Cross-ref build failed:", err);
    }
  }

  // ── Data loading ──

  async function refresh() {
    loading = true;
    try {
      const [o, s] = await Promise.all([
        fetchCatalogOfficers({ ownership: "owned" }),
        fetchCatalogShips({ ownership: "owned" }),
      ]);
      officers = o;
      ships = s;
      await buildCrossRefs();
    } catch (err) {
      console.error("Fleet refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  function switchTab(tab: "officers" | "ships") {
    activeTab = tab;
    searchQuery = "";
    sortField = "name";
    sortDir = "asc";
  }

  function toggleSort(field: string) {
    if (sortField === field) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortField = field;
      sortDir = "asc";
    }
  }

  async function setViewMode(mode: "cards" | "list") {
    if (viewMode === mode) return;
    viewMode = mode;
    try {
      await saveUserSetting(FLEET_VIEW_MODE_KEY, mode);
    } catch (err) {
      console.error("Failed to persist fleet view mode:", err);
    }
  }

  // ── Inline editing with debounced save ──

  function setSaveStatus(key: string, status: "saving" | "saved" | "error") {
    saveStatus = new Map(saveStatus).set(key, status);
    if (status === "saved") {
      setTimeout(() => {
        const m = new Map(saveStatus);
        m.delete(key);
        saveStatus = m;
      }, 2000);
    }
  }

  function debouncedSave(
    key: string,
    ms: number,
    saveFn: () => Promise<unknown>,
  ) {
    const existing = saveTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      saveTimers.delete(key);
      setSaveStatus(key, "saving");
      try {
        await saveFn();
        setSaveStatus(key, "saved");
      } catch {
        setSaveStatus(key, "error");
      }
    }, ms);
    saveTimers.set(key, timer);
  }

  function handleFieldChange(item: CatalogOfficer | CatalogShip, field: string, value: string) {
    const key = `${item.id}-${field}`;
    const numVal = value === "" ? null : Number(value);

    if (isOfficer(item)) {
      if (field === "level") item.userLevel = numVal;
      else if (field === "rank") item.userRank = value || null;
      else if (field === "power") item.userPower = numVal;
      debouncedSave(key, 600, () =>
        setOfficerOverlay(item.id, {
          level: field === "level" ? numVal : undefined,
          rank: field === "rank" ? (value || null) : undefined,
          power: field === "power" ? numVal : undefined,
        }),
      );
    } else {
      const ship = item as CatalogShip;
      if (field === "tier") ship.userTier = numVal;
      else if (field === "level") ship.userLevel = numVal;
      else if (field === "power") ship.userPower = numVal;
      debouncedSave(key, 600, () =>
        setShipOverlay(item.id, {
          tier: field === "tier" ? numVal : undefined,
          level: field === "level" ? numVal : undefined,
          power: field === "power" ? numVal : undefined,
        }),
      );
    }
  }

  function handleNoteChange(item: CatalogOfficer | CatalogShip, value: string) {
    const key = `${item.id}-note`;
    item.targetNote = value || null;
    debouncedSave(key, 800, () =>
      isOfficer(item)
        ? setOfficerOverlay(item.id, { targetNote: value || null })
        : setShipOverlay(item.id, { targetNote: value || null }),
    );
  }

  // ── Target toggle ──

  async function toggleTarget(item: CatalogOfficer | CatalogShip) {
    const next = !item.target;
    try {
      if (isOfficer(item)) {
        await setOfficerOverlay(item.id, { target: next });
      } else {
        await setShipOverlay(item.id, { target: next });
      }
      item.target = next;
    } catch (err) {
      console.error("Toggle target failed:", err);
    }
  }

  // ── Reservations ──

  function startEditReservation(officerId: string) {
    const existing = reservationMap.get(officerId);
    editingReservation = officerId;
    reservationText = existing?.reservedFor ?? "";
    reservationLocked = existing?.locked ?? false;
  }

  async function saveReservation() {
    if (!editingReservation) return;
    try {
      if (reservationText.trim()) {
        await setReservation(editingReservation, reservationText.trim(), reservationLocked, "");
        reservationMap = new Map(reservationMap).set(editingReservation, {
          officerId: editingReservation,
          reservedFor: reservationText.trim(),
          locked: reservationLocked,
          notes: null,
          createdAt: new Date().toISOString(),
        });
      } else {
        await deleteReservation(editingReservation);
        const m = new Map(reservationMap);
        m.delete(editingReservation);
        reservationMap = m;
      }
    } catch (err) {
      console.error("Reservation save failed:", err);
    }
    editingReservation = null;
  }

  function cancelReservation() {
    editingReservation = null;
  }

  // ── Helpers ──

  function isOfficer(item: CatalogOfficer | CatalogShip): item is CatalogOfficer {
    return "officerClass" in item;
  }

  // ── Lifecycle ──

  onMount(() => {
    void (async () => {
      const savedMode = await loadUserSetting(FLEET_VIEW_MODE_KEY, "cards");
      viewMode = savedMode === "list" ? "list" : "cards";
      await refresh();
    })();
  });

  onDestroy(() => {
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
  });
</script>

<div class="fleet-area">
  <!-- Tab Bar -->
  <div class="fleet-tabs" role="tablist">
    <button
      class="fleet-tab"
      class:active={activeTab === "officers"}
      role="tab"
      aria-selected={activeTab === "officers"}
      onclick={() => switchTab("officers")}
    >
      👤 Officers <span class="fleet-tab-count">{officers.length}</span>
    </button>
    <button
      class="fleet-tab"
      class:active={activeTab === "ships"}
      role="tab"
      aria-selected={activeTab === "ships"}
      onclick={() => switchTab("ships")}
    >
      🚀 Ships <span class="fleet-tab-count">{ships.length}</span>
    </button>
  </div>

  <!-- Stats Bar -->
  <div class="fleet-stats">
    <span class="fleet-stat"><strong>{statCount}</strong> {activeTab}</span>
    <span class="fleet-stat">Avg Level <strong>{statAvgLevel}</strong></span>
    <span class="fleet-stat">Total Power <strong>{formatPower(statTotalPower)}</strong></span>
    <span class="fleet-stat">🎯 <strong>{statTargetedCount}</strong> targeted</span>
  </div>

  <!-- Toolbar -->
  <div class="fleet-toolbar">
    <input
      class="fleet-search"
      type="text"
      placeholder="Filter {activeTab}…"
      bind:value={searchQuery}
      aria-label="Filter {activeTab}"
    />

    <div class="fleet-sort-group">
      <span class="fleet-sort-label">Sort:</span>
      {#each [["name", "Name"], ["level", "Level"], ["power", "Power"], ["rarity", "Rarity"]] as [key, label]}
        <button
          class="fleet-sort-btn"
          class:active={sortField === key}
          onclick={() => toggleSort(key)}
        >
          {label}
          {#if sortField === key}
            <span class="fleet-sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="fleet-view-toggle">
      <button
        class="fleet-view-btn"
        class:active={viewMode === "cards"}
        onclick={() => { void setViewMode("cards"); }}
        aria-label="Card view"
      >▦</button>
      <button
        class="fleet-view-btn"
        class:active={viewMode === "list"}
        onclick={() => { void setViewMode("list"); }}
        aria-label="List view"
      >☰</button>
    </div>
  </div>

  <!-- Loading -->
  {#if loading}
    <div class="fleet-loading">Loading fleet…</div>
  {/if}

  <!-- Card Grid Mode -->
  {#if viewMode === "cards"}
    <div class="fleet-grid" role="list">
      {#each sorted as item (item.id)}
        <div class="fleet-card" class:targeted={item.target} role="listitem">
          <div class="fleet-card-header">
            <span class="fleet-card-name">{item.name}</span>
            <div class="fleet-card-badges">
              {#if item.rarity}
                <Badge kind="rarity" value={item.rarity} />
              {/if}
              {#if isOfficer(item) && item.officerClass}
                <Badge kind="class" value={item.officerClass} />
              {/if}
              {#if !isOfficer(item) && (item as CatalogShip).hullType != null}
                <Badge kind="hull" value={(item as CatalogShip).hullType} />
              {/if}
              {#if item.target}
                <Badge kind="target" value="target" />
              {/if}
            </div>
          </div>

          <!-- Cross-references -->
          {#if isOfficer(item)}
            {@const usedIn = officerUsedIn.get(item.id)}
            {@const conflict = officerConflicts.get(item.id)}
            {@const reservation = reservationMap.get(item.id)}
            {#if usedIn?.length}
              <div class="fleet-xrefs">
                {#each usedIn as label}
                  <span class="fleet-xref">{label}</span>
                {/each}
              </div>
            {/if}
            {#if conflict}
              <Badge kind="conflict" value="conflict" />
            {/if}
            {#if reservation}
              <span class="fleet-reservation-badge">🔒 {reservation.reservedFor}</span>
            {/if}
          {:else}
            {@const usedIn = shipUsedIn.get(item.id)}
            {@const dock = shipDockMap.get(item.id)}
            {#if usedIn?.length}
              <div class="fleet-xrefs">
                {#each usedIn as label}
                  <span class="fleet-xref">{label}</span>
                {/each}
              </div>
            {/if}
            {#if dock}
              <Badge kind="dock" value={dock} />
            {/if}
          {/if}

          <!-- Inline Fields -->
          <div class="fleet-fields">
            {#if isOfficer(item)}
              <label class="fleet-field">
                <span>Level</span>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={item.userLevel ?? ""}
                  oninput={(e) => handleFieldChange(item, "level", (e.target as HTMLInputElement).value)}
                />
                {#if saveStatus.get(`${item.id}-level`)}
                  <span class="fleet-save-indicator fleet-save-{saveStatus.get(`${item.id}-level`)}">{saveStatus.get(`${item.id}-level`)}</span>
                {/if}
              </label>
              <label class="fleet-field">
                <span>Rank</span>
                <input
                  type="text"
                  value={item.userRank ?? ""}
                  oninput={(e) => handleFieldChange(item, "rank", (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="fleet-field">
                <span>Power</span>
                <input
                  type="number"
                  min="0"
                  max="999999999"
                  value={item.userPower ?? ""}
                  oninput={(e) => handleFieldChange(item, "power", (e.target as HTMLInputElement).value)}
                />
              </label>
            {:else}
              {@const ship = item as CatalogShip}
              <label class="fleet-field">
                <span>Tier</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={ship.userTier ?? ""}
                  oninput={(e) => handleFieldChange(item, "tier", (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="fleet-field">
                <span>Level</span>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={ship.userLevel ?? ""}
                  oninput={(e) => handleFieldChange(item, "level", (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="fleet-field">
                <span>Power</span>
                <input
                  type="number"
                  min="0"
                  max="999999999"
                  value={ship.userPower ?? ""}
                  oninput={(e) => handleFieldChange(item, "power", (e.target as HTMLInputElement).value)}
                />
              </label>
            {/if}
          </div>

          <!-- Notes -->
          <div class="fleet-note">
            <textarea
              placeholder="Notes…"
              rows="2"
              value={item.targetNote ?? ""}
              oninput={(e) => handleNoteChange(item, (e.target as HTMLTextAreaElement).value)}
              maxlength="500"
            ></textarea>
          </div>

          <!-- Actions -->
          <div class="fleet-card-actions">
            <button
              class="fleet-action-btn"
              class:active={item.target}
              onclick={() => toggleTarget(item)}
            >
              {item.target ? "🎯 Targeted" : "Target"}
            </button>
            {#if isOfficer(item)}
              <button
                class="fleet-action-btn"
                onclick={() => startEditReservation(item.id)}
              >
                {reservationMap.has(item.id) ? "Edit Reserve" : "Reserve"}
              </button>
            {/if}
          </div>

          <!-- Reservation editing inline -->
          {#if editingReservation === item.id}
            <div class="fleet-reservation-form">
              <input
                type="text"
                placeholder="Reserved for…"
                bind:value={reservationText}
                class="fleet-reservation-input"
              />
              <label class="fleet-reservation-lock">
                <input type="checkbox" bind:checked={reservationLocked} /> Lock
              </label>
              <button class="fleet-reservation-save" onclick={saveReservation}>Save</button>
              <button class="fleet-reservation-cancel" onclick={cancelReservation}>Cancel</button>
            </div>
          {/if}
        </div>
      {:else}
        <div class="fleet-empty">
          {#if searchQuery}
            No {activeTab} match "{searchQuery}".
          {:else}
            No owned {activeTab} yet. Mark items as owned in the Catalog view.
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <!-- List Mode -->
    <div class="fleet-list" role="table">
      <div class="fleet-list-header" role="row">
        <span class="fleet-col-name" role="columnheader">Name</span>
        {#if activeTab === "officers"}
          <span class="fleet-col" role="columnheader">Class</span>
          <span class="fleet-col" role="columnheader">Level</span>
          <span class="fleet-col" role="columnheader">Rank</span>
        {:else}
          <span class="fleet-col" role="columnheader">Hull</span>
          <span class="fleet-col" role="columnheader">Tier</span>
          <span class="fleet-col" role="columnheader">Level</span>
        {/if}
        <span class="fleet-col" role="columnheader">Power</span>
        <span class="fleet-col" role="columnheader">Target</span>
        <span class="fleet-col-wide" role="columnheader">Used In</span>
      </div>
      {#each sorted as item (item.id)}
        <div class="fleet-list-row" class:targeted={item.target} role="row">
          <span class="fleet-col-name">{item.name}</span>
          {#if isOfficer(item)}
            <span class="fleet-col">{officerClassShort(item.officerClass)}</span>
            <span class="fleet-col">
              <input
                class="fleet-inline-input"
                type="number" min="1" max="200"
                value={item.userLevel ?? ""}
                oninput={(e) => handleFieldChange(item, "level", (e.target as HTMLInputElement).value)}
              />
            </span>
            <span class="fleet-col">
              <input
                class="fleet-inline-input"
                type="text"
                value={item.userRank ?? ""}
                oninput={(e) => handleFieldChange(item, "rank", (e.target as HTMLInputElement).value)}
              />
            </span>
          {:else}
            {@const ship = item as CatalogShip}
            <span class="fleet-col">{hullTypeLabel(ship.hullType)}</span>
            <span class="fleet-col">
              <input
                class="fleet-inline-input"
                type="number" min="1" max="10"
                value={ship.userTier ?? ""}
                oninput={(e) => handleFieldChange(item, "tier", (e.target as HTMLInputElement).value)}
              />
            </span>
            <span class="fleet-col">
              <input
                class="fleet-inline-input"
                type="number" min="1" max="200"
                value={ship.userLevel ?? ""}
                oninput={(e) => handleFieldChange(item, "level", (e.target as HTMLInputElement).value)}
              />
            </span>
          {/if}
          <span class="fleet-col">
            <input
              class="fleet-inline-input"
              type="number" min="0" max="999999999"
              value={item.userPower ?? ""}
              oninput={(e) => handleFieldChange(item, "power", (e.target as HTMLInputElement).value)}
            />
          </span>
          <span class="fleet-col">
            <button
              class="fleet-target-btn"
              class:active={item.target}
              onclick={() => toggleTarget(item)}
            >{item.target ? "🎯" : "○"}</button>
          </span>
          <span class="fleet-col-wide fleet-xrefs-inline">
            {#if isOfficer(item)}
              {#each officerUsedIn.get(item.id) ?? [] as label}
                <span class="fleet-xref-sm">{label}</span>
              {/each}
              {#if officerConflicts.has(item.id)}
                <span class="fleet-xref-conflict">⚠</span>
              {/if}
            {:else}
              {#each shipUsedIn.get(item.id) ?? [] as label}
                <span class="fleet-xref-sm">{label}</span>
              {/each}
              {#if shipDockMap.has(item.id)}
                <span class="fleet-xref-dock">{shipDockMap.get(item.id)}</span>
              {/if}
            {/if}
          </span>
        </div>
      {:else}
        <div class="fleet-empty">
          {#if searchQuery}
            No {activeTab} match "{searchQuery}".
          {:else}
            No owned {activeTab} yet.
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .fleet-area {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Tabs */
  .fleet-tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 12px;
    border-bottom: 2px solid var(--border);
  }
  .fleet-tab {
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
  .fleet-tab:hover { color: var(--text-secondary); }
  .fleet-tab.active { color: var(--accent-gold); border-bottom-color: var(--accent-gold); }
  .fleet-tab-count {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-weight: 600;
  }
  .fleet-tab.active .fleet-tab-count { background: rgba(240, 160, 48, 0.15); color: var(--accent-gold); }

  /* Stats */
  .fleet-stats {
    display: flex;
    gap: 20px;
    padding: 8px 0;
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .fleet-stat strong { color: var(--text-primary); }

  /* Toolbar */
  .fleet-toolbar {
    display: flex;
    gap: 10px;
    margin-bottom: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .fleet-search {
    flex: 1;
    min-width: 150px;
    padding: 7px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
  }
  .fleet-search:focus { border-color: var(--accent-gold); }
  .fleet-search::placeholder { color: var(--text-muted); }

  .fleet-sort-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .fleet-sort-label { font-size: 12px; color: var(--text-muted); }
  .fleet-sort-btn {
    padding: 4px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .fleet-sort-btn:hover { color: var(--text-primary); }
  .fleet-sort-btn.active { color: var(--accent-gold); border-color: var(--accent-gold); }
  .fleet-sort-arrow { font-size: 10px; margin-left: 2px; }

  .fleet-view-toggle { display: flex; gap: 2px; }
  .fleet-view-btn {
    padding: 5px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
  }
  .fleet-view-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
  .fleet-view-btn:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .fleet-view-btn.active { background: var(--accent-gold); color: var(--bg-primary); border-color: var(--accent-gold); }

  /* Loading */
  .fleet-loading { padding: 20px; text-align: center; color: var(--text-muted); }

  /* Card Grid */
  .fleet-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
    padding-bottom: 24px;
  }

  .fleet-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    transition: border-color 0.15s;
  }
  .fleet-card:hover { border-color: var(--text-muted); }
  .fleet-card.targeted { border-left: 3px solid var(--accent-gold); }

  .fleet-card-header { display: flex; flex-direction: column; gap: 4px; }
  .fleet-card-name { font-weight: 600; font-size: 14px; color: var(--text-primary); }
  .fleet-card-badges { display: flex; flex-wrap: wrap; gap: 4px; }

  /* Cross-refs */
  .fleet-xrefs { display: flex; flex-wrap: wrap; gap: 4px; }
  .fleet-xref {
    font-size: 11px;
    padding: 2px 6px;
    background: rgba(100, 181, 246, 0.1);
    color: var(--accent-blue, #64b5f6);
    border-radius: 3px;
    border: 1px solid rgba(100, 181, 246, 0.2);
  }
  .fleet-reservation-badge {
    font-size: 11px;
    padding: 2px 6px;
    background: rgba(240, 160, 48, 0.1);
    color: var(--accent-gold);
    border-radius: 3px;
  }

  /* Inline Fields */
  .fleet-fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 8px;
  }
  .fleet-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .fleet-field input {
    padding: 4px 6px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    width: 100%;
  }
  .fleet-field input:focus { border-color: var(--accent-gold); }
  .fleet-save-indicator {
    font-size: 10px;
    font-weight: 500;
  }
  .fleet-save-saving { color: var(--accent-gold); }
  .fleet-save-saved { color: var(--accent-green); }
  .fleet-save-error { color: var(--accent-red, #f44); }

  /* Notes */
  .fleet-note textarea {
    width: 100%;
    padding: 6px 8px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-primary);
    font-size: 12px;
    resize: vertical;
    min-height: 36px;
    outline: none;
    font-family: inherit;
  }
  .fleet-note textarea:focus { border-color: var(--accent-gold); }
  .fleet-note textarea::placeholder { color: var(--text-muted); }

  /* Card Actions */
  .fleet-card-actions { display: flex; gap: 6px; margin-top: auto; }
  .fleet-action-btn {
    padding: 5px 10px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .fleet-action-btn:hover { color: var(--text-primary); border-color: var(--accent-gold); }
  .fleet-action-btn.active {
    background: rgba(240, 160, 48, 0.15);
    color: var(--accent-gold);
    border-color: var(--accent-gold);
  }

  /* Reservation Form */
  .fleet-reservation-form {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    flex-wrap: wrap;
  }
  .fleet-reservation-input {
    flex: 1;
    min-width: 100px;
    padding: 4px 8px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-primary);
    font-size: 12px;
  }
  .fleet-reservation-lock {
    font-size: 11px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .fleet-reservation-save,
  .fleet-reservation-cancel {
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    cursor: pointer;
    border: 1px solid var(--border);
  }
  .fleet-reservation-save {
    background: var(--accent-gold);
    color: var(--bg-primary);
    border-color: var(--accent-gold);
    font-weight: 600;
  }
  .fleet-reservation-cancel {
    background: var(--bg-secondary);
    color: var(--text-muted);
  }

  /* ─── List Mode ─── */
  .fleet-list {
    display: flex;
    flex-direction: column;
    font-size: 13px;
    padding-bottom: 24px;
  }
  .fleet-list-header {
    display: flex;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 2px solid var(--border);
    font-weight: 600;
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .fleet-list-row {
    display: flex;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--border);
    align-items: center;
    transition: background 0.1s;
  }
  .fleet-list-row:hover { background: var(--bg-hover); }
  .fleet-list-row.targeted { border-left: 3px solid var(--accent-gold); }

  .fleet-col-name { flex: 2; min-width: 120px; font-weight: 500; color: var(--text-primary); }
  .fleet-col { flex: 1; min-width: 60px; }
  .fleet-col-wide { flex: 2; min-width: 100px; }

  .fleet-inline-input {
    width: 100%;
    padding: 3px 6px;
    background: var(--bg-secondary);
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }
  .fleet-inline-input:focus { border-color: var(--accent-gold); background: var(--bg-tertiary); }

  .fleet-target-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .fleet-target-btn.active { background: rgba(240, 160, 48, 0.15); }

  .fleet-xrefs-inline { display: flex; flex-wrap: wrap; gap: 3px; }
  .fleet-xref-sm {
    font-size: 10px;
    padding: 1px 5px;
    background: rgba(100, 181, 246, 0.1);
    color: var(--accent-blue, #64b5f6);
    border-radius: 2px;
  }
  .fleet-xref-conflict { color: var(--accent-red, #f44); font-size: 12px; }
  .fleet-xref-dock {
    font-size: 10px;
    padding: 1px 5px;
    background: rgba(76, 175, 80, 0.1);
    color: var(--accent-green);
    border-radius: 2px;
  }

  /* Empty State */
  .fleet-empty {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
  }

  @media (max-width: 768px) {
    .fleet-area { padding: 12px; }
    .fleet-grid { grid-template-columns: 1fr; }
    .fleet-toolbar { flex-direction: column; }
    .fleet-stats { flex-wrap: wrap; gap: 10px; }
    .fleet-list-header,
    .fleet-list-row { font-size: 11px; }
    .fleet-col-wide { display: none; }
  }
</style>
