<script lang="ts">
  /**
   * PlanItemsTab — Plan item CRUD.
   * Rendered inside PlanView when the "Plan Items" tab is active.
   */
  import {
    createCrewPlanItem,
    updateCrewPlanItem,
    deleteCrewPlanItem,
  } from "../../lib/api/crews.js";
  import type { PlanItemInput } from "../../lib/api/crews.js";
  import type {
    PlanItem,
    Loadout,
    CatalogOfficer,
  } from "../../lib/types.js";
  import { intentLabel } from "../../lib/intent-catalog.js";

  // ── Props ──

  interface Props {
    planItems: PlanItem[];
    loadouts: Loadout[];
    officers: CatalogOfficer[];
    onRefresh: () => Promise<void>;
  }

  const { planItems, loadouts, officers, onRefresh }: Props = $props();

  // ── State ──

  let editingId = $state<number | "new" | null>(null);
  let formError = $state("");

  // Form
  let formLoadoutId = $state("");
  let formDockNumber = $state<string>("");
  let formLabel = $state("");
  let formIntentKey = $state("");
  let formPriority = $state(1);
  let formIsActive = $state(true);
  let formNotes = $state("");

  // ── Helpers ──

  function loadoutName(id: number | null | undefined): string {
    if (id == null) return "—";
    return loadouts.find((l) => l.id === id)?.name ?? `Loadout #${id}`;
  }

  function officerName(id: string): string {
    return officers.find((o) => o.id === id)?.name ?? id;
  }

  const SOURCE_LABELS: Record<string, string> = { manual: "🟡 manual", preset: "🟢 preset" };

  // ── Form lifecycle ──

  function startNew() {
    editingId = "new";
    formLoadoutId = "";
    formDockNumber = "";
    formLabel = "";
    formIntentKey = "";
    formPriority = 1;
    formIsActive = true;
    formNotes = "";
    formError = "";
  }

  function startEdit(item: PlanItem) {
    editingId = item.id;
    formLoadoutId = item.loadoutId != null ? String(item.loadoutId) : "";
    formDockNumber = item.dockNumber != null ? String(item.dockNumber) : "";
    formLabel = item.label ?? "";
    formIntentKey = item.intentKey ?? "";
    formPriority = item.priority ?? 1;
    formIsActive = item.isActive ?? true;
    formNotes = item.notes ?? "";
    formError = "";
  }

  function cancel() {
    editingId = null;
    formError = "";
  }

  async function save() {
    if (!formLoadoutId) { formError = "Select a loadout."; return; }

    const data: PlanItemInput = {
      loadoutId: Number(formLoadoutId),
      dockNumber: formDockNumber ? Number(formDockNumber) : null,
      intentKey: formIntentKey || "",
      priority: formPriority,
      isActive: formIsActive,
      source: "manual",
      notes: formNotes.trim(),
    };

    formError = "";
    try {
      if (editingId === "new") {
        await createCrewPlanItem(data);
      } else if (editingId != null) {
        await updateCrewPlanItem(String(editingId), data);
      }
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function handleDelete(item: PlanItem) {
    const label = item.label || loadoutName(item.loadoutId) || "Plan Item";
    if (!confirm(`Delete plan item "${label}"?`)) return;
    try {
      await deleteCrewPlanItem(String(item.id));
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && tag !== "TEXTAREA" && tag !== "SELECT") {
      e.preventDefault();
      save();
    }
  }
</script>

<section class="plan-items">
  <div class="pl-toolbar">
    <h3>Plan Items</h3>
    <button class="pl-btn pl-btn-create" onclick={startNew}>+ New Item</button>
  </div>

  <!-- New form -->
  {#if editingId === "new"}
    {@render itemForm()}
  {/if}

  {#if planItems.length === 0 && editingId !== "new"}
    <p class="pl-empty">No plan items yet. Create items to define your fleet assignments.</p>
  {:else}
    <div class="pl-list">
      {#each planItems as item (item.id)}
        {#if editingId === item.id}
          {@render itemForm()}
        {:else}
          <div class="pl-card" class:pl-card-inactive={!item.isActive}>
            <div class="pl-card-header">
              <span class="pl-card-name">
                {item.label || loadoutName(item.loadoutId) || "Plan Item"}
              </span>
              {#if item.source}
                <span class="pl-badge pl-badge-source">{SOURCE_LABELS[item.source] ?? item.source}</span>
              {/if}
              {#if !item.isActive}
                <span class="pl-badge pl-badge-inactive">Inactive</span>
              {/if}
              {#if item.dockNumber != null}
                <span class="pl-badge">Dock {item.dockNumber}</span>
              {/if}
              {#if (item.priority ?? 1) > 1}
                <span class="pl-badge pl-badge-priority">P{item.priority}</span>
              {/if}
              <div class="pl-card-actions">
                <button class="pl-action" onclick={() => startEdit(item)} title="Edit">✎</button>
                <button class="pl-action pl-action-danger" onclick={() => handleDelete(item)} title="Delete">✕</button>
              </div>
            </div>
            <div class="pl-card-body">
              <div class="pl-row"><span class="pl-row-label">Loadout</span><span>{loadoutName(item.loadoutId)}</span></div>
              {#if item.intentKey}
                <div class="pl-row"><span class="pl-row-label">Intent</span><span>{intentLabel(item.intentKey)}</span></div>
              {/if}
              {#if item.notes}
                <p class="pl-card-notes">{item.notes}</p>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

{#snippet itemForm()}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pl-form" role="form" onkeydown={handleKeydown}>
    <div class="pl-form-grid">
      <label class="pl-field">
        <span>Loadout</span>
        <select bind:value={formLoadoutId}>
          <option value="">— Select loadout —</option>
          {#each loadouts as lo}
            <option value={String(lo.id)}>{lo.name}</option>
          {/each}
        </select>
      </label>
      <label class="pl-field">
        <span>Dock Number</span>
        <input type="number" bind:value={formDockNumber} min="1" max="50" placeholder="Optional" />
      </label>
      <label class="pl-field">
        <span>Label</span>
        <input type="text" bind:value={formLabel} maxlength="100" placeholder="e.g. Mining Dock" />
      </label>
      <label class="pl-field">
        <span>Intent Key</span>
        <input type="text" bind:value={formIntentKey} maxlength="50" placeholder="e.g. mining-gas" />
      </label>
      <label class="pl-field">
        <span>Priority</span>
        <input type="number" bind:value={formPriority} min="1" max="100" />
      </label>
      <label class="pl-field pl-field-checkbox">
        <input type="checkbox" bind:checked={formIsActive} />
        <span>Active</span>
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
  .pl-field input[type="text"],
  .pl-field input[type="number"],
  .pl-field select,
  .pl-field textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.88rem;
  }
  .pl-field-checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .pl-field-checkbox input { width: auto; }
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
  .pl-card-inactive { opacity: 0.6; }
  .pl-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
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
  .pl-action-danger:hover { color: var(--accent-red, #e55); }

  .pl-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    background: rgba(255, 255, 255, 0.06);
  }
  .pl-badge-source { font-weight: 400; text-transform: none; }
  .pl-badge-inactive { background: var(--bg-tertiary); color: var(--text-muted); }
  .pl-badge-priority { background: var(--accent-orange, #f90); color: #000; }

  .pl-card-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  }
  .pl-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.88rem;
  }
  .pl-row-label {
    font-size: 0.78rem;
    text-transform: uppercase;
    color: var(--text-muted);
    min-width: 70px;
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
    .pl-form-grid { grid-template-columns: 1fr; }
    .pl-card-actions { opacity: 1; }
  }
</style>
