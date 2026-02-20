<script lang="ts">
  /**
   * LoadoutsTab — Loadout CRUD with search/filter/sort toolbar,
   * intent checkbox grid, and expandable variant sections.
   * Most complex tab in the Workshop.
   */
  import {
    createCrewLoadout,
    updateCrewLoadout,
    deleteCrewLoadout,
    fetchVariants,
    createVariant,
    updateVariant,
    deleteVariant,
  } from "../../lib/api/crews.js";
  import type { LoadoutInput } from "../../lib/api/crews.js";
  import type {
    Loadout,
    BridgeCoreWithMembers,
    BelowDeckPolicy,
    CatalogOfficer,
    CatalogShip,
    LoadoutVariant,
    VariantPatch,
    BridgeSlot,
  } from "../../lib/types.js";
  import { INTENT_CATALOG, INTENT_CATEGORIES, intentLabel } from "../../lib/intent-catalog.js";

  // ── Props ──

  interface Props {
    loadouts: Loadout[];
    bridgeCores: BridgeCoreWithMembers[];
    belowDeckPolicies: BelowDeckPolicy[];
    officers: CatalogOfficer[];
    ships: CatalogShip[];
    onRefresh: () => Promise<void>;
  }

  const { loadouts, bridgeCores, belowDeckPolicies, officers, ships, onRefresh }: Props = $props();

  // ── Constants ──

  const SLOT_NAMES: Record<BridgeSlot, string> = {
    captain: "Captain",
    bridge_1: "Bridge 1",
    bridge_2: "Bridge 2",
  };
  const SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

  // ── Loadout state ──

  let editingId = $state<number | "new" | null>(null);
  let formError = $state("");
  let searchQuery = $state("");
  let filterIntent = $state("");
  let filterActive = $state<"" | "true" | "false">("");
  let sortField = $state<"name" | "ship" | "priority">("name");
  let sortDir = $state<"asc" | "desc">("asc");

  // Form
  let formName = $state("");
  let formShipId = $state("");
  let formCoreId = $state("");
  let formPolicyId = $state("");
  let formPriority = $state(0);
  let formIsActive = $state(false);
  let formIntents = $state<Set<string>>(new Set());
  let formTags = $state("");
  let formNotes = $state("");

  // Variants
  let expandedId = $state<number | null>(null);
  let variantCache = $state<Record<number, LoadoutVariant[]>>({});
  let editingVariantId = $state<number | "new" | null>(null);
  let variantFormError = $state("");
  let vFormName = $state("");
  let vFormNotes = $state("");
  let vFormSlots = $state<Record<BridgeSlot, string>>({ captain: "", bridge_1: "", bridge_2: "" });
  let vFormPolicyId = $state("");

  // ── Helpers ──

  function shipName(id: string | null | undefined): string {
    if (!id) return "—";
    return ships.find((s) => s.id === id)?.name ?? "—";
  }

  function coreName(id: number | null | undefined): string {
    if (id == null) return "—";
    return bridgeCores.find((c) => c.id === id)?.name ?? "—";
  }

  function policyName(id: number | null | undefined): string {
    if (id == null) return "—";
    return belowDeckPolicies.find((p) => p.id === id)?.name ?? "—";
  }

  function officerName(id: string): string {
    const off = officers.find((o) => o.id === id);
    return off ? `${off.name} (L${off.userLevel ?? "?"})` : id;
  }

  // ── Derived: filtered & sorted ──

  const filtered = $derived.by(() => {
    let list = loadouts;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (l) => l.name.toLowerCase().includes(q) || shipName(l.shipId).toLowerCase().includes(q),
      );
    }
    if (filterIntent) {
      list = list.filter((l) => l.intentKeys?.includes(filterIntent));
    }
    if (filterActive === "true") list = list.filter((l) => l.isActive);
    if (filterActive === "false") list = list.filter((l) => !l.isActive);

    // Sort
    const dir = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sortField === "name") return a.name.localeCompare(b.name) * dir;
      if (sortField === "ship") return shipName(a.shipId).localeCompare(shipName(b.shipId)) * dir;
      return ((a.priority ?? 0) - (b.priority ?? 0)) * dir;
    });
    return list;
  });

  // Stats
  const totalCount = $derived(loadouts.length);
  const activeCount = $derived(loadouts.filter((l) => l.isActive).length);
  const uniqueShips = $derived(new Set(loadouts.map((l) => l.shipId).filter(Boolean)).size);

  // Unique intents used across all loadouts (for filter dropdown)
  const usedIntents = $derived.by(() => {
    const keys = new Set<string>();
    for (const l of loadouts)
      for (const k of l.intentKeys ?? []) keys.add(k);
    return Array.from(keys).sort();
  });

  // ── Loadout form lifecycle ──

  function startNew() {
    editingId = "new";
    formName = "";
    formShipId = "";
    formCoreId = "";
    formPolicyId = "";
    formPriority = 0;
    formIsActive = false;
    formIntents = new Set();
    formTags = "";
    formNotes = "";
    formError = "";
    collapseVariants();
  }

  function startEdit(lo: Loadout) {
    editingId = lo.id;
    formName = lo.name;
    formShipId = lo.shipId ?? "";
    formCoreId = lo.bridgeCoreId != null ? String(lo.bridgeCoreId) : "";
    formPolicyId = lo.belowDeckPolicyId != null ? String(lo.belowDeckPolicyId) : "";
    formPriority = lo.priority ?? 0;
    formIsActive = lo.isActive ?? false;
    formIntents = new Set(lo.intentKeys ?? []);
    formTags = (lo.tags ?? []).join(", ");
    formNotes = lo.notes ?? "";
    formError = "";
    collapseVariants();
  }

  function cancelEdit() {
    editingId = null;
    formError = "";
  }

  async function saveLoadout() {
    if (!formName.trim()) { formError = "Name is required."; return; }

    const data: LoadoutInput = {
      name: formName.trim(),
      shipId: formShipId || "",
      bridgeCoreId: formCoreId ? Number(formCoreId) : null,
      belowDeckPolicyId: formPolicyId ? Number(formPolicyId) : null,
      priority: formPriority,
      isActive: formIsActive,
      intentKeys: Array.from(formIntents),
      tags: formTags.split(",").map((t) => t.trim()).filter(Boolean),
      notes: formNotes.trim(),
    };

    formError = "";
    try {
      if (editingId === "new") {
        await createCrewLoadout(data);
      } else if (editingId != null) {
        await updateCrewLoadout(String(editingId), data);
      }
      editingId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function handleDelete(lo: Loadout) {
    if (!confirm(`Delete loadout "${lo.name}"?\n\nThis will also delete all variants.`)) return;
    try {
      await deleteCrewLoadout(String(lo.id));
      delete variantCache[lo.id];
      if (expandedId === lo.id) expandedId = null;
      await onRefresh();
    } catch (err: unknown) {
      formError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  function toggleIntent(key: string) {
    const next = new Set(formIntents);
    if (next.has(key)) next.delete(key); else next.add(key);
    formIntents = next;
  }

  function handleKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && tag !== "TEXTAREA" && tag !== "SELECT") {
      e.preventDefault();
      saveLoadout();
    }
  }

  // ── Variant helpers ──

  async function toggleVariants(loadoutId: number) {
    if (expandedId === loadoutId) {
      collapseVariants();
      return;
    }
    expandedId = loadoutId;
    editingVariantId = null;
    variantFormError = "";
    if (!variantCache[loadoutId]) {
      variantCache[loadoutId] = await fetchVariants(String(loadoutId));
    }
  }

  function collapseVariants() {
    expandedId = null;
    editingVariantId = null;
    variantFormError = "";
  }

  function startNewVariant() {
    editingVariantId = "new";
    vFormName = "";
    vFormNotes = "";
    vFormSlots = { captain: "", bridge_1: "", bridge_2: "" };
    vFormPolicyId = "";
    variantFormError = "";
  }

  function startEditVariant(v: LoadoutVariant) {
    editingVariantId = v.id;
    vFormName = v.name;
    vFormNotes = v.notes ?? "";
    const bridge = v.patch?.bridge ?? {};
    vFormSlots = {
      captain: bridge.captain ?? "",
      bridge_1: bridge.bridge_1 ?? "",
      bridge_2: bridge.bridge_2 ?? "",
    };
    vFormPolicyId = v.patch?.below_deck_policy_id != null ? String(v.patch.below_deck_policy_id) : "";
    variantFormError = "";
  }

  function cancelVariant() {
    editingVariantId = null;
    variantFormError = "";
  }

  async function saveVariant() {
    if (!vFormName.trim()) { variantFormError = "Name is required."; return; }
    if (expandedId == null) return;

    const bridge: Record<string, string> = {};
    for (const s of SLOTS) if (vFormSlots[s]) bridge[s] = vFormSlots[s];
    const patch: VariantPatch = { bridge };
    if (vFormPolicyId) patch.below_deck_policy_id = Number(vFormPolicyId);

    variantFormError = "";
    try {
      if (editingVariantId === "new") {
        await createVariant(String(expandedId), vFormName.trim(), patch, vFormNotes.trim());
      } else if (editingVariantId != null) {
        await updateVariant(String(editingVariantId), { name: vFormName.trim(), patch, notes: vFormNotes.trim() });
      }
      editingVariantId = null;
      variantCache[expandedId] = await fetchVariants(String(expandedId));
    } catch (err: unknown) {
      variantFormError = err instanceof Error ? err.message : "Save failed.";
    }
  }

  async function handleDeleteVariant(v: LoadoutVariant) {
    if (!confirm(`Delete variant "${v.name}"?`)) return;
    if (expandedId == null) return;
    try {
      await deleteVariant(String(v.id));
      variantCache[expandedId] = await fetchVariants(String(expandedId));
    } catch (err: unknown) {
      variantFormError = err instanceof Error ? err.message : "Delete failed.";
    }
  }

  function describePatch(patch: VariantPatch | null | undefined): string[] {
    if (!patch) return [];
    const parts: string[] = [];
    if (patch.bridge) {
      for (const [slot, offId] of Object.entries(patch.bridge)) {
        if (offId) parts.push(`${SLOT_NAMES[slot as BridgeSlot] ?? slot} → ${officerName(offId)}`);
      }
    }
    if (patch.below_deck_policy_id != null) parts.push(`Policy → ${policyName(patch.below_deck_policy_id)}`);
    if (patch.intent_keys?.length) parts.push(`Intents → ${patch.intent_keys.join(", ")}`);
    return parts;
  }
</script>

<section class="loadouts">
  <!-- Stats bar -->
  <div class="ws-stats-bar">
    <span><strong>{totalCount}</strong> loadout{totalCount !== 1 ? "s" : ""}</span>
    <span>·</span>
    <span><strong>{activeCount}</strong> active</span>
    <span>·</span>
    <span><strong>{uniqueShips}</strong> ship{uniqueShips !== 1 ? "s" : ""}</span>
  </div>

  <!-- Toolbar -->
  <div class="lo-toolbar">
    <input
      class="lo-search"
      type="text"
      placeholder="Search loadouts…"
      bind:value={searchQuery}
    />
    <div class="lo-filters">
      <select bind:value={filterIntent}>
        <option value="">All intents</option>
        {#each usedIntents as key}
          <option value={key}>{intentLabel(key)}</option>
        {/each}
      </select>
      <select bind:value={filterActive}>
        <option value="">All</option>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>
    </div>
    <div class="lo-sort">
      <span class="lo-sort-label">Sort:</span>
      <select bind:value={sortField}>
        <option value="name">Name</option>
        <option value="ship">Ship</option>
        <option value="priority">Priority</option>
      </select>
      <button class="ws-btn lo-dir-btn" onclick={() => (sortDir = sortDir === "asc" ? "desc" : "asc")}>
        {sortDir === "asc" ? "↑" : "↓"}
      </button>
    </div>
    <button class="ws-btn ws-btn-create" onclick={startNew}>+ New Loadout</button>
  </div>

  <!-- New form -->
  {#if editingId === "new"}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="ws-form" role="form" onkeydown={handleKeydown}>
      {@render loadoutForm()}
    </div>
  {/if}

  <!-- Loadout cards -->
  {#if filtered.length === 0}
    <p class="ws-empty">{loadouts.length === 0 ? "No loadouts yet." : "No loadouts match your filters."}</p>
  {:else}
    <div class="ws-list">
      {#each filtered as lo (lo.id)}
        {#if editingId === lo.id}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div class="ws-form" role="form" onkeydown={handleKeydown}>
            {@render loadoutForm()}
          </div>
        {:else}
          <div class="ws-card" class:ws-card-active={lo.isActive}>
            <div class="ws-card-header">
              <span class="ws-card-name">{lo.name}</span>
              {#if lo.isActive}
                <span class="ws-badge ws-badge-active">Active</span>
              {/if}
              {#if lo.priority}
                <span class="ws-badge ws-badge-priority">P{lo.priority}</span>
              {/if}
              <div class="ws-card-actions">
                <button
                  class="ws-action"
                  title={expandedId === lo.id ? "Collapse variants" : "Expand variants"}
                  onclick={() => toggleVariants(lo.id)}
                >
                  {expandedId === lo.id ? "▾" : "▸"}
                </button>
                <button class="ws-action" onclick={() => startEdit(lo)} title="Edit">✎</button>
                <button class="ws-action ws-action-danger" onclick={() => handleDelete(lo)} title="Delete">✕</button>
              </div>
            </div>
            <div class="ws-card-body">
              <div class="ws-row"><span class="ws-row-label">Ship</span><span>{shipName(lo.shipId)}</span></div>
              <div class="ws-row"><span class="ws-row-label">Bridge Core</span><span>{coreName(lo.bridgeCoreId)}</span></div>
              <div class="ws-row"><span class="ws-row-label">Below Deck</span><span>{policyName(lo.belowDeckPolicyId)}</span></div>
              {#if lo.intentKeys?.length}
                <div class="ws-intent-list">
                  {#each lo.intentKeys as key}
                    <span class="ws-intent-chip">{intentLabel(key)}</span>
                  {/each}
                </div>
              {/if}
              {#if lo.tags?.length}
                <div class="ws-tag-list">
                  {#each lo.tags as tag}
                    <span class="ws-tag-chip">{tag}</span>
                  {/each}
                </div>
              {/if}
              {#if lo.notes}
                <p class="ws-card-notes">{lo.notes}</p>
              {/if}
            </div>

            <!-- Variant section -->
            {#if expandedId === lo.id}
              {@render variantSection(lo)}
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<!-- ─── Render snippets ─── -->

{#snippet loadoutForm()}
  <div class="ws-form-grid">
    <label class="ws-field">
      <span>Name</span>
      <input type="text" bind:value={formName} maxlength="100" placeholder="e.g. Kumari Grinder" />
    </label>
    <label class="ws-field">
      <span>Ship</span>
      <select bind:value={formShipId}>
        <option value="">— Select ship —</option>
        {#each ships as s}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
    </label>
    <label class="ws-field">
      <span>Bridge Core</span>
      <select bind:value={formCoreId}>
        <option value="">— Select core —</option>
        {#each bridgeCores as c}
          <option value={String(c.id)}>{c.name}</option>
        {/each}
      </select>
    </label>
    <label class="ws-field">
      <span>Below Deck Policy</span>
      <select bind:value={formPolicyId}>
        <option value="">— Select policy —</option>
        {#each belowDeckPolicies as p}
          <option value={String(p.id)}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label class="ws-field">
      <span>Priority</span>
      <input type="number" bind:value={formPriority} min="0" max="99" />
    </label>
    <label class="ws-field ws-field-checkbox">
      <input type="checkbox" bind:checked={formIsActive} />
      <span>Active</span>
    </label>
    <fieldset class="ws-wide ws-intent-fieldset">
      <legend>Intents</legend>
      <div class="ws-intent-grid">
        {#each INTENT_CATALOG as intent}
          <label class="ws-intent-option">
            <input
              type="checkbox"
              checked={formIntents.has(intent.key)}
              onchange={() => toggleIntent(intent.key)}
            />
            <span>{intent.icon} {intent.label}</span>
          </label>
        {/each}
      </div>
    </fieldset>
    <label class="ws-field ws-wide">
      <span>Tags (comma-separated)</span>
      <input type="text" bind:value={formTags} maxlength="200" placeholder="e.g. pvp, armada, daily" />
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
    <button class="ws-btn ws-btn-save" onclick={saveLoadout}>Save</button>
    <button class="ws-btn ws-btn-cancel" onclick={cancelEdit}>Cancel</button>
  </div>
{/snippet}

{#snippet variantSection(lo: Loadout)}
  <div class="var-section">
    <div class="var-header">
      <span>Variants ({(variantCache[lo.id] ?? []).length})</span>
      <button class="ws-btn ws-btn-create var-add-btn" onclick={startNewVariant}>+ Add Variant</button>
    </div>

    {#if editingVariantId === "new"}
      {@render variantForm()}
    {/if}

    {#if (variantCache[lo.id] ?? []).length === 0 && editingVariantId !== "new"}
      <p class="ws-empty var-empty">No variants. Variants let you patch bridge or policy for specific scenarios.</p>
    {:else}
      <div class="var-list">
        {#each variantCache[lo.id] ?? [] as v (v.id)}
          {#if editingVariantId === v.id}
            {@render variantForm()}
          {:else}
            <div class="var-card">
              <div class="var-card-header">
                <span class="var-card-name">{v.name}</span>
                <div class="ws-card-actions">
                  <button class="ws-action" onclick={() => startEditVariant(v)} title="Edit">✎</button>
                  <button class="ws-action ws-action-danger" onclick={() => handleDeleteVariant(v)} title="Delete">✕</button>
                </div>
              </div>
              {#if describePatch(v.patch).length}
                <div class="var-patch-summary">
                  {#each describePatch(v.patch) as part, i}
                    {#if i > 0}<span class="var-divider">·</span>{/if}
                    <span class="var-patch-item">{part}</span>
                  {/each}
                </div>
              {/if}
              {#if v.notes}
                <p class="ws-card-notes">{v.notes}</p>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet variantForm()}
  <div class="var-form">
    <div class="ws-form-grid">
      <label class="ws-field ws-wide">
        <span>Name</span>
        <input type="text" bind:value={vFormName} maxlength="100" placeholder="e.g. Swap McCoy for T'Laan" />
      </label>
      {#each SLOTS as slot}
        <label class="ws-field">
          <span>{SLOT_NAMES[slot]} (patch)</span>
          <select bind:value={vFormSlots[slot]}>
            <option value="">— No change —</option>
            {#each officers as off}
              <option value={off.id}>{off.name} (L{off.userLevel ?? "?"})</option>
            {/each}
          </select>
        </label>
      {/each}
      <label class="ws-field">
        <span>Policy Override</span>
        <select bind:value={vFormPolicyId}>
          <option value="">— No change —</option>
          {#each belowDeckPolicies as p}
            <option value={String(p.id)}>{p.name}</option>
          {/each}
        </select>
      </label>
      <label class="ws-field ws-wide">
        <span>Notes</span>
        <textarea bind:value={vFormNotes} maxlength="500" rows="2"></textarea>
      </label>
    </div>
    {#if variantFormError}
      <p class="ws-form-error">{variantFormError}</p>
    {/if}
    <div class="ws-form-actions">
      <button class="ws-btn ws-btn-save" onclick={saveVariant}>Save</button>
      <button class="ws-btn ws-btn-cancel" onclick={cancelVariant}>Cancel</button>
    </div>
  </div>
{/snippet}

<style>
  /* ── Stats ── */
  .ws-stats-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .ws-stats-bar strong { color: var(--text-primary); }

  /* ── Loadout Toolbar ── */
  .lo-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .lo-search {
    flex: 1;
    min-width: 160px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.88rem;
  }
  .lo-filters { display: flex; gap: 6px; }
  .lo-filters select {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.82rem;
  }
  .lo-sort {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
  }
  .lo-sort-label { color: var(--text-muted); }
  .lo-sort select {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.82rem;
  }
  .lo-dir-btn { padding: 5px 10px; }

  /* ── Shared workshops ── (reused from CoresTab) */
  .ws-btn {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ws-btn:hover { background: var(--bg-tertiary); }
  .ws-btn-create { color: var(--accent-gold); border-color: var(--accent-gold-dim); }
  .ws-btn-save { background: var(--accent-gold-dim); color: var(--bg-primary); font-weight: 600; }
  .ws-btn-cancel { opacity: 0.7; }

  .ws-form {
    background: var(--bg-secondary);
    border: 1px solid var(--accent-gold-dim);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .ws-form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .ws-wide { grid-column: 1 / -1; }
  .ws-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ws-field span {
    font-size: 0.78rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .ws-field input[type="text"],
  .ws-field input[type="number"],
  .ws-field select,
  .ws-field textarea {
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.88rem;
  }
  .ws-field-checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .ws-field-checkbox input { width: auto; }

  .ws-form-error {
    color: var(--accent-red, #e55);
    font-size: 0.82rem;
    margin: 8px 0 0;
  }
  .ws-form-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  /* ── Intent Grid ── */
  .ws-intent-fieldset {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px;
  }
  .ws-intent-fieldset legend {
    font-size: 0.78rem;
    color: var(--text-muted);
    text-transform: uppercase;
    padding: 0 4px;
  }
  .ws-intent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
  }
  .ws-intent-option {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ws-intent-option input { width: auto; margin: 0; }

  /* ── Cards ── */
  .ws-list { display: flex; flex-direction: column; gap: 8px; }
  .ws-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
  }
  .ws-card-active { border-left: 3px solid var(--accent-green, #5a5); }
  .ws-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ws-card-name { font-weight: 600; flex: 1; }
  .ws-card-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
  .ws-card:hover .ws-card-actions { opacity: 1; }
  .ws-action {
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ws-action:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .ws-action-danger:hover { color: var(--accent-red, #e55); }

  /* ── Badges ── */
  .ws-badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .ws-badge-active { background: var(--accent-green, #5a5); color: #000; }
  .ws-badge-priority { background: var(--accent-gold-dim); color: var(--bg-primary); }

  /* ── Card body ── */
  .ws-card-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  }
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
    min-width: 90px;
  }

  /* ── Intent & Tag chips ── */
  .ws-intent-list, .ws-tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }
  .ws-intent-chip, .ws-tag-chip {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.76rem;
  }
  .ws-intent-chip { background: var(--bg-tertiary); color: var(--text-primary); }
  .ws-tag-chip { background: var(--bg-tertiary); color: var(--text-muted); border: 1px solid var(--border); }

  .ws-card-notes {
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.82rem;
    margin: 4px 0 0;
  }

  .ws-empty {
    text-align: center;
    color: var(--text-muted);
    padding: 24px 0;
    font-size: 0.88rem;
  }

  /* ── Variant section ── */
  .var-section {
    border-top: 1px solid var(--border);
    margin-top: 10px;
    padding-top: 10px;
  }
  .var-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 0.88rem;
    font-weight: 600;
  }
  .var-add-btn { font-size: 0.78rem; padding: 3px 10px; }
  .var-list { display: flex; flex-direction: column; gap: 6px; }
  .var-card {
    background: var(--bg-tertiary);
    border-left: 3px solid var(--accent-gold-dim);
    border-radius: 4px;
    padding: 10px 14px;
  }
  .var-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .var-card-name { font-weight: 600; flex: 1; font-size: 0.88rem; }
  .var-patch-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .var-divider { color: var(--border); }
  .var-empty { padding: 12px 0; font-size: 0.82rem; }

  /* Variant form */
  .var-form {
    background: var(--bg-tertiary);
    border: 1px solid var(--accent-gold);
    border-radius: 4px;
    padding: 14px;
    margin-bottom: 8px;
  }

  @media (max-width: 768px) {
    .ws-form-grid { grid-template-columns: 1fr; }
    .lo-toolbar { flex-direction: column; align-items: stretch; }
    .lo-search { min-width: 0; }
    .ws-card-actions { opacity: 1; }
  }
</style>
