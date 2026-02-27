<script lang="ts">
  import { onMount } from "svelte";
  import { navigate } from "../lib/router.svelte.js";
  import { hasRole } from "../lib/auth.svelte.js";
  import { confirm } from "../components/ConfirmDialog.svelte";
  import {
    fetchCatalogCounts,
    fetchCatalogOfficers,
    fetchCatalogShips,
    bulkSetOfficerOverlay,
    bulkSetShipOverlay,
  } from "../lib/api/catalog.js";
  import { fetchReceipts, fetchReceipt, undoReceipt } from "../lib/api/receipts.js";
  import type { ImportReceipt, UnresolvedImportItem } from "../lib/types.js";
  import { checkHealth } from "../lib/api/health.js";
  import { setCatalogLaunchIntent, setWorkshopLaunchIntent } from "../lib/view-intent.svelte.js";
  import {
    GUIDED_SETUP_TEMPLATES,
    resolveGuidedSetupSuggestions,
    type GuidedSetupSuggestion,
  } from "../lib/guided-setup-templates.js";
  import { loadUserSetting, saveUserSetting } from "../lib/api/user-settings.js";

  let loading = $state(true);
  let error = $state("");
  let info = $state("");

  let firstRun = $state(true);
  let receiptCount = $state(0);
  let lastSyncAt = $state<string | null>(null);
  let recentReceipts = $state<ImportReceipt[]>([]);

  let selectedReceiptId = $state<string>("");
  let selectedReceipt = $state<ImportReceipt | null>(null);
  let receiptUnresolved = $state<UnresolvedImportItem[]>([]);

  let showAriaIntro = $state(true);
  let ariaConfigured = $state(true);

  let guidedSelectedKeys = $state<string[]>([]);
  let guidedPreviewLoading = $state(false);
  let guidedPreviewReady = $state(false);
  let guidedCommitLoading = $state(false);
  let guidedOfficers = $state<GuidedSetupSuggestion[]>([]);
  let guidedShips = $state<GuidedSetupSuggestion[]>([]);
  let guidedLastReceiptId = $state<number | null>(null);
  let showGuidedCompositionPrompt = $state(false);
  let opsLevel = $state("1");
  let opsSaving = $state(false);
  let opsStatus = $state<"idle" | "saved" | "error">("idle");

  const environment = import.meta.env.PROD ? "production" : "development";

  onMount(() => {
    const dismissed = localStorage.getItem("startsync.ariaIntroDismissed") === "1";
    showAriaIntro = !dismissed;
    void refresh();
  });

  async function refresh() {
    loading = true;
    error = "";
    try {
      const [counts, receipts, health] = await Promise.all([
        fetchCatalogCounts(),
        fetchReceipts({ limit: 20, layer: "ownership" }),
        checkHealth(),
      ]);
      const ownedTotal = (counts.overlay.officers.owned ?? 0) + (counts.overlay.ships.owned ?? 0);
      firstRun = ownedTotal === 0;
      recentReceipts = receipts;
      receiptCount = receipts.length;
      lastSyncAt = receipts.length > 0 ? receipts[0].createdAt : null;
      ariaConfigured = !!health && health.gemini === "connected";
      opsLevel = await loadUserSetting("fleet.opsLevel", "1");
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load Start/Sync status.";
    } finally {
      loading = false;
    }
  }

  function dismissAriaIntro() {
    showAriaIntro = false;
    localStorage.setItem("startsync.ariaIntroDismissed", "1");
  }

  function openQuickSetup() {
    setCatalogLaunchIntent({ ownership: "unknown" });
    navigate("catalog");
  }

  function openImports() {
    setWorkshopLaunchIntent({ tab: "imports" });
    navigate("crews");
  }

  function toggleGuidedTemplate(key: string) {
    guidedSelectedKeys = guidedSelectedKeys.includes(key)
      ? guidedSelectedKeys.filter((item) => item !== key)
      : [...guidedSelectedKeys, key];
  }

  async function previewGuidedSetup() {
    if (guidedSelectedKeys.length === 0) {
      error = "Select at least one activity before preview.";
      return;
    }
    guidedPreviewLoading = true;
    error = "";
    showGuidedCompositionPrompt = false;
    guidedLastReceiptId = null;
    try {
      const [officers, ships] = await Promise.all([
        fetchCatalogOfficers({}, { forceNetwork: true }),
        fetchCatalogShips({}, { forceNetwork: true }),
      ]);
      const resolved = resolveGuidedSetupSuggestions(officers, ships, guidedSelectedKeys);
      guidedOfficers = resolved.officers;
      guidedShips = resolved.ships;
      guidedPreviewReady = true;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to build Guided Setup preview.";
    } finally {
      guidedPreviewLoading = false;
    }
  }

  function toggleGuidedSuggestion(
    type: "officer" | "ship",
    id: string,
  ) {
    const update = (items: GuidedSetupSuggestion[]) =>
      items.map((item) => (item.id === id ? { ...item, checked: !item.checked } : item));
    if (type === "officer") guidedOfficers = update(guidedOfficers);
    else guidedShips = update(guidedShips);
  }

  async function commitGuidedSetup() {
    const officerRefIds = guidedOfficers.filter((item) => item.checked).map((item) => item.id);
    const shipRefIds = guidedShips.filter((item) => item.checked).map((item) => item.id);
    if (officerRefIds.length === 0 && shipRefIds.length === 0) {
      error = "Select at least one officer or ship to commit ownership.";
      return;
    }

    guidedCommitLoading = true;
    error = "";
    try {
      const receiptIds: number[] = [];
      if (officerRefIds.length > 0) {
        const response = await bulkSetOfficerOverlay(officerRefIds, { ownershipState: "owned" });
        if (typeof response.receiptId === "number") receiptIds.push(response.receiptId);
      }
      if (shipRefIds.length > 0) {
        const response = await bulkSetShipOverlay(shipRefIds, { ownershipState: "owned" });
        if (typeof response.receiptId === "number") receiptIds.push(response.receiptId);
      }

      guidedLastReceiptId = receiptIds.length > 0 ? receiptIds[receiptIds.length - 1] : null;
      showGuidedCompositionPrompt = true;

      guidedOfficers = guidedOfficers.map((item) => (item.checked ? { ...item, ownershipState: "owned" } : item));
      guidedShips = guidedShips.map((item) => (item.checked ? { ...item, ownershipState: "owned" } : item));
      await refresh();
    } catch (err) {
      error = err instanceof Error ? err.message : "Guided Setup commit failed.";
    } finally {
      guidedCommitLoading = false;
    }
  }

  function skipGuidedCompositionPrompt() {
    showGuidedCompositionPrompt = false;
  }

  async function loadReceipt(id: string) {
    selectedReceiptId = id;
    selectedReceipt = null;
    receiptUnresolved = [];
    if (!id) return;
    try {
      const receipt = await fetchReceipt(id);
      selectedReceipt = receipt;
      receiptUnresolved = Array.isArray(receipt.unresolved) ? (receipt.unresolved as UnresolvedImportItem[]) : [];
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to load receipt.";
    }
  }

  async function handleUndo() {
    if (!selectedReceipt) return;
    const ok = await confirm({
      title: `Undo receipt #${selectedReceipt.id}?`,
      subtitle: "This reverts import changes from that receipt.",
      severity: "warning",
      approveLabel: "Undo",
    });
    if (!ok) return;
    try {
      await undoReceipt(String(selectedReceipt.id));
      selectedReceipt = null;
      selectedReceiptId = "";
      receiptUnresolved = [];
      await refresh();
    } catch (err) {
      error = err instanceof Error ? err.message : "Undo failed.";
    }
  }

  async function runSandboxAction(action: string) {
    info = `${action} — coming soon. This feature is under development.`;
  }

  function fmtDate(date: string | null): string {
    if (!date) return "Never";
    return new Date(date).toLocaleString();
  }

  async function saveOpsLevel() {
    const parsed = Number.parseInt(opsLevel, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 80) {
      opsStatus = "error";
      error = "OPS Level must be a whole number between 1 and 80.";
      return;
    }

    opsSaving = true;
    opsStatus = "idle";
    try {
      await saveUserSetting("fleet.opsLevel", parsed);
      opsLevel = String(parsed);
      opsStatus = "saved";
      error = "";
    } catch (err) {
      opsStatus = "error";
      error = err instanceof Error ? err.message : "Failed to save OPS Level.";
    } finally {
      opsSaving = false;
    }
  }
