<script lang="ts">
  /**
   * EffectiveStateTab — Dock grid, conflicts, away teams, and override modal.
   * Most complex Plan tab.
   */
  import "../../styles/plan-shared.css";
  import { createCrewPlanItem } from "../../lib/api/crews.js";
  import type {
    EffectiveDockState,
    EffectiveDockEntry,
    FleetPresetWithSlots,
    Loadout,
    CatalogOfficer,
    BridgeSlot,
  } from "../../lib/types.js";
  import { intentLabel } from "../../lib/intent-catalog.js";

  // ── Props ──

  interface Props {
    effectiveState: EffectiveDockState | null;
    fleetPresets: FleetPresetWithSlots[];
    loadouts: Loadout[];
    officers: CatalogOfficer[];
    onRefresh: () => Promise<void>;
  }

  const { effectiveState, fleetPresets, loadouts, officers, onRefresh }: Props = $props();

  // ── Constants ──

  const SLOT_NAMES: Record<BridgeSlot, string> = {
    captain: "Captain",
    bridge_1: "Bridge 1",
    bridge_2: "Bridge 2",
  };
  const SOURCE_LABELS: Record<string, string> = { manual: "🟡 Manual", preset: "🟢 Preset" };

  // ── State ──

  let overrideDock = $state<number | null>(null);
  let overrideLoadoutId = $state("");
  let overrideLabel = $state("");
  let overridePriority = $state(1);
  let overrideError = $state("");
  let saving = $state(false);

  // ── Helpers ──

  function officerName(id: string): string {
    const off = officers.find((o) => o.id === id);
    return off?.name ?? id;
  }

  const activePreset = $derived(fleetPresets.find((p) => p.isActive));

  // ── Override modal ──

  function openOverride(dockNumber: number, existingLoadoutId?: number | null) {
    overrideDock = dockNumber;
    overrideLoadoutId = existingLoadoutId != null ? String(existingLoadoutId) : "";
    overrideLabel = "";
    overridePriority = 1;
    overrideError = "";
  }

  function closeOverride() {
    overrideDock = null;
    overrideError = "";
  }

  async function saveOverride() {
    if (saving) return;
    if (!overrideLoadoutId) { overrideError = "Select a loadout."; return; }
    if (overrideDock == null) return;

    overrideError = "";
    saving = true;
    try {
      await createCrewPlanItem({
        loadoutId: Number(overrideLoadoutId),
        dockNumber: overrideDock,
        notes: overrideLabel.trim(),
        priority: overridePriority,
        isActive: true,
        source: "manual",
        intentKey: "",
      });
      overrideDock = null;
      await onRefresh();
    } catch (err: unknown) {
      overrideError = err instanceof Error ? err.message : "Override failed.";
    } finally {
      saving = false;
    }
  }
</script>

