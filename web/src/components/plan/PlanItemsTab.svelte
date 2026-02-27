<script lang="ts">
  /**
   * PlanItemsTab — Plan item CRUD.
   * Rendered inside PlanView when the "Plan Items" tab is active.
   */
  import "../../styles/plan-shared.css";
  import {
    createCrewPlanItem,
    updateCrewPlanItem,
    deleteCrewPlanItem,
  } from "../../lib/api/crews.js";
  import type { PlanItemInput } from "../../lib/api/crews.js";
  import { confirm } from "../../components/ConfirmDialog.svelte";
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
  let saving = $state(false);

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
    if (saving) return;
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
    saving = true;
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
    } finally {
      saving = false;
    }
  }

  async function handleDelete(item: PlanItem) {
    if (saving) return;
    const label = item.label || loadoutName(item.loadoutId) || "Plan Item";
    if (!(await confirm({ title: `Delete plan item "${label}"?`, severity: "warning", approveLabel: "Delete" }))) return;
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
                <button class="pl-action pl-action-danger" disabled={saving} onclick={() => handleDelete(item)} title="Delete">✕</button>
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
      <button class="pl-btn pl-btn-save" disabled={saving} onclick={save}>Save</button>
      <button class="pl-btn pl-btn-cancel" onclick={cancel}>Cancel</button>
    </div>
  </div>
{/snippet}

<style>
  .pl-card-inactive { opacity: 0.6; }

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
</style>
