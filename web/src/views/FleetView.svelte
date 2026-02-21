<script lang="ts">
  /**
   * Fleet View — owned roster with inline editing, cross-references, and reservations.
   * Ported from src/client/views/fleet/fleet.js (~914 LOC).
   */
  import { onMount, onDestroy } from "svelte";
  import "../styles/fleet-view.css";
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
    Dock,
    EffectiveDockState,
  } from "../lib/types.js";
  import {
    officerClassShort,
    hullTypeLabel,
    rarityRank,
    formatPower,
  } from "../lib/game-enums.js";
  import {
    applyFleetFieldEdit,
    buildFleetCrossRefMaps,
    isFleetOfficer,
  } from "../lib/fleet-view-helpers.js";
  import {
    createInitialFleetViewUiState,
    routeFleetViewCommand,
    type FleetViewCommand,
  } from "../lib/fleet-view-commands.js";

  // ── State ──

  let officers = $state<CatalogOfficer[]>([]);
  let ships = $state<CatalogShip[]>([]);
  let ui = $state(createInitialFleetViewUiState());
  let loading = $state(false);

  // Cross-reference maps
  let officerUsedIn = $state<Map<string, string[]>>(new Map());
  let shipUsedIn = $state<Map<string, string[]>>(new Map());
  let officerConflicts = $state<Map<string, OfficerConflict>>(new Map());
  let shipDockMap = $state<Map<string, string>>(new Map());
  let reservationMap = $state<Map<string, OfficerReservation>>(new Map());
  let crossRefDirty = $state(true);
  let crossRefLastBuiltAt = 0;
  let crossRefLoadedTabs = new Set<string>();

  const CROSS_REF_REBUILD_MS = 60_000;

  // Save feedback
  let saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let saveStatus = $state<Map<string, "saving" | "saved" | "error">>(new Map());

  // Reservation editing
  let reservationText = $state("");
  let reservationLocked = $state(false);

  function send(command: FleetViewCommand) {
    ui = routeFleetViewCommand(ui, command);
  }

  const FLEET_VIEW_MODE_KEY = "display.fleetViewMode";

  // ── Derived ──

  const items = $derived(ui.activeTab === "officers" ? officers : ships) as (CatalogOfficer | CatalogShip)[];

  const filtered = $derived.by(() => {
    let list = items;
    if (ui.searchQuery) {
      const q = ui.searchQuery.toLowerCase();
      list = list.filter((it) => it.name.toLowerCase().includes(q));
    }
    return list;
  });

  const sorted = $derived.by(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let cmp = 0;
      switch (ui.sortField) {
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
      return ui.sortDir === "asc" ? cmp : -cmp;
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

  // ── Cross-ref builder (tab-scoped lazy loading) ──

  async function buildCrossRefs() {
    try {
      // Only fetch the datasets actually needed for the active tab.
      // fetchBelowDeckPolicies() was previously fetched but never consumed.
      const needOfficerRefs = ui.activeTab === "officers" || !crossRefLoadedTabs.has("officers");
      const needShipRefs = ui.activeTab === "ships" || !crossRefLoadedTabs.has("ships");

      const fetches: Promise<unknown>[] = [];

      // Shared: effectiveState needed by both tabs (conflicts + dock mapping)
      const effectivePromise = (needOfficerRefs || needShipRefs)
        ? fetchEffectiveState()
        : Promise.resolve(null);

      // Officer-specific
      const coresPromise = needOfficerRefs ? fetchBridgeCores() : Promise.resolve(null);
      const reservationsPromise = needOfficerRefs ? fetchReservations() : Promise.resolve(null);

      // Ship-specific
      const loadoutsPromise = needShipRefs ? fetchCrewLoadouts() : Promise.resolve(null);
      const docksPromise = needShipRefs ? fetchCrewDocks() : Promise.resolve(null);

      const [cores, loadouts, reservations, effective, docks] = await Promise.all([
        coresPromise,
        loadoutsPromise,
        reservationsPromise,
        effectivePromise,
        docksPromise,
      ]);

      const maps = buildFleetCrossRefMaps({
        cores: cores ?? [],
        loadouts: loadouts ?? [],
        reservations: reservations ?? [],
        effective,
        docks: docks ?? [],
      });

      if (needOfficerRefs) {
        officerUsedIn = maps.officerUsedIn;
        officerConflicts = maps.officerConflicts;
        reservationMap = maps.reservationMap;
        crossRefLoadedTabs.add("officers");
      }
      if (needShipRefs) {
        shipUsedIn = maps.shipUsedIn;
        shipDockMap = maps.shipDockMap;
        crossRefLoadedTabs.add("ships");
      }

      crossRefDirty = false;
      crossRefLastBuiltAt = Date.now();
    } catch (err) {
      console.error("Cross-ref build failed:", err);
    }
  }

  async function maybeBuildCrossRefs() {
    const stale = Date.now() - crossRefLastBuiltAt > CROSS_REF_REBUILD_MS;
    const tabMissing = !crossRefLoadedTabs.has(ui.activeTab);
    if (crossRefDirty || stale || tabMissing) {
      await buildCrossRefs();
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
      await maybeBuildCrossRefs();
    } catch (err) {
      console.error("Fleet refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  function switchTab(tab: "officers" | "ships") {
    send({ type: "tab/switch", tab });
  }

  function toggleSort(field: string) {
    send({ type: "sort/toggle", field });
  }

  async function setViewMode(mode: "cards" | "list") {
    if (ui.viewMode === mode) return;
    send({ type: "view-mode/set", mode });
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
    const edit = applyFleetFieldEdit(item, field, value);
    const officerPatch = edit.officerPatch;
    if (officerPatch) {
      debouncedSave(edit.key, 600, () => setOfficerOverlay(item.id, officerPatch));
      return;
    }
    const shipPatch = edit.shipPatch;
    if (shipPatch) {
      debouncedSave(edit.key, 600, () => setShipOverlay(item.id, shipPatch));
    }
  }

  function handleNoteChange(item: CatalogOfficer | CatalogShip, value: string) {
    const key = `${item.id}-note`;
    item.targetNote = value || null;
    debouncedSave(key, 800, () =>
      isFleetOfficer(item)
        ? setOfficerOverlay(item.id, { targetNote: value || null })
        : setShipOverlay(item.id, { targetNote: value || null }),
    );
  }

  // ── Target toggle ──

  async function toggleTarget(item: CatalogOfficer | CatalogShip) {
    const next = !item.target;
    try {
      if (isFleetOfficer(item)) {
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
    send({ type: "reservation/edit-start", officerId });
    reservationText = existing?.reservedFor ?? "";
    reservationLocked = existing?.locked ?? false;
  }

  async function saveReservation() {
    if (!ui.editingReservation) return;
    try {
      if (reservationText.trim()) {
        await setReservation(ui.editingReservation, reservationText.trim(), reservationLocked, "");
        reservationMap = new Map(reservationMap).set(ui.editingReservation, {
          officerId: ui.editingReservation,
          reservedFor: reservationText.trim(),
          locked: reservationLocked,
          notes: null,
          createdAt: new Date().toISOString(),
        });
      } else {
        await deleteReservation(ui.editingReservation);
        const m = new Map(reservationMap);
        m.delete(ui.editingReservation);
        reservationMap = m;
      }
      crossRefDirty = true;
      crossRefLoadedTabs.clear();
    } catch (err) {
      console.error("Reservation save failed:", err);
    }
    send({ type: "reservation/edit-cancel" });
  }

  function cancelReservation() {
    send({ type: "reservation/edit-cancel" });
  }

  // ── Helpers ──

  const isOfficer = isFleetOfficer;

  // ── Lifecycle ──

  onMount(() => {
    void (async () => {
      const savedMode = await loadUserSetting(FLEET_VIEW_MODE_KEY, "cards");
      send({ type: "view-mode/set", mode: savedMode === "list" ? "list" : "cards" });
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
      class:active={ui.activeTab === "officers"}
      role="tab"
      aria-selected={ui.activeTab === "officers"}
      onclick={() => switchTab("officers")}
    >
      👤 Officers <span class="fleet-tab-count">{officers.length}</span>
    </button>
    <button
      class="fleet-tab"
      class:active={ui.activeTab === "ships"}
      role="tab"
      aria-selected={ui.activeTab === "ships"}
      onclick={() => switchTab("ships")}
    >
      🚀 Ships <span class="fleet-tab-count">{ships.length}</span>
    </button>
  </div>

  <!-- Stats Bar -->
  <div class="fleet-stats">
    <span class="fleet-stat"><strong>{statCount}</strong> {ui.activeTab}</span>
    <span class="fleet-stat">Avg Level <strong>{statAvgLevel}</strong></span>
    <span class="fleet-stat">Total Power <strong>{formatPower(statTotalPower)}</strong></span>
    <span class="fleet-stat">🎯 <strong>{statTargetedCount}</strong> targeted</span>
  </div>

  <!-- Toolbar -->
  <div class="fleet-toolbar">
    <input
      class="fleet-search"
      type="text"
      placeholder="Filter {ui.activeTab}…"
      value={ui.searchQuery}
      oninput={(e) => send({ type: "search/set", value: (e.target as HTMLInputElement).value })}
      aria-label="Filter {ui.activeTab}"
    />

    <div class="fleet-sort-group">
      <span class="fleet-sort-label">Sort:</span>
      {#each [["name", "Name"], ["level", "Level"], ["power", "Power"], ["rarity", "Rarity"]] as [key, label]}
        <button
          class="fleet-sort-btn"
          class:active={ui.sortField === key}
          onclick={() => toggleSort(key)}
        >
          {label}
          {#if ui.sortField === key}
            <span class="fleet-sort-arrow">{ui.sortDir === "asc" ? "▲" : "▼"}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="fleet-view-toggle">
      <button
        class="fleet-view-btn"
        class:active={ui.viewMode === "cards"}
        onclick={() => { void setViewMode("cards"); }}
        aria-label="Card view"
      >▦</button>
      <button
        class="fleet-view-btn"
        class:active={ui.viewMode === "list"}
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
  {#if ui.viewMode === "cards"}
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
          {#if ui.editingReservation === item.id}
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
          {#if ui.searchQuery}
            No {ui.activeTab} match "{ui.searchQuery}".
          {:else}
            No owned {ui.activeTab} yet. Mark items as owned in the Catalog view.
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <!-- List Mode -->
    <div class="fleet-list" role="table">
      <div class="fleet-list-header" role="row">
        <span class="fleet-col-name" role="columnheader">Name</span>
        {#if ui.activeTab === "officers"}
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
          {#if ui.searchQuery}
            No {ui.activeTab} match "{ui.searchQuery}".
          {:else}
            No owned {ui.activeTab} yet.
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

