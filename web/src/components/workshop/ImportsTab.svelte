<script lang="ts">
  import { onMount } from "svelte";
  import {
    analyzeImportFile,
    commitImportRows,
    mapImportRows,
    parseImportFile,
    resolveImportRows,
  } from "../../lib/api/imports.js";
  import {
    fetchReceipt,
    fetchReceipts,
    resolveReceiptItems,
  } from "../../lib/api/receipts.js";
  import { ApiError } from "../../lib/api/fetch.js";
  import type {
    ImportAnalysis,
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
  let format = $state<"csv" | "xlsx">("csv");
  let pastedCsv = $state("");
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

  onMount(() => {
    void loadRecentReceipts();
  });

  async function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    fileName = file.name;
    format = file.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv";
    error = "";

    try {
      const base64 = await fileToBase64(file);
      await runAnalyzeAndParse({ fileName, contentBase64: base64, format });
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

  async function runAnalyzeAndParse(input: { fileName: string; contentBase64: string; format: "csv" | "xlsx" }) {
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

  function unresolvedCount(receipt: ImportReceipt): number {
    return Array.isArray(receipt.unresolved) ? receipt.unresolved.length : 0;
  }

  function coerceUnresolved(unresolvedValue: unknown[] | null): UnresolvedImportItem[] {
    if (!Array.isArray(unresolvedValue)) return [];

    return unresolvedValue
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        rowIndex: Number(item.rowIndex ?? -1),
        entityType: (item.entityType === "ship" ? "ship" : "officer") as "officer" | "ship",
        rawValue: String(item.rawValue ?? ""),
        candidates: Array.isArray(item.candidates)
          ? item.candidates
            .filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null)
            .map((candidate) => ({
              id: String(candidate.id ?? ""),
              name: String(candidate.name ?? ""),
              score: Number(candidate.score ?? 0),
            }))
          : [],
      }))
      .filter((item) => item.rawValue.length > 0 && item.rowIndex >= 0);
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("Unexpected file payload"));
          return;
        }
        const base64 = result.split(",")[1] ?? "";
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  function utf8ToBase64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
</script>

<section class="imports">
  <h2 class="imports-title">Imports</h2>
  <p class="imports-subtitle">Upload CSV/XLSX or paste CSV to get AI-assisted column mapping with editable choices.</p>

  <div class="imports-inputs">
    <label class="imports-upload">
      <span>Choose CSV/XLSX</span>
      <input type="file" accept=".csv,.xlsx" onchange={onFileChange} />
    </label>

    <div class="imports-paste">
      <label for="csv-paste">Or paste CSV</label>
      <textarea id="csv-paste" bind:value={pastedCsv} placeholder="officer name,level,power\nKirk,50,120000"></textarea>
      <button class="imports-btn" onclick={() => { void analyzePastedCsv(); }} disabled={loading}>Analyze pasted CSV</button>
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

<style>
  .imports {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .imports-title {
    margin: 0;
    font-size: 18px;
    color: var(--text-primary);
  }

  .imports-subtitle {
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }

  .imports-inputs {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .imports-upload {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .imports-upload input,
  .imports-paste textarea,
  .imports-mapping-right select {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 8px;
    font: inherit;
  }

  .imports-paste {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .imports-paste label {
    font-size: 13px;
    color: var(--text-secondary);
  }

  .imports-paste textarea {
    min-height: 96px;
    resize: vertical;
  }

  .imports-btn {
    align-self: flex-start;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    cursor: pointer;
  }

  .imports-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .imports-state {
    margin: 0;
    color: var(--text-muted);
  }

  .imports-error {
    margin: 0;
    color: var(--accent-red, #f44);
  }

  .imports-summary {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-size: 13px;
  }

  .imports-section-title {
    margin: 8px 0 0;
    font-size: 14px;
    color: var(--text-primary);
  }

  .imports-table-wrap {
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .imports-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .imports-table th,
  .imports-table td {
    border-bottom: 1px solid var(--border);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }

  .imports-table th {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .imports-table td {
    color: var(--text-secondary);
  }

  .imports-mapping-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .imports-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .imports-mapping-row {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }

  .imports-mapping-left {
    min-width: 0;
  }

  .imports-col-name {
    font-size: 13px;
    color: var(--text-primary);
    font-weight: 600;
  }

  .imports-reason {
    font-size: 12px;
    color: var(--text-muted);
  }

  .imports-mapping-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .imports-confidence {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .imports-confidence.high {
    color: var(--accent-green);
  }

  .imports-confidence.medium {
    color: var(--accent-gold);
  }

  .imports-confidence.low {
    color: var(--accent-red, #f44);
  }

  .imports-unresolved {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .imports-unresolved-row {
    font-size: 12px;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .imports-unresolved-candidates {
    color: var(--text-muted);
  }

  .imports-history {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .imports-history-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .imports-history-controls select {
    min-width: 320px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 8px;
    font: inherit;
  }
</style>
