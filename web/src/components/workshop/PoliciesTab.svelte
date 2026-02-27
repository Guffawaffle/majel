<script lang="ts">
  /**
   * PoliciesTab — Below Deck Policy CRUD with mode/spec builder.
   * Rendered inside WorkshopView when the "Policies" tab is active.
   */
  import "../../styles/workshop-shared.css";
  import {
    createBelowDeckPolicy,
    updateBelowDeckPolicy,
    deleteBelowDeckPolicy,
  } from "../../lib/api/crews.js";
  import { confirm } from "../../components/ConfirmDialog.svelte";
  import type {
    BelowDeckPolicy,
    BelowDeckMode,
    Loadout,
    CatalogOfficer,
  } from "../../lib/types.js";

  // ── Props ──

  interface Props {
    belowDeckPolicies: BelowDeckPolicy[];
    loadouts: Loadout[];
    officers: CatalogOfficer[];
    onRefresh: () => Promise<void>;
  }

  const { belowDeckPolicies, loadouts, officers, onRefresh }: Props = $props();

  // ── Constants ──

  const MODE_LABELS: Record<BelowDeckMode, string> = {
    stats_then_bda: "Stats → BDA",
    pinned_only: "Pinned Only",
    stat_fill_only: "Stats Fill Only",
  };
  const MODES: BelowDeckMode[] = ["stats_then_bda", "pinned_only", "stat_fill_only"];

  // ── State ──

  let editingId = $state<number | "new" | null>(null);
  let formError = $state("");
  let saving = $state(false);

  // Form fields
  let formName = $state("");
  let formMode = $state<BelowDeckMode>("stats_then_bda");
  let formPinned = $state<string[]>([]);
  let formMaxSlots = $state<string>("");
  let formAvoidReserved = $state(false);
  let formNotes = $state("");

  // ── Helpers ──

  function officerLabel(off: CatalogOfficer): string {
    return `${off.name} (L${off.userLevel ?? "?"})`;
  }

  function officerName(id: string): string {
    const off = officers.find((o) => o.id === id);
    return off ? off.name : id;
  }

  function policyUsedIn(policyId: number): Loadout[] {
    return loadouts.filter((l) => l.belowDeckPolicyId === policyId);
  }

  // ── Form lifecycle ──

  function startNew() {
    editingId = "new";
    formName = "";
    formMode = "stats_then_bda";
    formPinned = [];
    formMaxSlots = "";
    formAvoidReserved = false;
    formNotes = "";
    formError = "";
  }

  function startEdit(policy: BelowDeckPolicy) {
    editingId = policy.id;
    formName = policy.name;
    formMode = policy.mode;
    formPinned = policy.spec?.pinned ?? [];
    formMaxSlots = policy.spec?.max_slots != null ? String(policy.spec.max_slots) : "";
    formAvoidReserved = policy.spec?.avoid_reserved ?? false;
    formNotes = policy.notes ?? "";
    formError = "";
  }

  function cancel() {
    editingId = null;
    formError = "";
  }

  async function save() {
    if (saving) return;
    if (!formName.trim()) { formError = "Name is required."; return; }

    const spec: BelowDeckPolicy["spec"] = {
      pinned: formPinned.length > 0 ? formPinned : undefined,
      max_slots: formMaxSlots ? Number(formMaxSlots) : undefined,
      avoid_reserved: formAvoidReserved,
    };

    formError = "";
    saving = true;
    try {
      if (editingId === "new") {
        await createBelowDeckPolicy(formName.trim(), formMode, spec, formNotes.trim());
      } else if (editingId != null) {
        await updateBelowDeckPolicy(String(editingId), {
          name: formName.trim(),
          mode: formMode,
          spec,
          notes: formNotes.trim(),
        });
      }
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    } finally {
      saving = false;
    }
  }

  async function handleDelete(policy: BelowDeckPolicy) {
    if (saving) return;
    const usedIn = policyUsedIn(policy.id);
    const extra = usedIn.length
      ? `\n\nWarning: used by loadouts: ${usedIn.map((l) => l.name).join(", ")}`
      : "";
    if (!(await confirm({ title: `Delete policy "${policy.name}"?`, subtitle: extra || undefined, severity: "warning", approveLabel: "Delete" }))) return;
    try {
      await deleteBelowDeckPolicy(String(policy.id));
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  function handlePinnedChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    formPinned = Array.from(select.selectedOptions).map((o) => o.value);
  }

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && tag !== "TEXTAREA" && tag !== "SELECT") {
      e.preventDefault();
      save();
    }
  }