</script>

<section class="startsync">
  {#if loading}
    <p class="ss-loading">Loading Start/Sync…</p>
  {:else}
    {#if error}
      <div class="ss-error" role="alert">
        <span>⚠ {error}</span>
        <button onclick={() => { error = ""; }}>✕</button>
      </div>
    {/if}

    {#if info}
      <div class="ss-info" role="status">
        <span>ℹ {info}</span>
        <button onclick={() => { info = ""; }}>✕</button>
      </div>
    {/if}

    {#if showAriaIntro}
      <div class="ss-card ss-aria">
        <div>
          <h3>Aria Assist (Optional)</h3>
          <p>
            Aria can help with mapping and suggestions, but setup/import always works manually.
            {#if !ariaConfigured}
              Configure AI assistant in Settings to enable Aria actions.
            {/if}
          </p>
        </div>
        <button class="ss-btn ss-btn-secondary" onclick={dismissAriaIntro}>Dismiss</button>
      </div>
    {/if}

    <div class="ss-card">
      {#if firstRun}
        <p class="ss-banner">Welcome! Start by marking your officers as owned, or import a roster file.</p>
      {:else}
        <p class="ss-banner">
          Last sync: {fmtDate(lastSyncAt)} · Receipts: {receiptCount}
        </p>
      {/if}
    </div>

    <div class="ss-grid">
      <div class="ss-card">
        <h3>Fleet Profile</h3>
        <p>Set your current OPS level so recommendations match your progression.</p>
        <label class="ss-label" for="ops-level-input" title="Your in-game Operations (Starbase) level. Determines which buildings, ships, research, and content are relevant to you.">OPS Level (1–80)</label>
        <input
          id="ops-level-input"
          class="ss-input"
          type="number"
          min="1"
          max="80"
          value={opsLevel}
          oninput={(e) => {
            opsLevel = (e.currentTarget as HTMLInputElement).value;
            opsStatus = "idle";
          }}
        />
        <div class="ss-receipt-actions">
          <button class="ss-btn" onclick={saveOpsLevel} disabled={opsSaving}>
            {opsSaving ? "Saving…" : "Save OPS Level"}
          </button>
          {#if opsStatus === "saved"}
            <span class="ss-inline-status">Saved</span>
          {/if}
        </div>
      </div>

      <div class="ss-card">
        <h3>Quick Setup (No file)</h3>
        <p>Mark your officers and ships as owned from the catalog.</p>
        <button class="ss-btn" onclick={openQuickSetup}>Open Catalog Ownership Mode</button>
      </div>

      <div class="ss-card">
        <h3>Guided Setup</h3>
        <p>Pick your activities, confirm officers, preview and commit.</p>

        <div class="ss-guided-templates">
          {#each GUIDED_SETUP_TEMPLATES as template (template.key)}
            <label class="ss-guided-template">
              <input
                type="checkbox"
                checked={guidedSelectedKeys.includes(template.key)}
                onchange={() => toggleGuidedTemplate(template.key)}
              />
              <span>
                <strong>{template.title}</strong>
                <small>{template.description}</small>
              </span>
            </label>
          {/each}
        </div>

        <button class="ss-btn" onclick={previewGuidedSetup} disabled={guidedPreviewLoading}>
          {guidedPreviewLoading ? "Building Preview…" : "Preview Suggested Ownership"}
        </button>

        {#if guidedPreviewReady}
          <div class="ss-guided-preview">
            <p class="ss-guided-preview-title">
              Preview · {guidedOfficers.length} officers · {guidedShips.length} ships
            </p>

            <div>
              <p class="ss-guided-entity-title">Officers</p>
              {#if guidedOfficers.length === 0}
                <p class="ss-guided-empty">No matching officers found for selected templates.</p>
              {:else}
                <div class="ss-guided-entities">
                  {#each guidedOfficers as officer (officer.id)}
                    <label class="ss-guided-entity">
                      <input type="checkbox" checked={officer.checked} onchange={() => toggleGuidedSuggestion("officer", officer.id)} />
                      <span>{officer.name}</span>
                      <small>{officer.ownershipState}</small>
                    </label>
                  {/each}
                </div>
              {/if}
            </div>

            <div>
              <p class="ss-guided-entity-title">Ships</p>
              {#if guidedShips.length === 0}
                <p class="ss-guided-empty">No matching ships found for selected templates.</p>
              {:else}
                <div class="ss-guided-entities">
                  {#each guidedShips as ship (ship.id)}
                    <label class="ss-guided-entity">
                      <input type="checkbox" checked={ship.checked} onchange={() => toggleGuidedSuggestion("ship", ship.id)} />
                      <span>{ship.name}</span>
                      <small>{ship.ownershipState}</small>
                    </label>
                  {/each}
                </div>
              {/if}
            </div>

            <button class="ss-btn" onclick={commitGuidedSetup} disabled={guidedCommitLoading}>
              {guidedCommitLoading ? "Committing…" : "Commit Guided Ownership"}
            </button>

            {#if showGuidedCompositionPrompt}
              <div class="ss-guided-composition">
                <p>
                  Guided ownership committed{guidedLastReceiptId ? ` (receipt #${guidedLastReceiptId})` : ""}. Continue to composition setup?
                </p>
                <div class="ss-receipt-actions">
                  <button class="ss-btn" onclick={openImports}>Open Workshop Imports</button>
                  <button class="ss-btn ss-btn-secondary" onclick={skipGuidedCompositionPrompt}>Not Now</button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="ss-card">
        <h3>Import a File</h3>
        <p>Upload and review roster data through parse → preview → resolve flow.</p>
        <button class="ss-btn ss-btn-secondary" disabled>Coming Soon</button>
      </div>

      <div class="ss-card">
        <h3>Community Export</h3>
        <p>Use supported source mapping and review before commit.</p>
        <button class="ss-btn ss-btn-secondary" disabled>Coming Soon</button>
      </div>

      <div class="ss-card">
        <h3>Import History</h3>
        <p>Review recent receipts, undo, or continue resolving unresolved items.</p>

        <label class="ss-label" for="receipt-select">Recent Receipts</label>
        <select
          id="receipt-select"
          class="ss-select"
          value={selectedReceiptId}
          onchange={(e) => loadReceipt((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Select receipt…</option>
          {#each recentReceipts as receipt (receipt.id)}
            <option value={String(receipt.id)}>
              #{receipt.id} · {receipt.sourceType} · {fmtDate(receipt.createdAt)}
            </option>
          {/each}
        </select>

        {#if selectedReceipt}
          <div class="ss-receipt-actions">
            <button class="ss-btn ss-btn-secondary" onclick={handleUndo}>Undo Receipt</button>
            {#if receiptUnresolved.length > 0}
              <button class="ss-btn" onclick={openImports}>Continue Resolving ({receiptUnresolved.length})</button>
            {/if}
          </div>
        {/if}
      </div>

      {#if hasRole("admiral")}
        <div class="ss-card">
          <h3>Developer / Sandbox</h3>
          <p class="ss-env">Environment: <strong>{environment}</strong></p>
          <div class="ss-sandbox-actions">
            <button class="ss-btn ss-btn-secondary" onclick={() => runSandboxAction("Reset Composition")}>Reset Composition</button>
            <button class="ss-btn ss-btn-secondary" onclick={() => runSandboxAction("Reset Overlays")}>Reset Overlays</button>
            <button class="ss-btn ss-btn-secondary" onclick={() => runSandboxAction("Reset Reference")}>Reset Reference</button>
            <button class="ss-btn ss-btn-secondary" onclick={() => runSandboxAction("Load Fixtures")}>Load Fixtures</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .startsync {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }

  .ss-loading {
    color: var(--text-muted);
    text-align: center;
    padding: 24px 0;
  }

  .ss-error {
    color: var(--danger, #f66);
    font-size: 0.86rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ss-error button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
  }

  .ss-info {
    color: var(--info, #6af);
    font-size: 0.86rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ss-info button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
  }

  .ss-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }

  .ss-card {
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ss-card h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .ss-card p {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.84rem;
    line-height: 1.45;
  }

  .ss-banner {
    color: var(--text-primary);
    font-size: 0.88rem;
  }

  .ss-btn {
    border: 1px solid var(--accent-gold-dim);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-size: 0.84rem;
    cursor: pointer;
  }

  .ss-btn:hover {
    background: var(--bg-hover);
  }

  .ss-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ss-btn-secondary {
    border-color: var(--border);
  }

  .ss-label {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .ss-select {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .ss-input {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .ss-inline-status {
    font-size: 0.78rem;
    color: var(--text-muted);
    align-self: center;
  }

  .ss-receipt-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .ss-sandbox-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .ss-env {
    font-size: 0.8rem;
  }

  .ss-guided-templates {
    display: grid;
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .ss-guided-template {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.82rem;
    color: var(--text-primary);
  }

  .ss-guided-template span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ss-guided-template small {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .ss-guided-preview {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ss-guided-preview-title {
    font-size: 0.8rem;
    color: var(--text-primary);
  }

  .ss-guided-entity-title {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .ss-guided-entities {
    display: grid;
    gap: 6px;
    max-height: 180px;
    overflow-y: auto;
    padding-right: 2px;
  }

  .ss-guided-entity {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: var(--text-primary);
  }

  .ss-guided-entity small {
    color: var(--text-muted);
    text-transform: capitalize;
  }

  .ss-guided-empty {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .ss-guided-composition {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }

  .ss-aria {
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  @media (max-width: 768px) {
    .startsync { padding: 12px; }
    .ss-grid { grid-template-columns: 1fr; }
    .ss-sandbox-actions { grid-template-columns: 1fr; }
    .ss-aria { flex-direction: column; }
  }
</style>
