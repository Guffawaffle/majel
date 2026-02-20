<script lang="ts">
  /**
   * DocksTab — Ship dock metadata CRUD.
   * Rendered inside PlanView when the "Docks" tab is active.
   */
  import { upsertCrewDock, deleteCrewDock } from "../../lib/api/crews.js";
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
    if (!formNum || formNum < 1) { formError = "Dock number is required."; return; }

    formError = "";
    try {
      await upsertCrewDock(formNum, {
        label: formLabel.trim() || undefined,
        notes: formNotes.trim() || undefined,
      });
      editingNum = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function handleDelete(dock: Dock) {
    if (!confirm(`Delete Dock ${dock.dockNumber}?`)) return;
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
  .pl-card-name { flex: 1; font-weight: 600; }
  .pl-dock-lock { font-size: 0.88rem; }
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
  .pl-card-notes {
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.82rem;
    margin: 6px 0 0;
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
