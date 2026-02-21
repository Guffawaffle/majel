<script lang="ts">
  import { onMount } from "svelte";
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
  import type {
    ImportAnalysis,
    CatalogOfficer,
    CatalogShip,
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
  let format = $state<"csv">("csv");
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
  let showCompositionPrompt = $state(false);
  let compositionPromptDismissed = $state(false);
  let compositionGenerating = $state(false);
  let compositionPreviewOpen = $state(false);
  let bridgeCoreSuggestions = $state<CompositionBridgeCoreSuggestion[]>([]);
  let belowDeckSuggestions = $state<CompositionBelowDeckPolicySuggestion[]>([]);
  let loadoutSuggestions = $state<CompositionLoadoutSuggestion[]>([]);

  onMount(() => {
    void loadRecentReceipts();
  });

  async function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    fileName = file.name;
    if (file.name.toLowerCase().endsWith(".xlsx")) {
      error = "XLSX files are not supported. Please convert to CSV before importing.";
      return;
    }
    format = "csv";
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

  async function runAnalyzeAndParse(input: { fileName: string; contentBase64: string; format: "csv" }) {
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
      showCompositionPrompt = true;
      compositionPromptDismissed = false;
      compositionPreviewOpen = false;
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
    compositionGenerating = true;
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
      compositionPreviewOpen = true;
      showCompositionPrompt = false;
      status = "Composition preview generated. Review suggestions before commit.";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      compositionGenerating = false;
    }
  }

  function skipCompositionInference() {
    compositionPromptDismissed = true;
    showCompositionPrompt = false;
    compositionPreviewOpen = false;
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
      compositionPreviewOpen = false;
      showCompositionPrompt = false;
      compositionPromptDismissed = true;
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

  function rarityScore(value: string | null): number {
    const normalized = String(value ?? "").toLowerCase();
    if (normalized.includes("legendary")) return 5;
    if (normalized.includes("epic")) return 4;
    if (normalized.includes("rare")) return 3;
    if (normalized.includes("uncommon")) return 2;
    if (normalized.includes("common")) return 1;
    return 0;
  }

  function inferIntentFromShipClass(shipClass: string | null): "combat" | "mining" | "hostile" {
    const normalized = String(shipClass ?? "").toLowerCase();
    if (normalized.includes("survey")) return "mining";
    if (normalized.includes("interceptor") || normalized.includes("battleship") || normalized.includes("explorer")) return "combat";
    return "hostile";
  }

  function policyForIntent(intent: "combat" | "mining" | "hostile", index: number): CompositionBelowDeckPolicySuggestion {
    if (intent === "mining") {
      return {
        key: `policy-mining-${index}`,
        accepted: true,
        name: "Mining BD",
        mode: "stats_then_bda",
        spec: { prefer_modifiers: ["mining_rate", "protected_cargo", "warp_range"], avoid_reserved: true, max_slots: 5 },
      };
    }
    if (intent === "hostile") {
      return {
        key: `policy-hostile-${index}`,
        accepted: true,
        name: "Hostile BD",
        mode: "stats_then_bda",
        spec: { prefer_modifiers: ["damage_vs_hostiles", "critical_damage", "mitigation"], avoid_reserved: true, max_slots: 5 },
      };
    }
    return {
      key: `policy-combat-${index}`,
      accepted: true,
      name: "Combat BD",
      mode: "stats_then_bda",
      spec: { prefer_modifiers: ["attack", "critical_chance", "critical_damage"], avoid_reserved: true, max_slots: 5 },
    };
  }

  function buildCompositionSuggestions(officers: CatalogOfficer[], ships: CatalogShip[]): {
    bridgeCores: CompositionBridgeCoreSuggestion[];
    policies: CompositionBelowDeckPolicySuggestion[];
    loadouts: CompositionLoadoutSuggestion[];
  } {
    const ownedOfficers = officers.filter((officer) => officer.ownershipState === "owned");
    const ownedShips = ships.filter((ship) => ship.ownershipState === "owned");

    const byGroup = new Map<string, CatalogOfficer[]>();
    for (const officer of ownedOfficers) {
      const groupName = officer.groupName?.trim();
      if (!groupName) continue;
      const key = groupName.toLowerCase();
      const current = byGroup.get(key) ?? [];
      current.push(officer);
      byGroup.set(key, current);
    }

    const bridgeCores: CompositionBridgeCoreSuggestion[] = [];
    const officerById = new Map<string, CatalogOfficer>();
    for (const officer of ownedOfficers) officerById.set(officer.id, officer);

    let bridgeCoreIndex = 0;
    for (const [groupKey, members] of byGroup.entries()) {
      if (members.length < 3) continue;
      const cmCapable = members.filter((officer) => (officer.captainManeuver ?? "").trim().length > 0);
      if (cmCapable.length === 0) continue;

      const sorted = [...members].sort((left, right) => {
        const rarityDiff = rarityScore(right.rarity) - rarityScore(left.rarity);
        if (rarityDiff !== 0) return rarityDiff;
        return (right.userLevel ?? 0) - (left.userLevel ?? 0);
      });
      const captain = [...cmCapable].sort((left, right) => {
        const rarityDiff = rarityScore(right.rarity) - rarityScore(left.rarity);
        if (rarityDiff !== 0) return rarityDiff;
        return (right.userLevel ?? 0) - (left.userLevel ?? 0);
      })[0];

      const remainder = sorted.filter((officer) => officer.id !== captain.id).slice(0, 2);
      if (remainder.length < 2) continue;
      const selected = [captain, ...remainder];

      bridgeCores.push({
        key: `core-${bridgeCoreIndex++}`,
        accepted: true,
        name: `${selected[0].groupName ?? groupKey} Trio`,
        members: [
          { officerId: selected[0].id, officerName: selected[0].name, slot: "captain" },
          { officerId: selected[1].id, officerName: selected[1].name, slot: "bridge_1" },
          { officerId: selected[2].id, officerName: selected[2].name, slot: "bridge_2" },
        ],
      });

      if (bridgeCores.length >= 5) break;
    }

    const intents = [...new Set(ownedShips.map((ship) => inferIntentFromShipClass(ship.shipClass)))];
    const policies = intents.slice(0, 3).map((intent, index) => policyForIntent(intent, index));

    const loadouts: CompositionLoadoutSuggestion[] = [];
    let loadoutIndex = 0;
    for (const core of bridgeCores) {
      const captain = core.members.find((member) => member.slot === "captain");
      const captainOfficer = captain ? officerById.get(captain.officerId) : undefined;
      const captainFaction = String(captainOfficer?.faction?.name ?? "").toLowerCase();

      const scoredShips = [...ownedShips].map((ship) => {
        const intent = inferIntentFromShipClass(ship.shipClass);
        const policy = policies.find((entry) => entry.key.includes(intent));
        let score = 0;
        if (captainFaction.length > 0 && String(ship.faction ?? "").toLowerCase().includes(captainFaction)) score += 5;
        if (intent === "combat" && /interceptor|battleship|explorer/i.test(String(ship.shipClass ?? ""))) score += 3;
        if (intent === "mining" && /survey/i.test(String(ship.shipClass ?? ""))) score += 3;
        if (intent === "hostile") score += 1;
        score += ship.userTier ?? 0;
        return { ship, intent, policyKey: policy?.key, score };
      });

      scoredShips.sort((left, right) => right.score - left.score);
      const selected = scoredShips[0];
      if (!selected) continue;

      loadouts.push({
        key: `loadout-${loadoutIndex++}`,
        accepted: true,
        name: `${selected.ship.name} ${core.name}`,
        shipId: selected.ship.id,
        shipName: selected.ship.name,
        bridgeCoreKey: core.key,
        belowDeckPolicyKey: selected.policyKey,
        intentKeys: [selected.intent],
        tags: ["import-inferred"],
      });
    }

    return { bridgeCores, policies, loadouts };
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
  <p class="imports-subtitle">Upload CSV or paste data to get AI-assisted column mapping with editable choices.</p>

  <div class="imports-inputs">
    <label class="imports-upload">
      <span>Choose CSV</span>
      <input type="file" accept=".csv" onchange={onFileChange} />
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

      {#if showCompositionPrompt && !compositionPromptDismissed}
        <h3 class="imports-section-title">Also create crews/loadouts from this import?</h3>
        <div class="imports-history">
          <p class="imports-state">Optional step: infer bridge cores, below-deck policies, and loadouts from owned entities.</p>
          <div class="imports-actions">
            <button class="imports-btn" onclick={() => { void openCompositionPreview(); }} disabled={compositionGenerating || loading}>Yes, show me</button>
            <button class="imports-btn" onclick={skipCompositionInference} disabled={compositionGenerating || loading}>No thanks</button>
          </div>
        </div>
      {/if}

      {#if compositionPreviewOpen}
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

  .imports-edit {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font: inherit;
    min-width: 220px;
  }
</style>