</script>

<section class="policies">
  <!-- Toolbar -->
  <div class="ws-toolbar">
    <h3>Below Deck Policies</h3>
    <button class="ws-btn ws-btn-create" onclick={startNew}>+ New Policy</button>
  </div>

  <!-- New form -->
  {#if editingId === "new"}
    {@render policyForm()}
  {/if}

  <!-- Policy cards -->
  {#if belowDeckPolicies.length === 0}
    <p class="ws-empty">No policies yet. Create one to define below-deck officer assignment rules.</p>
  {:else}
    <div class="ws-list">
      {#each belowDeckPolicies as policy (policy.id)}
        {#if editingId === policy.id}
          {@render policyForm()}
        {:else}
          <div class="ws-card">
            <div class="ws-card-header">
              <span class="ws-card-name">{policy.name}</span>
              <span class="ws-badge ws-badge-mode">{MODE_LABELS[policy.mode] ?? policy.mode}</span>
              <div class="ws-card-actions">
                <button class="ws-action" onclick={() => startEdit(policy)} title="Edit">✎</button>
                <button class="ws-action ws-action-danger" disabled={saving} onclick={() => handleDelete(policy)} title="Delete">✕</button>
              </div>
            </div>
            <div class="ws-card-body">
              <div class="ws-row"><span class="ws-row-label">Mode</span><span>{MODE_LABELS[policy.mode] ?? policy.mode}</span></div>
              {#if policy.spec?.pinned?.length}
                <div class="ws-row">
                  <span class="ws-row-label">Pinned ({policy.spec.pinned.length})</span>
                  <span>{policy.spec.pinned.map(officerName).join(", ")}</span>
                </div>
              {/if}
              {#if policy.spec?.max_slots != null}
                <div class="ws-row"><span class="ws-row-label">Max Slots</span><span>{policy.spec.max_slots}</span></div>
              {/if}
              {#if policy.spec?.avoid_reserved}
                <div class="ws-row"><span class="ws-row-label">Avoid Reserved</span><span>Yes</span></div>
              {/if}
              {#if policyUsedIn(policy.id).length > 0}
                <div class="ws-xref">
                  <span class="ws-xref-label">Used in:</span>
                  {#each policyUsedIn(policy.id) as lo}
                    <span class="ws-chip">{lo.name}</span>
                  {/each}
                </div>
              {/if}
              {#if policy.notes}
                <p class="ws-card-notes">{policy.notes}</p>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

{#snippet policyForm()}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="ws-form" role="form" onkeydown={handleKeydown}>
    <div class="ws-form-grid">
      <label class="ws-field">
        <span>Name</span>
        <input type="text" bind:value={formName} maxlength="100" placeholder="e.g. Combat BD" />
      </label>
      <label class="ws-field">
        <span>Mode</span>
        <select bind:value={formMode}>
          {#each MODES as mode}
            <option value={mode}>{MODE_LABELS[mode]}</option>
          {/each}
        </select>
      </label>
      <label class="ws-field ws-wide">
        <span>Pinned Officers (hold Ctrl/Cmd to multi-select)</span>
        <select multiple size="5" onchange={handlePinnedChange}>
          {#each officers as off}
            <option value={off.id} selected={formPinned.includes(off.id)}>
              {officerLabel(off)}
            </option>
          {/each}
        </select>
      </label>
      <label class="ws-field">
        <span>Max Slots</span>
        <input type="number" bind:value={formMaxSlots} min="1" max="20" placeholder="No limit" />
      </label>
      <label class="ws-field ws-field-checkbox">
        <input type="checkbox" bind:checked={formAvoidReserved} />
        <span>Avoid reserved officers</span>
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
      <button class="ws-btn ws-btn-save" disabled={saving} onclick={save}>Save</button>
      <button class="ws-btn ws-btn-cancel" onclick={cancel}>Cancel</button>
    </div>
  </div>
{/snippet}

<style>
  /* ── Badges (file-specific) ── */
  .ws-badge-mode { background: var(--accent-blue, #48f); color: #000; }

  /* ── Card body (file-specific) ── */
  .ws-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.88rem;
  }
  .ws-row-label {
    font-size: 0.78rem;
    text-transform: uppercase;
    color: var(--text-muted);
    min-width: 100px;
  }
</style>