<section class="estate">
  {#if !effectiveState}
    <p class="pl-empty">No effective state available.</p>
  {:else}
    <!-- Active preset banner -->
    {#if activePreset}
      <div class="pl-planning-note">
        This is your planned fleet state via <strong>{activePreset.name}</strong>.
        Ships and officers must be docked in-game before applying changes.
      </div>
    {/if}

    <!-- Conflicts -->
    {#if effectiveState.conflicts.length > 0}
      <div class="pl-conflicts">
        <h4>⚠️ Officer Conflicts ({effectiveState.conflicts.length})</h4>
        {#each effectiveState.conflicts as conflict}
          <div class="pl-conflict-row">
            <strong>{officerName(conflict.officerId)}</strong>
            <span>→</span>
            <span>
              {#each conflict.locations as loc, i}
                {#if i > 0}, {/if}
                {loc.entityName}{#if loc.slot} ({SLOT_NAMES[loc.slot as BridgeSlot] ?? loc.slot}){/if}
              {/each}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Dock Assignments -->
    <div class="pl-toolbar">
      <h3>Dock Assignments ({effectiveState.docks.length})</h3>
    </div>

    {#if effectiveState.docks.length === 0}
      <p class="pl-empty">No dock assignments found.</p>
    {:else}
      <div class="pl-dock-grid">
        {#each effectiveState.docks as dock}
          {@render dockCard(dock)}
        {/each}
      </div>
    {/if}

    <!-- Away Teams -->
    {#if effectiveState.awayTeams.length > 0}
      <div class="pl-toolbar pl-away-toolbar">
        <h3>Away Teams ({effectiveState.awayTeams.length})</h3>
      </div>
      <div class="pl-away-list">
        {#each effectiveState.awayTeams as team}
          <div class="pl-away-card">
            <div class="pl-away-header">
              <span>{team.label ?? "Away Team"}</span>
              <span class="pl-away-source">{team.source === "preset" ? "🟢" : "🟡"}</span>
            </div>
            <div class="pl-away-officers">
              {#each team.officers as offId}
                <span class="pl-away-officer">{officerName(offId)}</span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Override modal overlay -->
  {#if overrideDock != null}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pl-overlay" onclick={closeOverride} onkeydown={(e) => e.key === "Escape" && closeOverride()}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="pl-overlay-form" onclick={(e) => e.stopPropagation()}>
        <h3>Override Dock {overrideDock}</h3>
        <div class="pl-form-grid">
          <label class="pl-field">
            <span>Loadout</span>
            <select bind:value={overrideLoadoutId}>
              <option value="">— Select loadout —</option>
              {#each loadouts as lo}
                <option value={String(lo.id)}>{lo.name}</option>
              {/each}
            </select>
          </label>
          <label class="pl-field">
            <span>Label</span>
            <input type="text" bind:value={overrideLabel} maxlength="100" placeholder="e.g. Swarm grind dock" />
          </label>
          <label class="pl-field">
            <span>Priority</span>
            <input type="number" bind:value={overridePriority} min="1" max="100" />
          </label>
        </div>
        {#if overrideError}
          <p class="pl-form-error">{overrideError}</p>
        {/if}
        <div class="pl-form-actions">
          <button class="pl-btn pl-btn-save" disabled={saving} onclick={saveOverride}>Assign</button>
          <button class="pl-btn pl-btn-cancel" onclick={closeOverride}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</section>

{#snippet dockCard(dock: EffectiveDockEntry)}
  <div class="pl-dock-card" class:pl-dock-manual={dock.source === "manual"} class:pl-dock-empty={!dock.loadout}>
    <div class="pl-dock-header">
      <span class="pl-dock-num">#{dock.dockNumber}</span>
      {#if dock.source}
        <span class="pl-dock-source">{SOURCE_LABELS[dock.source] ?? dock.source}</span>
      {/if}
    </div>

    {#if !dock.loadout}
      <div class="pl-dock-body">
        <span class="pl-dock-unassigned">⚪ Unassigned</span>
      </div>
      <div class="pl-dock-footer">
        <button class="pl-action" onclick={() => openOverride(dock.dockNumber)}>Assign</button>
      </div>
    {:else}
      <div class="pl-dock-body">
        <div class="pl-dock-loadout">
          {dock.loadout.name}
          {#if dock.variantPatch}
            <span class="pl-badge pl-badge-variant">Variant</span>
          {/if}
        </div>
        {#if dock.loadout.bridge}
          <div class="pl-dock-bridge">
            {#each Object.entries(dock.loadout.bridge) as [slot, offId]}
              {#if offId}
                <span class="pl-bridge-slot">{SLOT_NAMES[slot as BridgeSlot] ?? slot}: {officerName(offId)}</span>
              {/if}
            {/each}
          </div>
        {/if}
        {#if dock.loadout.belowDeckPolicy?.name}
          <span class="pl-dock-detail">Policy: {dock.loadout.belowDeckPolicy.name}</span>
        {/if}
        {#if dock.loadout.intentKeys?.length}
          <div class="pl-dock-intents">
            {#each dock.loadout.intentKeys as key}
              <span class="pl-intent-chip">{intentLabel(key)}</span>
            {/each}
          </div>
        {/if}
      </div>
      <div class="pl-dock-footer">
        <button class="pl-action" onclick={() => openOverride(dock.dockNumber, dock.loadout?.loadoutId)}>Override</button>
      </div>
    {/if}
  </div>
{/snippet}

<style>
  /* ── Planning note ── */
  .pl-planning-note {
    background: var(--bg-tertiary);
    border: 1px solid var(--accent-gold-dim);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 14px;
    font-size: 0.88rem;
    color: var(--text-muted);
  }

  /* ── Conflicts ── */
  .pl-conflicts {
    background: rgba(255, 80, 80, 0.06);
    border: 1px solid var(--accent-red, #e55);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .pl-conflicts h4 { margin: 0 0 8px; font-size: 0.92rem; color: var(--accent-red, #e55); }
  .pl-conflict-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 0.85rem;
    margin-bottom: 4px;
  }

  /* ── Toolbar ── */
  .pl-toolbar h3 { margin: 0; font-size: 1.05rem; color: var(--text-primary); }
  .pl-away-toolbar { margin-top: 20px; }

  /* ── Dock grid ── */
  .pl-dock-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .pl-dock-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pl-dock-manual { border-left: 3px solid var(--accent-orange, #f90); }
  .pl-dock-empty { opacity: 0.7; }
  .pl-dock-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pl-dock-num { font-weight: 700; font-size: 0.92rem; }
  .pl-dock-source { font-size: 0.78rem; color: var(--text-muted); }
  .pl-dock-body { font-size: 0.85rem; display: flex; flex-direction: column; gap: 4px; }
  .pl-dock-unassigned { color: var(--text-muted); }
  .pl-dock-loadout { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .pl-dock-bridge { display: flex; flex-direction: column; gap: 2px; font-size: 0.82rem; color: var(--text-muted); }
  .pl-bridge-slot { font-size: 0.82rem; }
  .pl-dock-detail { font-size: 0.82rem; color: var(--text-muted); }
  .pl-dock-intents { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .pl-intent-chip {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--bg-secondary);
    font-size: 0.74rem;
  }
  .pl-dock-footer { display: flex; gap: 6px; margin-top: 4px; }

  /* ── Away teams ── */
  .pl-away-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
  }
  .pl-away-card {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .pl-away-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 0.88rem;
    margin-bottom: 6px;
  }
  .pl-away-source { font-size: 0.82rem; }
  .pl-away-officers { display: flex; flex-wrap: wrap; gap: 4px; }
  .pl-away-officer {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg-secondary);
    font-size: 0.78rem;
  }

  /* ── Badges ── */
  .pl-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .pl-badge-variant { background: var(--accent-blue, #48f); color: #000; }

  /* ── Action buttons ── */
  .pl-action {
    padding: 3px 10px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .pl-action:hover { color: var(--accent-gold); border-color: var(--accent-gold-dim); }

  /* ── Overlay ── */
  .pl-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
    display: flex;
    justify-content: center;
    padding-top: 80px;
  }
  .pl-overlay-form {
    background: var(--bg-secondary);
    border: 1px solid var(--accent-gold-dim);
    border-radius: 8px;
    padding: 20px;
    max-width: 560px;
    width: 100%;
    height: fit-content;
  }
  .pl-overlay-form h3 { margin: 0 0 14px; color: var(--accent-gold); }
  .pl-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .pl-btn {
    padding: 7px 18px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.85rem;
    cursor: pointer;
  }

  @media (max-width: 768px) {
    .pl-dock-grid { grid-template-columns: 1fr; }
    .pl-away-list { grid-template-columns: 1fr; }
  }
</style>
