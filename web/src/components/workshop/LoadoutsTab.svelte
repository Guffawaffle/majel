<script lang="ts">
  /**
   * LoadoutsTab — Loadout CRUD with search/filter/sort toolbar,
   * intent checkbox grid, and expandable variant sections.
   * Most complex tab in the Workshop.
   */
  import "../../styles/workshop-shared.css";
  import "../../styles/loadouts-tab.css";
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
  import { confirm } from "../../components/ConfirmDialog.svelte";
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
  import {
    createInitialLoadoutsTabUiState,
    routeLoadoutsTabCommand,
    type LoadoutsTabCommand,
  } from "../../lib/loadouts-tab-commands.js";

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

  let ui = $state(createInitialLoadoutsTabUiState());

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
  let variantCache = $state<Record<number, LoadoutVariant[]>>({});
  let vFormName = $state("");
  let vFormNotes = $state("");
  let vFormSlots = $state<Record<BridgeSlot, string>>({ captain: "", bridge_1: "", bridge_2: "" });
  let vFormPolicyId = $state("");

  function send(command: LoadoutsTabCommand) {
    ui = routeLoadoutsTabCommand(ui, command);
  }

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
    if (ui.searchQuery) {
      const q = ui.searchQuery.toLowerCase();
      list = list.filter(
        (l) => l.name.toLowerCase().includes(q) || shipName(l.shipId).toLowerCase().includes(q),
      );
    }
    if (ui.filterIntent) {
      list = list.filter((l) => l.intentKeys?.includes(ui.filterIntent));
    }
    if (ui.filterActive === "true") list = list.filter((l) => l.isActive);
    if (ui.filterActive === "false") list = list.filter((l) => !l.isActive);

    // Sort
    const dir = ui.sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (ui.sortField === "name") return a.name.localeCompare(b.name) * dir;
      if (ui.sortField === "ship") return shipName(a.shipId).localeCompare(shipName(b.shipId)) * dir;
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
    send({ type: "loadout/new" });
    formName = "";
    formShipId = "";
    formCoreId = "";
    formPolicyId = "";
    formPriority = 0;
    formIsActive = false;
    formIntents = new Set();
    formTags = "";
    formNotes = "";
    send({ type: "loadout/error-clear" });
    collapseVariants();
  }

  function startEdit(lo: Loadout) {
    send({ type: "loadout/edit", id: lo.id });
    formName = lo.name;
    formShipId = lo.shipId ?? "";
    formCoreId = lo.bridgeCoreId != null ? String(lo.bridgeCoreId) : "";
    formPolicyId = lo.belowDeckPolicyId != null ? String(lo.belowDeckPolicyId) : "";
    formPriority = lo.priority ?? 0;
    formIsActive = lo.isActive ?? false;
    formIntents = new Set(lo.intentKeys ?? []);
    formTags = (lo.tags ?? []).join(", ");
    formNotes = lo.notes ?? "";
    send({ type: "loadout/error-clear" });
    collapseVariants();
  }

  function cancelEdit() {
    send({ type: "loadout/edit-cancel" });
  }

  async function saveLoadout() {
    if (!formName.trim()) { send({ type: "loadout/error", message: "Name is required." }); return; }

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

    send({ type: "loadout/error-clear" });
    try {
      if (ui.editingId === "new") {
        await createCrewLoadout(data);
      } else if (ui.editingId != null) {
        await updateCrewLoadout(String(ui.editingId), data);
      }
      send({ type: "loadout/edit-cancel" });
      await onRefresh();
    } catch (err: unknown) {
      send({ type: "loadout/error", message: err instanceof Error ? err.message : "Save failed." });
    }
  }

  async function handleDelete(lo: Loadout) {
    if (!(await confirm({ title: `Delete loadout "${lo.name}"?`, subtitle: "This will also delete all variants.", severity: "warning", approveLabel: "Delete" }))) return;
    try {
      await deleteCrewLoadout(String(lo.id));
      delete variantCache[lo.id];
      if (ui.expandedId === lo.id) send({ type: "variant/collapse" });
      await onRefresh();
    } catch (err: unknown) {
      send({ type: "loadout/error", message: err instanceof Error ? err.message : "Delete failed." });
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
    if (ui.expandedId === loadoutId) {
      collapseVariants();
      return;
    }
    send({ type: "variant/toggle", loadoutId });
    if (!variantCache[loadoutId]) {
      variantCache[loadoutId] = await fetchVariants(String(loadoutId));
    }
  }

  function collapseVariants() {
    send({ type: "variant/collapse" });
  }

  function startNewVariant() {
    send({ type: "variant/new" });
    vFormName = "";
    vFormNotes = "";
    vFormSlots = { captain: "", bridge_1: "", bridge_2: "" };
    vFormPolicyId = "";
    send({ type: "variant/error-clear" });
  }

  function startEditVariant(v: LoadoutVariant) {
    send({ type: "variant/edit", id: v.id });
    vFormName = v.name;
    vFormNotes = v.notes ?? "";
    const bridge = v.patch?.bridge ?? {};
    vFormSlots = {
      captain: bridge.captain ?? "",
      bridge_1: bridge.bridge_1 ?? "",
      bridge_2: bridge.bridge_2 ?? "",
    };
    vFormPolicyId = v.patch?.below_deck_policy_id != null ? String(v.patch.below_deck_policy_id) : "";
    send({ type: "variant/error-clear" });
  }

  function cancelVariant() {
    send({ type: "variant/cancel" });
  }

  async function saveVariant() {
    if (!vFormName.trim()) { send({ type: "variant/error", message: "Name is required." }); return; }
    if (ui.expandedId == null) return;

    const bridge: Record<string, string> = {};
    for (const s of SLOTS) if (vFormSlots[s]) bridge[s] = vFormSlots[s];
    const patch: VariantPatch = { bridge };
    if (vFormPolicyId) patch.below_deck_policy_id = Number(vFormPolicyId);

    send({ type: "variant/error-clear" });
    try {
      if (ui.editingVariantId === "new") {
        await createVariant(String(ui.expandedId), vFormName.trim(), patch, vFormNotes.trim());
      } else if (ui.editingVariantId != null) {
        await updateVariant(String(ui.editingVariantId), { name: vFormName.trim(), patch, notes: vFormNotes.trim() });
      }
      send({ type: "variant/cancel" });
      variantCache[ui.expandedId] = await fetchVariants(String(ui.expandedId));
    } catch (err: unknown) {
      send({ type: "variant/error", message: err instanceof Error ? err.message : "Save failed." });
    }
  }

  async function handleDeleteVariant(v: LoadoutVariant) {
    if (!(await confirm({ title: `Delete variant "${v.name}"?`, severity: "warning", approveLabel: "Delete" }))) return;
    if (ui.expandedId == null) return;
    try {
      await deleteVariant(String(v.id));
      variantCache[ui.expandedId] = await fetchVariants(String(ui.expandedId));
    } catch (err: unknown) {
      send({ type: "variant/error", message: err instanceof Error ? err.message : "Delete failed." });
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
      value={ui.searchQuery}
      oninput={(event) => send({ type: "search/set", value: (event.currentTarget as HTMLInputElement).value })}
    />
    <div class="lo-filters">
      <select value={ui.filterIntent} onchange={(event) => send({ type: "filter/intent", value: (event.currentTarget as HTMLSelectElement).value })}>
        <option value="">All intents</option>
        {#each usedIntents as key}
          <option value={key}>{intentLabel(key)}</option>
        {/each}
      </select>
      <select value={ui.filterActive} onchange={(event) => send({ type: "filter/active", value: (event.currentTarget as HTMLSelectElement).value as "" | "true" | "false" })}>
        <option value="">All</option>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>
    </div>
    <div class="lo-sort">
      <span class="lo-sort-label">Sort:</span>
      <select value={ui.sortField} onchange={(event) => send({ type: "sort/field", value: (event.currentTarget as HTMLSelectElement).value as "name" | "ship" | "priority" })}>
        <option value="name">Name</option>
        <option value="ship">Ship</option>
        <option value="priority">Priority</option>
      </select>
      <button class="ws-btn lo-dir-btn" onclick={() => send({ type: "sort/toggle-dir" })}>
        {ui.sortDir === "asc" ? "↑" : "↓"}
      </button>
    </div>
    <button class="ws-btn ws-btn-create" onclick={startNew}>+ New Loadout</button>
  </div>

  <!-- New form -->
  {#if ui.editingId === "new"}
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
        {#if ui.editingId === lo.id}
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
                  title={ui.expandedId === lo.id ? "Collapse variants" : "Expand variants"}
                  onclick={() => toggleVariants(lo.id)}
                >
                  {ui.expandedId === lo.id ? "▾" : "▸"}
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
            {#if ui.expandedId === lo.id}
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
  {#if ui.formError}
    <p class="ws-form-error">{ui.formError}</p>
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

    {#if ui.editingVariantId === "new"}
      {@render variantForm()}
    {/if}

    {#if (variantCache[lo.id] ?? []).length === 0 && ui.editingVariantId !== "new"}
      <p class="ws-empty var-empty">No variants. Variants let you patch bridge or policy for specific scenarios.</p>
    {:else}
      <div class="var-list">
        {#each variantCache[lo.id] ?? [] as v (v.id)}
          {#if ui.editingVariantId === v.id}
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
    {#if ui.variantFormError}
      <p class="ws-form-error">{ui.variantFormError}</p>
    {/if}
    <div class="ws-form-actions">
      <button class="ws-btn ws-btn-save" onclick={saveVariant}>Save</button>
      <button class="ws-btn ws-btn-cancel" onclick={cancelVariant}>Cancel</button>
    </div>
  </div>
{/snippet}

