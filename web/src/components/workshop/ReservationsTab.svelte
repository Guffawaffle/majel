<script lang="ts">
  /**
   * ReservationsTab — Officer reservation ledger with inline toggle.
   * Rendered inside WorkshopView when the "Reservations" tab is active.
   */
  import "../../styles/workshop-shared.css";
  import {
    setReservation,
    deleteReservation,
  } from "../../lib/api/crews.js";
  import { confirm } from "../../components/ConfirmDialog.svelte";
  import type {
    OfficerReservation,
    CatalogOfficer,
  } from "../../lib/types.js";

  // ── Props ──

  interface Props {
    reservations: OfficerReservation[];
    officers: CatalogOfficer[];
    onRefresh: () => Promise<void>;
  }

  const { reservations, officers, onRefresh }: Props = $props();

  // ── State ──

  let editingId = $state<string | "new" | null>(null);
  let formError = $state("");

  // Form fields
  let formOfficerId = $state("");
  let formReservedFor = $state("");
  let formLocked = $state(false);
  let formNotes = $state("");

  // ── Helpers ──

  function officerLabel(off: CatalogOfficer): string {
    return `${off.name} (L${off.userLevel ?? "?"})`;
  }

  function officerName(id: string): string {
    const off = officers.find((o) => o.id === id);
    return off?.name ?? id;
  }

  /** Officers not already reserved (for "new" dropdown). */
  const availableOfficers = $derived.by(() => {
    const reserved = new Set(reservations.map((r) => r.officerId));
    return officers.filter((o) => !reserved.has(o.id));
  });

  // ── Form lifecycle ──

  function startNew() {
    editingId = "new";
    formOfficerId = "";
    formReservedFor = "";
    formLocked = false;
    formNotes = "";
    formError = "";
  }

  function startEdit(res: OfficerReservation) {
    editingId = res.officerId;
    formOfficerId = res.officerId;
    formReservedFor = res.reservedFor;
    formLocked = res.locked;
    formNotes = res.notes ?? "";
    formError = "";
  }

  function cancel() {
    editingId = null;
    formError = "";
  }

  async function save() {
    if (editingId === "new" && !formOfficerId) { formError = "Select an officer."; return; }
    if (!formReservedFor.trim()) { formError = "Reserved For is required."; return; }

    formError = "";
    try {
      await setReservation(formOfficerId, formReservedFor.trim(), formLocked, formNotes.trim());
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function toggleLock(res: OfficerReservation) {
    try {
      await setReservation(res.officerId, res.reservedFor, !res.locked, res.notes ?? "");
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Toggle lock failed.";
    }
  }

  async function handleDelete(res: OfficerReservation) {
    if (!(await confirm({ title: `Remove reservation for ${officerName(res.officerId)}?` }))) return;
    try {
      await deleteReservation(res.officerId);
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

<section class="reservations">
  <!-- Toolbar -->
  <div class="ws-toolbar">
    <h3>Officer Reservations</h3>
    <button class="ws-btn ws-btn-create" onclick={startNew}>+ Reserve Officer</button>
  </div>

  {#if formError && editingId == null}
    <p class="ws-form-error">{formError}</p>
  {/if}

  <!-- New form -->
  {#if editingId === "new"}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="ws-form" role="form" onkeydown={handleKeydown}>
      <div class="ws-form-grid">
        <label class="ws-field">
          <span>Officer</span>
          <select bind:value={formOfficerId}>
            <option value="">— Select officer —</option>
            {#each availableOfficers as off}
              <option value={off.id}>{officerLabel(off)}</option>
            {/each}
          </select>
        </label>
        <label class="ws-field">
          <span>Reserved For</span>
          <input type="text" bind:value={formReservedFor} maxlength="100" placeholder="e.g. Swarm Grinding, PvP" />
        </label>
        <label class="ws-field ws-field-checkbox">
          <input type="checkbox" bind:checked={formLocked} />
          <span>Hard lock (🔒 prevent all reassignment)</span>
        </label>
        <label class="ws-field ws-wide">
          <span>Notes</span>
          <textarea bind:value={formNotes} maxlength="500" rows="2"></textarea>
        </label>
      </div>
      {#if formError}
        <p class="ws-form-error">{formError}</p>
      {/if}
      <div class="ws-form-actions">
        <button class="ws-btn ws-btn-save" onclick={save}>Save</button>
        <button class="ws-btn ws-btn-cancel" onclick={cancel}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Reservation rows -->
  {#if reservations.length === 0 && editingId !== "new"}
    <p class="ws-empty">No reservations yet. Reserve officers to protect them from reassignment.</p>
  {:else}
    <div class="ws-list">
      {#each reservations as res (res.officerId)}
        {#if editingId === res.officerId}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div class="ws-form" role="form" onkeydown={handleKeydown}>
            <div class="ws-form-grid">
              <div class="ws-field">
                <span>Officer</span>
                <span class="ws-form-static">{officerName(res.officerId)}</span>
              </div>
              <label class="ws-field">
                <span>Reserved For</span>
                <input type="text" bind:value={formReservedFor} maxlength="100" />
              </label>
              <label class="ws-field ws-field-checkbox">
                <input type="checkbox" bind:checked={formLocked} />
                <span>Hard lock (🔒)</span>
              </label>
              <label class="ws-field ws-wide">
                <span>Notes</span>
                <textarea bind:value={formNotes} maxlength="500" rows="2"></textarea>
              </label>
            </div>
            {#if formError}
              <p class="ws-form-error">{formError}</p>
            {/if}
            <div class="ws-form-actions">
              <button class="ws-btn ws-btn-save" onclick={save}>Save</button>
              <button class="ws-btn ws-btn-cancel" onclick={cancel}>Cancel</button>
            </div>
          </div>
        {:else}
          <div class="res-row">
            <div class="res-info">
              <span class="res-name">{officerName(res.officerId)}</span>
              <span class="res-for">{res.reservedFor}</span>
              <span class="res-lock">{res.locked ? "🔒" : "🔓"}</span>
              {#if res.notes}
                <span class="res-notes">{res.notes}</span>
              {/if}
            </div>
            <div class="res-actions">
              <button class="ws-action" onclick={() => toggleLock(res)} title={res.locked ? "Unlock" : "Lock"}>
                {res.locked ? "🔓 Unlock" : "🔒 Lock"}
              </button>
              <button class="ws-action" onclick={() => startEdit(res)} title="Edit">✎</button>
              <button class="ws-action ws-action-danger" onclick={() => handleDelete(res)} title="Delete">✕</button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  /* ── Form (file-specific) ── */
  .ws-form-static {
    font-size: 0.88rem;
    color: var(--text-primary);
    padding: 6px 0;
  }

  /* ── List (file-specific gap) ── */
  .ws-list { display: flex; flex-direction: column; gap: 6px; }

  /* ── Reservation rows ── */
  .res-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
  }
  .res-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .res-name { font-weight: 600; }
  .res-for {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg-tertiary);
    font-size: 0.82rem;
  }
  .res-lock { font-size: 0.88rem; }
  .res-notes {
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.82rem;
  }
  .res-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .res-row:hover .res-actions { opacity: 1; }

  @media (max-width: 768px) {
    .res-row { flex-direction: column; align-items: flex-start; gap: 8px; }
    .res-actions { opacity: 1; }
  }
</style>
