<script lang="ts">
  /**
   * DocksTab — Ship dock metadata CRUD.
   * Rendered inside PlanView when the "Docks" tab is active.
   */
  import "../../styles/plan-shared.css";
  import { upsertCrewDock, deleteCrewDock } from "../../lib/api/crews.js";
  import { confirm } from "../../components/ConfirmDialog.svelte";
  import type { Dock } from "../../lib/types.js";

  // ── Props ──

  interface Props {
    docks: Dock[];
    onRefresh: () => Promise<void>;
  }

  const { docks, onRefresh }: Props = $props();

  // ── State ──

  let editingNum = $state<number | "new" | null>(null);
  let formError = $state("");
  let saving = $state(false);

  // Form
  let formNum = $state(1);
  let formLabel = $state("");
  let formUnlocked = $state(true);
  let formNotes = $state("");

  // ── Helpers ──

  function nextDockNumber(): number {
    if (docks.length === 0) return 1;
    return Math.max(...docks.map((d) => d.dockNumber)) + 1;
  }

  const sorted = $derived([...docks].sort((a, b) => a.dockNumber - b.dockNumber));

  // ── Form lifecycle ──

  function startNew() {
    editingNum = "new";
    formNum = nextDockNumber();
    formLabel = "";
    formUnlocked = true;
    formNotes = "";
    formError = "";
  }

  function startEdit(dock: Dock) {
    editingNum = dock.dockNumber;
    formNum = dock.dockNumber;
    formLabel = dock.label ?? "";
    formUnlocked = dock.unlocked ?? true;
    formNotes = dock.notes ?? "";
    formError = "";
  }

  function cancel() {
    editingNum = null;
    formError = "";
  }

  async function save() {
    if (saving) return;
    if (!formNum || formNum < 1) { formError = "Dock number is required."; return; }

    formError = "";
    saving = true;
    try {
      await upsertCrewDock(formNum, {
        label: formLabel.trim() || undefined,
        unlocked: formUnlocked,
        notes: formNotes.trim() || undefined,
      });
      editingNum = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    } finally {
      saving = false;
    }
  }

  async function handleDelete(dock: Dock) {
    if (!(await confirm({ title: `Delete Dock ${dock.dockNumber}?`, severity: "warning", approveLabel: "Delete" }))) return;
    try {
      await deleteCrewDock(dock.dockNumber);
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
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

<section class="docks">
  <div class="pl-toolbar">
    <h3>Ship Docks</h3>
    <button class="pl-btn pl-btn-create" onclick={startNew}>+ New Dock</button>
  </div>

  <!-- New form -->
  {#if editingNum === "new"}
    {@render dockForm(true)}
  {/if}

  {#if sorted.length === 0 && editingNum !== "new"}
    <p class="pl-empty">No docks yet. Create docks to track your fleet slots.</p>
  {:else}
    <div class="pl-list">
      {#each sorted as dock (dock.dockNumber)}
        {#if editingNum === dock.dockNumber}
          {@render dockForm(false)}
        {:else}
          <div class="pl-card">
            <div class="pl-card-header">
              <span class="pl-dock-badge">#{dock.dockNumber}</span>
              <span class="pl-card-name">{dock.label || `Dock ${dock.dockNumber}`}</span>
              <span class="pl-dock-lock">{dock.unlocked ? "🔓" : "🔒"}</span>
              <div class="pl-card-actions">
                <button class="pl-action" onclick={() => startEdit(dock)} title="Edit">✎</button>
                <button class="pl-action pl-action-danger" onclick={() => handleDelete(dock)} title="Delete">✕</button>
              </div>
            </div>
            {#if dock.notes}
              <p class="pl-card-notes">{dock.notes}</p>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

{#snippet dockForm(isNew: boolean)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="pl-form" role="form" onkeydown={handleKeydown}>
    <div class="pl-form-grid">
      <label class="pl-field">
        <span>Dock Number</span>
        <input type="number" bind:value={formNum} min="1" max="99" disabled={!isNew} />
      </label>
      <label class="pl-field">
        <span>Label</span>
        <input type="text" bind:value={formLabel} maxlength="100" placeholder="e.g. Main Warship" />
      </label>
      <label class="pl-field pl-field-checkbox">
        <input type="checkbox" bind:checked={formUnlocked} />
        <span>Unlocked</span>
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
      <button class="pl-btn pl-btn-save" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      <button class="pl-btn pl-btn-cancel" onclick={cancel}>Cancel</button>
    </div>
  </div>
{/snippet}

<style>
  .pl-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
  }
  .pl-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pl-dock-badge {
    font-weight: 700;
    font-size: 0.88rem;
    background: var(--bg-tertiary);
    padding: 2px 8px;
    border-radius: 4px;
  }
  .pl-dock-lock { font-size: 0.88rem; }
  .pl-card-notes {
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.82rem;
    margin: 6px 0 0;
  }
</style>
