<script lang="ts">
  /**
   * CoresTab — Bridge Core CRUD with 3-slot officer pickers.
   * Rendered inside WorkshopView when the "Cores" tab is active.
   */
  import "../../styles/workshop-shared.css";
  import {
    createBridgeCore,
    updateBridgeCore,
    deleteBridgeCore,
    setBridgeCoreMembers,
  } from "../../lib/api/crews.js";
  import { confirm } from "../../components/ConfirmDialog.svelte";
  import type {
    BridgeCoreWithMembers,
    Loadout,
    CatalogOfficer,
    BridgeSlot,
  } from "../../lib/types.js";
  import type { BridgeCoreMemberInput } from "../../lib/api/crews.js";

  // ── Props ──

  interface Props {
    bridgeCores: BridgeCoreWithMembers[];
    loadouts: Loadout[];
    officers: CatalogOfficer[];
    onRefresh: () => Promise<void>;
  }

  const { bridgeCores, loadouts, officers, onRefresh }: Props = $props();

  // ── Constants ──

  const SLOT_NAMES: Record<BridgeSlot, string> = {
    captain: "Captain",
    bridge_1: "Bridge 1",
    bridge_2: "Bridge 2",
  };
  const SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

  // ── State ──

  let editingId = $state<number | "new" | null>(null);
  let formError = $state("");
  let saving = $state(false);

  // Form fields
  let formName = $state("");
  let formNotes = $state("");
  let formSlots = $state<Record<BridgeSlot, string>>({ captain: "", bridge_1: "", bridge_2: "" });

  // ── Helpers ──

  function officerById(id: string): CatalogOfficer | undefined {
    return officers.find((o) => o.id === id);
  }

  function officerLabel(off: CatalogOfficer): string {
    return `${off.name} (L${off.userLevel ?? "?"})`;
  }

  function coreUsedIn(coreId: number): Loadout[] {
    return loadouts.filter((l) => l.bridgeCoreId === coreId);
  }

  // ── Form lifecycle ──

  function startNew() {
    editingId = "new";
    formName = "";
    formNotes = "";
    formSlots = { captain: "", bridge_1: "", bridge_2: "" };
    formError = "";
  }

  function startEdit(core: BridgeCoreWithMembers) {
    editingId = core.id;
    formName = core.name;
    formNotes = core.notes ?? "";
    const slots: Record<BridgeSlot, string> = { captain: "", bridge_1: "", bridge_2: "" };
    for (const m of core.members ?? []) {
      if (m.slot in slots) slots[m.slot as BridgeSlot] = m.officerId;
    }
    formSlots = slots;
    formError = "";
  }

  function cancel() {
    editingId = null;
    formError = "";
  }

  async function save() {
    if (saving) return;
    if (!formName.trim()) { formError = "Name is required."; return; }
    const members: BridgeCoreMemberInput[] = SLOTS
      .filter((s) => formSlots[s])
      .map((s) => ({ officerId: formSlots[s], slot: s }));
    if (members.length === 0) { formError = "Assign at least one officer."; return; }

    formError = "";
    saving = true;
    try {
      if (editingId === "new") {
        await createBridgeCore(formName.trim(), members, formNotes.trim());
      } else if (editingId != null) {
        await updateBridgeCore(String(editingId), { name: formName.trim(), notes: formNotes.trim() });
        await setBridgeCoreMembers(String(editingId), members);
      }
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    } finally {
      saving = false;
    }
  }

  async function handleDelete(core: BridgeCoreWithMembers) {
    if (saving) return;
    const usedIn = coreUsedIn(core.id);
    const extra = usedIn.length
      ? `\n\nWarning: used by loadouts: ${usedIn.map((l) => l.name).join(", ")}`
      : "";
    if (!(await confirm({ title: `Delete bridge core "${core.name}"?`, subtitle: extra || undefined, severity: "warning", approveLabel: "Delete" }))) return;
    try {
      await deleteBridgeCore(String(core.id));
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA"
        && (e.target as HTMLElement).tagName !== "SELECT") {
      e.preventDefault();
      save();
    }
  }
</script>

<section class="cores">
  <!-- Toolbar -->
  <div class="ws-toolbar">
    <h3>Bridge Cores</h3>
    <button class="ws-btn ws-btn-create" onclick={startNew}>+ New Core</button>
  </div>

  <!-- New form -->
  {#if editingId === "new"}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="ws-form" role="form" onkeydown={handleKeydown}>
      <div class="ws-form-grid">
        <label class="ws-field">
          <span>Name</span>
          <input type="text" bind:value={formName} maxlength="100" placeholder="e.g. Kirk Trio" />
        </label>
        {#each SLOTS as slot}
          <label class="ws-field">
            <span>{SLOT_NAMES[slot]}</span>
            <select bind:value={formSlots[slot]}>
              <option value="">— Select officer —</option>
              {#each officers as off}
                <option value={off.id}>{officerLabel(off)}</option>
              {/each}
            </select>
          </label>
        {/each}
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
  {/if}

  <!-- Core cards -->
  {#if bridgeCores.length === 0}
    <p class="ws-empty">No bridge cores yet. Create one to group 3 officers.</p>
  {:else}
    <div class="ws-list">
      {#each bridgeCores as core (core.id)}
        {#if editingId === core.id}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div class="ws-form" role="form" onkeydown={handleKeydown}>
            <div class="ws-form-grid">
              <label class="ws-field">
                <span>Name</span>
                <input type="text" bind:value={formName} maxlength="100" />
              </label>
              {#each SLOTS as slot}
                <label class="ws-field">
                  <span>{SLOT_NAMES[slot]}</span>
                  <select bind:value={formSlots[slot]}>
                    <option value="">— Select officer —</option>
                    {#each officers as off}
                      <option value={off.id}>{officerLabel(off)}</option>
                    {/each}
                  </select>
                </label>
              {/each}
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
        {:else}
          <div class="ws-card">
            <div class="ws-card-header">
              <span class="ws-card-name">{core.name}</span>
              <span class="ws-card-count">{(core.members ?? []).length}/3 slots</span>
              <div class="ws-card-actions">
                <button class="ws-action" onclick={() => startEdit(core)} title="Edit">✎</button>
                <button class="ws-action ws-action-danger" disabled={saving} onclick={() => handleDelete(core)} title="Delete">✕</button>
              </div>
            </div>
            <div class="ws-card-body">
              {#each SLOTS.filter((s) => (core.members ?? []).find((m) => m.slot === s)) as slot}
                {@const member = (core.members ?? []).find((m) => m.slot === slot)}
                {@const off = member ? officerById(member.officerId) : undefined}
                <div class="ws-slot">
                  <span class="ws-slot-label">{SLOT_NAMES[slot]}</span>
                  <span class="ws-slot-value">{off ? officerLabel(off) : member?.officerId ?? "—"}</span>
                </div>
              {/each}
              {#if coreUsedIn(core.id).length > 0}
                <div class="ws-xref">
                  <span class="ws-xref-label">Used in:</span>
                  {#each coreUsedIn(core.id) as lo}
                    <span class="ws-chip">{lo.name}</span>
                  {/each}
                </div>
              {/if}
              {#if core.notes}
                <p class="ws-card-notes">{core.notes}</p>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  /* ── Card details (file-specific) ── */
  .ws-card-count { font-size: 0.78rem; color: var(--text-muted); }

  .ws-slot {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .ws-slot-label {
    font-size: 0.78rem;
    text-transform: uppercase;
    color: var(--text-muted);
    min-width: 72px;
  }
  .ws-slot-value { font-size: 0.88rem; }
</style>
