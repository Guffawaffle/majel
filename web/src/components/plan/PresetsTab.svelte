<script lang="ts">
  /**
   * PresetsTab — Fleet preset CRUD with activate/re-activate.
   * Rendered inside PlanView when the "Fleet Presets" tab is active.
   */
  import {
    createFleetPreset,
    updateFleetPreset,
    deleteFleetPreset,
    activateFleetPreset,
  } from "../../lib/api/crews.js";
  import type { FleetPresetWithSlots, Loadout } from "../../lib/types.js";

  // ── Props ──

  interface Props {
    fleetPresets: FleetPresetWithSlots[];
    loadouts: Loadout[];
    onRefresh: () => Promise<void>;
  }

  const { fleetPresets, loadouts, onRefresh }: Props = $props();

  // ── State ──

  let editingId = $state<number | "new" | null>(null);
  let formError = $state("");
  let formName = $state("");
  let formNotes = $state("");

  // ── Helpers ──

  function loadoutName(id: number | null | undefined): string {
    if (id == null) return "—";
    return loadouts.find((l) => l.id === id)?.name ?? `Loadout #${id}`;
  }

  // ── Form lifecycle ──

  function startNew() {
    editingId = "new";
    formName = "";
    formNotes = "";
    formError = "";
  }

  function startEdit(preset: FleetPresetWithSlots) {
    editingId = preset.id;
    formName = preset.name;
    formNotes = preset.notes ?? "";
    formError = "";
  }

  function cancel() {
    editingId = null;
    formError = "";
  }

  async function save() {
    if (!formName.trim()) { formError = "Name is required."; return; }

    formError = "";
    try {
      if (editingId === "new") {
        await createFleetPreset(formName.trim(), formNotes.trim());
      } else if (editingId != null) {
        await updateFleetPreset(String(editingId), { name: formName.trim(), notes: formNotes.trim() });
      }
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function handleDelete(preset: FleetPresetWithSlots) {
    const severity = preset.isActive ? "Warning: this preset is currently active." : "";
    if (!confirm(`Delete preset "${preset.name}"?${severity ? "\n\n" + severity : ""}`)) return;
    try {
      await deleteFleetPreset(String(preset.id));
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  async function handleActivate(preset: FleetPresetWithSlots) {
    if (preset.isActive) {
      // Re-activate — warn about manual overrides
      if (!confirm(`Re-activate "${preset.name}"?\n\nThis will clear manual overrides and re-expand preset slots.`)) return;
    }
    try {
      await activateFleetPreset(String(preset.id));
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Activate failed.";
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && tag !== "TEXTAREA") {
      e.preventDefault();
      save();
    }
  }
</script>

<section class="presets">
  <div class="pl-toolbar">
    <h3>Fleet Presets</h3>
    <button class="pl-btn pl-btn-create" onclick={startNew}>+ New Preset</button>
  </div>

  <!-- New form -->
  {#if editingId === "new"}
    {@render presetForm()}
  {/if}

  {#if fleetPresets.length === 0 && editingId !== "new"}
    <p class="pl-empty">No presets yet. Create a preset to save a fleet configuration.</p>
  {:else}
    <div class="pl-list">
      {#each fleetPresets as preset (preset.id)}
        {#if editingId === preset.id}
          {@render presetForm()}
        {:else}
          <div class="pl-card" class:pl-card-active={preset.isActive}>
            <div class="pl-card-header">
              <span class="pl-card-name">{preset.name}</span>
              {#if preset.isActive}
                <span class="pl-badge pl-badge-active">✅ Active</span>
              {/if}
              <div class="pl-card-actions">
                {#if preset.isActive}
                  <button class="pl-action pl-action-warning" onclick={() => handleActivate(preset)}>🔄 Re-activate</button>
                {:else}
                  <button class="pl-action pl-action-primary" onclick={() => handleActivate(preset)}>▶ Activate</button>
                {/if}
                <button class="pl-action" onclick={() => startEdit(preset)} title="Edit">✎</button>
                <button class="pl-action pl-action-danger" onclick={() => handleDelete(preset)} title="Delete">✕</button>
              </div>
            </div>
            <div class="pl-card-body">
              {#if true}
                {@const dockSlots = (preset.slots ?? []).filter((s) => s.dockNumber != null)}
                {@const awaySlots = (preset.slots ?? []).filter((s) => s.awayOfficers != null && s.awayOfficers.length > 0)}
                <span class="pl-detail">Dock Slots: {dockSlots.length}</span>
                {#if awaySlots.length > 0}
                  <span class="pl-detail">Away Teams: {awaySlots.length}</span>
                {/if}
                {#if dockSlots.length > 0}
                  <div class="pl-preset-slots">
                    {#each dockSlots as slot}
                    <span class="pl-slot-chip">
                      Dock {slot.dockNumber}: {slot.variantId ? `Variant` : loadoutName(slot.loadoutId)}
                    </span>
                  {/each}
                </div>
              {/if}
              {#if preset.notes}
                <p class="pl-card-notes">{preset.notes}</p>
              {/if}
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

{#snippet presetForm()}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pl-form" role="form" onkeydown={handleKeydown}>
    <div class="pl-form-grid">
      <label class="pl-field pl-wide">
        <span>Name</span>
        <input type="text" bind:value={formName} maxlength="100" placeholder="e.g. Mining Mode" />
      </label>
      <label class="pl-field pl-wide">
        <span>Notes</span>
        <textarea bind:value={formNotes} maxlength="500" rows="2"></textarea>
      </label>
    </div>
    {#if formError}
      <p class="pl-form-error">{formError}</p>
    {/if}
    <div class="pl-form-actions">
      <button class="pl-btn pl-btn-save" onclick={save}>Save</button>
      <button class="pl-btn pl-btn-cancel" onclick={cancel}>Cancel</button>
    </div>
  </div>
{/snippet}

<style>
  .pl-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .pl-toolbar h3 { flex: 1; margin: 0; font-size: 1.05rem; color: var(--text-primary); }

  .pl-btn {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .pl-btn:hover { background: var(--bg-tertiary); }
  .pl-btn-create { color: var(--accent-gold); border-color: var(--accent-gold-dim); }
  .pl-btn-save { background: var(--accent-gold-dim); color: var(--bg-primary); font-weight: 600; }
  .pl-btn-cancel { opacity: 0.7; }

  .pl-form {
    background: var(--bg-secondary);
    border: 1px solid var(--accent-gold-dim);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .pl-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .pl-wide { grid-column: 1 / -1; }
  .pl-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pl-field span {
    font-size: 0.78rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .pl-field input,
  .pl-field textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.88rem;
  }
  .pl-form-error {
    color: var(--accent-red, #e55);
    font-size: 0.82rem;
    margin: 8px 0 0;
  }
  .pl-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .pl-list { display: flex; flex-direction: column; gap: 8px; }
  .pl-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
  }
  .pl-card-active { border-left: 3px solid var(--accent-green, #5a5); }
  .pl-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pl-card-name { font-weight: 600; flex: 1; }
  .pl-card-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
  .pl-card:hover .pl-card-actions { opacity: 1; }
  .pl-action {
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .pl-action:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .pl-action-primary { color: var(--accent-gold); border-color: var(--accent-gold-dim); }
  .pl-action-warning { color: var(--accent-orange, #f90); border-color: var(--accent-orange, #f90); }
  .pl-action-danger:hover { color: var(--accent-red, #e55); }

  .pl-badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .pl-badge-active { background: var(--accent-green, #5a5); color: #000; }

  .pl-card-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  }
  .pl-detail { font-size: 0.85rem; color: var(--text-muted); }
  .pl-preset-slots {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }
  .pl-slot-chip {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 8px;
    background: var(--bg-tertiary);
    font-size: 0.78rem;
  }
  .pl-card-notes {
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.82rem;
    margin: 4px 0 0;
  }
  .pl-empty {
    text-align: center;
    color: var(--text-muted);
    padding: 24px 0;
    font-size: 0.88rem;
  }

  @media (max-width: 768px) {
    .pl-card-actions { opacity: 1; }
  }
</style>
