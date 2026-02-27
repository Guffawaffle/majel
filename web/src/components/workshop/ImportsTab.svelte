<script lang="ts">
  import { onMount } from "svelte";
  import "../../styles/imports-tab.css";
  import {
    analyzeImportFile,
    commitCompositionInference,
    commitImportRows,
    mapImportRows,
    parseImportFile,
    resolveImportRows,
  } from "../../lib/api/imports.js";
  import { fetchCatalogOfficers, fetchCatalogShips } from "../../lib/api/catalog.js";
  import {
    fetchReceipt,
    fetchReceipts,
    resolveReceiptItems,
  } from "../../lib/api/receipts.js";
  import { ApiError } from "../../lib/api/fetch.js";
  import {
    buildCompositionSuggestions,
    coerceUnresolved,
    fileToBase64,
    unresolvedCount,
    utf8ToBase64,
  } from "../../lib/imports-tab-helpers.js";
  import {
    createInitialImportsCompositionUiState,
    routeImportsCompositionCommand,
    type ImportsCompositionCommand,
  } from "../../lib/imports-tab-commands.js";
  import type {
    ImportAnalysis,
    CompositionBelowDeckPolicySuggestion,
    CompositionBridgeCoreSuggestion,
    CompositionLoadoutSuggestion,
    ImportReceipt,
    ParsedImportData,
    ResolvedImportRow,
    UnresolvedImportItem,
  } from "../../lib/types.js";

  interface Props {
    onCommitted?: () => Promise<void> | void;
  }

  const { onCommitted }: Props = $props();

  let fileName = $state("");
  let format = $state<"csv" | "tsv" | "xlsx">("csv");
  let pastedCsv = $state("");
  let pendingFileInput = $state<{ fileName: string; contentBase64: string; format: "csv" | "tsv" | "xlsx" } | null>(null);
  let loading = $state(false);
  let error = $state("");
  let status = $state("");
  let analysis = $state<ImportAnalysis | null>(null);
  let parsed = $state<ParsedImportData | null>(null);
  let mapping = $state<Record<string, string>>({});
  let resolvedRows = $state<ResolvedImportRow[]>([]);
  let unresolved = $state<UnresolvedImportItem[]>([]);
  let commitResult = $state<{ receiptId: number; added: number; updated: number; unchanged: number; unresolved: number } | null>(null);
  let overwriteApproval = $state<{
    overwriteCount: number;
    proposed: { added: number; updated: number; unchanged: number };
    candidates: Array<{ entityType: "officer" | "ship"; refId: string; rowIndex: number; changedFields: string[] }>;
  } | null>(null);
  let recentReceipts = $state<ImportReceipt[]>([]);
  let selectedReceiptId = $state("");
  let selectedReceipt = $state<ImportReceipt | null>(null);
  let receiptUnresolved = $state<UnresolvedImportItem[]>([]);
  let receiptSelection = $state<Record<string, boolean>>({});
  let receiptLoading = $state(false);
  let compositionUi = $state(createInitialImportsCompositionUiState());
  let bridgeCoreSuggestions = $state<CompositionBridgeCoreSuggestion[]>([]);
  let belowDeckSuggestions = $state<CompositionBelowDeckPolicySuggestion[]>([]);
  let loadoutSuggestions = $state<CompositionLoadoutSuggestion[]>([]);

  const MANUAL_IMPORT_CANDIDATE_FIELDS = [
    "officerId",
    "officerName",
    "officerLevel",
    "officerRank",
    "officerPower",
    "officerOwned",
    "shipId",
    "shipName",
    "shipLevel",
    "shipTier",
    "shipPower",
    "shipOwned",
  ];

  function sendComposition(command: ImportsCompositionCommand) {
    compositionUi = routeImportsCompositionCommand(compositionUi, command);
  }

  onMount(() => {
    void loadRecentReceipts();
  });

  async function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    fileName = file.name;
    const inferredFormat = inferImportFormat(file.name);
    if (!inferredFormat) {
      error = "Unsupported file type. Use .csv, .tsv, or .xlsx.";
      return;
    }
    format = inferredFormat;
    error = "";

    try {
      const base64 = await fileToBase64(file);
      pendingFileInput = { fileName, contentBase64: base64, format: inferredFormat };
      await runAnalyzeAndParse({ fileName, contentBase64: base64, format: inferredFormat });
      pastedCsv = "";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function analyzePastedCsv() {
    if (!pastedCsv.trim()) {
      error = "Paste CSV text first.";
      return;
    }
    fileName = "pasted.csv";
    format = "csv";
    error = "";

    try {
      const base64 = utf8ToBase64(pastedCsv);
      await runAnalyzeAndParse({ fileName, contentBase64: base64, format: "csv" });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function runAnalyzeAndParse(input: { fileName: string; contentBase64: string; format: "csv" | "tsv" | "xlsx" }) {
    loading = true;
    error = "";
    status = "";
    commitResult = null;
    overwriteApproval = null;
    analysis = null;
    parsed = null;
    mapping = {};
    resolvedRows = [];
    unresolved = [];
    try {
      const [analysisResult, parsedResult] = await Promise.all([
        analyzeImportFile(input),
        parseImportFile(input),
      ]);

      analysis = analysisResult;
      parsed = parsedResult;
      mapping = Object.fromEntries(
        analysisResult.suggestions.map((entry) => [entry.sourceColumn, entry.suggestedField ?? ""]),
      );
      status = `Parsed ${parsedResult.rowCount} row(s). Review mapping, then run resolve.`;
    } finally {
      loading = false;
    }
  }

  function inferImportFormat(name: string): "csv" | "tsv" | "xlsx" | null {
    const lower = name.trim().toLowerCase();
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".tsv")) return "tsv";
    if (lower.endsWith(".xlsx")) return "xlsx";
    return null;
  }

  function buildManualAnalysis(parsedResult: ParsedImportData): ImportAnalysis {
    return {
      fileName: parsedResult.fileName,
      format: parsedResult.format,
      rowCount: parsedResult.rowCount,
      headers: parsedResult.headers,
      sampleRows: parsedResult.sampleRows,
      candidateFields: [...MANUAL_IMPORT_CANDIDATE_FIELDS],
      suggestions: parsedResult.headers.map((header) => ({
        sourceColumn: header,
        suggestedField: null,
        confidence: "low",
        reason: "Manual mapping",
      })),
    };
  }

  async function runManualParse(input: { fileName: string; contentBase64: string; format: "csv" | "tsv" | "xlsx" }) {
    loading = true;
    error = "";
    status = "";
    commitResult = null;
    overwriteApproval = null;
    analysis = null;
    parsed = null;
    mapping = {};
    resolvedRows = [];
    unresolved = [];
    try {
      const parsedResult = await parseImportFile(input);
      parsed = parsedResult;
      analysis = buildManualAnalysis(parsedResult);
      mapping = Object.fromEntries(parsedResult.headers.map((header) => [header, ""]));
      status = `Parsed ${parsedResult.rowCount} row(s). Manual mapping enabled; choose fields, then run resolve.`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function continueManualFromFile() {
    if (!pendingFileInput) {
      error = "Choose a file first.";
      return;
    }
    fileName = pendingFileInput.fileName;
    format = pendingFileInput.format;
    await runManualParse(pendingFileInput);
  }

  async function continueManualFromPastedCsv() {
    if (!pastedCsv.trim()) {
      error = "Paste CSV text first.";
      return;
    }
    fileName = "pasted.csv";
    format = "csv";
    const input = {
      fileName,
      contentBase64: utf8ToBase64(pastedCsv),
      format,
    } as const;
    await runManualParse(input);
  }

  async function runResolve() {
    if (!parsed) {
      error = "Parse data unavailable. Re-analyze file first.";
      return;
    }

    loading = true;
    error = "";
    status = "";
    commitResult = null;
    try {
      const mapResult = await mapImportRows({
        headers: parsed.headers,
        rows: parsed.rows,
        mapping,
      });

      const resolveResult = await resolveImportRows({ mappedRows: mapResult.mappedRows });
      resolvedRows = resolveResult.resolvedRows;
      unresolved = resolveResult.unresolved;
      status = `Resolved ${resolveResult.summary.rows} row(s), unresolved ${resolveResult.summary.unresolved}.`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function runCommit(allowOverwrite = false) {
    if (resolvedRows.length === 0) {
      error = "No resolved rows to commit. Run resolve first.";
      return;
    }

    loading = true;
    error = "";
    status = "";
    try {
      const result = await commitImportRows({
        fileName,
        sourceMeta: {
          format,
          rowCount: parsed?.rowCount ?? 0,
        },
        mapping,
        resolvedRows,
        unresolved,
        allowOverwrite,
      });

      commitResult = {
        receiptId: result.receipt.id,
        added: result.summary.added,
        updated: result.summary.updated,
        unchanged: result.summary.unchanged,
        unresolved: result.summary.unresolved,
      };
      overwriteApproval = null;
      sendComposition({ type: "composition/after-import-commit" });
      bridgeCoreSuggestions = [];
      belowDeckSuggestions = [];
      loadoutSuggestions = [];
      status = `Committed import. Receipt #${result.receipt.id}.`;
      await onCommitted?.();
      await loadRecentReceipts();
      selectedReceiptId = String(result.receipt.id);
      await loadReceiptDetail(selectedReceiptId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detail = err.detail as {
          requiresApproval?: boolean;
          overwriteCount?: number;
          overwriteCandidates?: Array<{ entityType: "officer" | "ship"; refId: string; rowIndex: number; changedFields: string[] }>;
          proposed?: { added: number; updated: number; unchanged: number };
        } | undefined;

        if (detail?.requiresApproval) {
          overwriteApproval = {
            overwriteCount: Number(detail.overwriteCount ?? 0),
            candidates: detail.overwriteCandidates ?? [],
            proposed: detail.proposed ?? { added: 0, updated: 0, unchanged: 0 },
          };
          error = "Overwrite approval required before commit.";
        } else {
          error = err.message;
        }
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      loading = false;
    }
  }

  async function openCompositionPreview() {
    if (!commitResult) {
      error = "Commit import before running composition inference.";
      return;
    }
    sendComposition({ type: "composition/generating", value: true });
    error = "";
    try {
      const [officers, ships] = await Promise.all([
        fetchCatalogOfficers({ ownership: "owned" }, { forceNetwork: true }),
        fetchCatalogShips({ ownership: "owned" }, { forceNetwork: true }),
      ]);
      const generated = buildCompositionSuggestions(officers, ships);
      bridgeCoreSuggestions = generated.bridgeCores;
      belowDeckSuggestions = generated.policies;
      loadoutSuggestions = generated.loadouts;
      sendComposition({ type: "composition/open-preview" });
      status = "Composition preview generated. Review suggestions before commit.";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sendComposition({ type: "composition/generating", value: false });
    }
  }

  function skipCompositionInference() {
    sendComposition({ type: "composition/skip" });
    bridgeCoreSuggestions = [];
    belowDeckSuggestions = [];
    loadoutSuggestions = [];
  }

  async function commitCompositionFromPreview() {
    if (!commitResult) {
      error = "Commit import before creating composition entities.";
      return;
    }

    const acceptedCount =
      bridgeCoreSuggestions.filter((entry) => entry.accepted).length +
      belowDeckSuggestions.filter((entry) => entry.accepted).length +
      loadoutSuggestions.filter((entry) => entry.accepted).length;
    if (acceptedCount === 0) {
      error = "Select at least one suggestion to create.";
      return;
    }

    loading = true;
    error = "";
    try {
      const result = await commitCompositionInference({
        sourceReceiptId: commitResult.receiptId,
        sourceMeta: { generatedBy: "heuristic", ui: "imports-tab" },
        bridgeCores: bridgeCoreSuggestions,
        belowDeckPolicies: belowDeckSuggestions,
        loadouts: loadoutSuggestions,
      });

      status = `Committed composition inference. Receipt #${result.receipt.id}.`;
      sendComposition({ type: "composition/skip" });
      await loadRecentReceipts();
      selectedReceiptId = String(result.receipt.id);
      await loadReceiptDetail(selectedReceiptId);
      await onCommitted?.();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadRecentReceipts() {
    receiptLoading = true;
    try {
      const receipts = await fetchReceipts({ limit: 30, layer: "ownership" });
      recentReceipts = receipts.filter((receipt) => receipt.sourceType === "file_import");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      receiptLoading = false;
    }
  }

  async function loadReceiptDetail(id: string) {
    if (!id) {
      selectedReceipt = null;
      receiptUnresolved = [];
      receiptSelection = {};
      return;
    }

    receiptLoading = true;
    try {
      const receipt = await fetchReceipt(id);
      selectedReceipt = receipt;
      receiptUnresolved = coerceUnresolved(receipt.unresolved);
      receiptSelection = Object.fromEntries(
        receiptUnresolved.map((_item, index) => [String(index), false]),
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      receiptLoading = false;
    }
  }

  async function resolveSelectedFromReceipt() {
    if (!selectedReceipt) {
      error = "Select a receipt first.";
      return;
    }

    const selectedItems = receiptUnresolved.filter((_item, index) => receiptSelection[String(index)] === true);
    if (selectedItems.length === 0) {
      error = "Select at least one unresolved item to resolve.";
      return;
    }

    receiptLoading = true;
    error = "";
    try {
      const updated = await resolveReceiptItems(String(selectedReceipt.id), selectedItems);
      selectedReceipt = updated;
      receiptUnresolved = coerceUnresolved(updated.unresolved);
      receiptSelection = Object.fromEntries(
        receiptUnresolved.map((_item, index) => [String(index), false]),
      );
      status = `Resolved ${selectedItems.length} receipt item(s) for receipt #${selectedReceipt.id}.`;
      await loadRecentReceipts();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      receiptLoading = false;
    }
  }

</script>

<section class="imports">
  <h2 class="imports-title">Imports</h2>
  <p class="imports-subtitle">Upload CSV or paste data to get AI-assisted column mapping with editable choices.</p>

  <div class="imports-inputs">
    <label class="imports-upload">
      <span>Choose CSV/TSV/XLSX</span>
      <input type="file" accept=".csv,.tsv,.xlsx" onchange={onFileChange} />
    </label>
    <div class="imports-actions">
      <button class="imports-btn" onclick={() => { void continueManualFromFile(); }} disabled={loading || !pendingFileInput}>Continue with manual mapping</button>
    </div>

    <div class="imports-paste">
      <label for="csv-paste">Or paste CSV</label>
      <textarea id="csv-paste" bind:value={pastedCsv} maxlength="500000" placeholder="officer name,level,power\nKirk,50,120000"></textarea>
      <div class="imports-actions">
        <button class="imports-btn" onclick={() => { void analyzePastedCsv(); }} disabled={loading}>Analyze pasted CSV</button>
        <button class="imports-btn" onclick={() => { void continueManualFromPastedCsv(); }} disabled={loading}>Continue with manual mapping</button>
      </div>
    </div>
  </div>

  {#if loading}
    <p class="imports-state">Analyzing import…</p>
  {/if}

  {#if status}
    <p class="imports-state">{status}</p>
  {/if}

  {#if error}
    <p class="imports-error">{error}</p>
  {/if}

  {#if analysis}
    <div class="imports-summary">
      <span><strong>{analysis.fileName}</strong> ({analysis.format.toUpperCase()})</span>
      <span>{analysis.rowCount} data rows</span>
    </div>

    <h3 class="imports-section-title">Detected columns + sample rows</h3>
    <div class="imports-table-wrap">
      <table class="imports-table">
        <thead>
          <tr>
            {#each analysis.headers as header}
              <th>{header}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each analysis.sampleRows as row}
            <tr>
              {#each row as cell}
                <td>{cell || "—"}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <h3 class="imports-section-title">Suggested mapping (editable)</h3>
    <div class="imports-mapping-list">
      {#each analysis.suggestions as suggestion}
        <div class="imports-mapping-row">
          <div class="imports-mapping-left">
            <div class="imports-col-name">{suggestion.sourceColumn}</div>
            <div class="imports-reason">{suggestion.reason}</div>
          </div>
          <div class="imports-mapping-right">
            <span class="imports-confidence {suggestion.confidence}">{suggestion.confidence}</span>
            <select bind:value={mapping[suggestion.sourceColumn]}>
              <option value="">Skip</option>
              {#each analysis.candidateFields as field}
                <option value={field}>{field}</option>
              {/each}
            </select>
          </div>
        </div>
      {/each}
    </div>

    <div class="imports-actions">
      <button class="imports-btn" onclick={() => { void runResolve(); }} disabled={loading}>Resolve mapped rows</button>
      <button class="imports-btn" onclick={() => { void runCommit(false); }} disabled={loading || resolvedRows.length === 0}>Commit import</button>
    </div>

    {#if overwriteApproval}
      <h3 class="imports-section-title">Overwrite approval required</h3>
      <div class="imports-history">
        <p class="imports-error">This import would overwrite existing data in {overwriteApproval.overwriteCount} row(s).</p>
        <p class="imports-state">
          Proposed changes: {overwriteApproval.proposed.added} added, {overwriteApproval.proposed.updated} updated, {overwriteApproval.proposed.unchanged} unchanged.
        </p>
        <div class="imports-unresolved">
          {#each overwriteApproval.candidates.slice(0, 20) as item}
            <div class="imports-unresolved-row">
              <span><strong>{item.entityType}</strong> row {item.rowIndex + 1}: {item.refId}</span>
              <span class="imports-unresolved-candidates">Fields: {item.changedFields.join(", ")}</span>
            </div>
          {/each}
        </div>
        <div class="imports-actions">
          <button class="imports-btn" onclick={() => { void runCommit(true); }} disabled={loading}>Approve overwrite and commit</button>
        </div>
      </div>
    {/if}

    {#if unresolved.length > 0}
      <h3 class="imports-section-title">Unresolved items</h3>
      <div class="imports-unresolved">
        {#each unresolved as item}
          <div class="imports-unresolved-row">
            <strong>{item.entityType}</strong> row {item.rowIndex + 1}: {item.rawValue}
            {#if item.candidates.length > 0}
              <span class="imports-unresolved-candidates">
                Candidates: {item.candidates.map((c) => `${c.name} (${Math.round(c.score * 100)}%)`).join(", ")}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if commitResult}
      <h3 class="imports-section-title">Commit summary</h3>
      <div class="imports-summary">
        <span>Receipt #{commitResult.receiptId}</span>
        <span>{commitResult.added} added, {commitResult.updated} updated, {commitResult.unchanged} unchanged, {commitResult.unresolved} unresolved</span>
      </div>

      {#if compositionUi.showPrompt && !compositionUi.dismissed}
        <h3 class="imports-section-title">Also create crews/loadouts from this import?</h3>
        <div class="imports-history">
          <p class="imports-state">Optional step: infer bridge cores, below-deck policies, and loadouts from owned entities.</p>
          <div class="imports-actions">
            <button class="imports-btn" onclick={() => { void openCompositionPreview(); }} disabled={compositionUi.generating || loading}>Yes, show me</button>
            <button class="imports-btn" onclick={skipCompositionInference} disabled={compositionUi.generating || loading}>No thanks</button>
          </div>
        </div>
      {/if}

      {#if compositionUi.previewOpen}
        <h3 class="imports-section-title">Composition inference preview</h3>

        <div class="imports-history">
          <p class="imports-state">Review each suggestion before commit. Edit names, then keep checked to create.</p>

          <h4 class="imports-subtitle">Suggested Bridge Cores</h4>
          {#if bridgeCoreSuggestions.length === 0}
            <p class="imports-state">No bridge core suggestions found.</p>
          {:else}
            <div class="imports-unresolved">
              {#each bridgeCoreSuggestions as core}
                <label class="imports-unresolved-row">
                  <input type="checkbox" bind:checked={core.accepted} />
                  <span>Bridge Core</span>
                  <input class="imports-edit" type="text" bind:value={core.name} />
                  <span class="imports-unresolved-candidates">{core.members.map((member) => `${member.slot}: ${member.officerName}`).join(" · ")}</span>
                </label>
              {/each}
            </div>
          {/if}

          <h4 class="imports-subtitle">Suggested Below Deck Policies</h4>
          {#if belowDeckSuggestions.length === 0}
            <p class="imports-state">No below deck policy suggestions found.</p>
          {:else}
            <div class="imports-unresolved">
              {#each belowDeckSuggestions as policy}
                <label class="imports-unresolved-row">
                  <input type="checkbox" bind:checked={policy.accepted} />
                  <span>Policy ({policy.mode})</span>
                  <input class="imports-edit" type="text" bind:value={policy.name} />
                  <span class="imports-unresolved-candidates">Prefer: {(policy.spec.prefer_modifiers ?? []).join(", ") || "none"}</span>
                </label>
              {/each}
            </div>
          {/if}

          <h4 class="imports-subtitle">Suggested Loadouts</h4>
          {#if loadoutSuggestions.length === 0}
            <p class="imports-state">No loadout suggestions found.</p>
          {:else}
            <div class="imports-unresolved">
              {#each loadoutSuggestions as loadout}
                <label class="imports-unresolved-row">
                  <input type="checkbox" bind:checked={loadout.accepted} />
                  <span>Loadout · {loadout.shipName}</span>
                  <input class="imports-edit" type="text" bind:value={loadout.name} />
                  <span class="imports-unresolved-candidates">Intent: {loadout.intentKeys.join(", ") || "none"}</span>
                </label>
              {/each}
            </div>
          {/if}

          <div class="imports-actions">
            <button class="imports-btn" onclick={() => { void commitCompositionFromPreview(); }} disabled={loading}>Commit composition</button>
            <button class="imports-btn" onclick={skipCompositionInference} disabled={loading}>Skip</button>
          </div>
        </div>
      {/if}
    {/if}

  {/if}

  <h3 class="imports-section-title">Continue resolving from receipt history</h3>
  <div class="imports-history">
    <div class="imports-history-controls">
      <select
        bind:value={selectedReceiptId}
        onchange={(e) => {
          const value = (e.currentTarget as HTMLSelectElement).value;
          void loadReceiptDetail(value);
        }}
        disabled={receiptLoading}
      >
        <option value="">Select receipt…</option>
        {#each recentReceipts as receipt}
          <option value={String(receipt.id)}>
            #{receipt.id} · {new Date(receipt.createdAt).toLocaleString()} · unresolved {unresolvedCount(receipt)}
          </option>
        {/each}
      </select>
      <button class="imports-btn" onclick={() => { void loadRecentReceipts(); }} disabled={receiptLoading}>Refresh receipts</button>
    </div>

    {#if selectedReceipt}
      {#if receiptUnresolved.length === 0}
        <p class="imports-state">Receipt #{selectedReceipt.id} has no unresolved items.</p>
      {:else}
        <div class="imports-unresolved">
          {#each receiptUnresolved as item, index}
            <label class="imports-unresolved-row">
              <input type="checkbox" bind:checked={receiptSelection[String(index)]} />
              <span>
                <strong>{item.entityType}</strong> row {item.rowIndex + 1}: {item.rawValue}
              </span>
              {#if item.candidates.length > 0}
                <span class="imports-unresolved-candidates">
                  Candidates: {item.candidates.map((c) => `${c.name} (${Math.round(c.score * 100)}%)`).join(", ")}
                </span>
              {/if}
            </label>
          {/each}
        </div>
        <div class="imports-actions">
          <button class="imports-btn" onclick={() => { void resolveSelectedFromReceipt(); }} disabled={receiptLoading}>Resolve selected items</button>
        </div>
      {/if}
    {/if}
  </div>
</section>

