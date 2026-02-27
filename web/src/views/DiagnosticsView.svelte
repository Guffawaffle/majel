<script lang="ts">
  /**
   * DiagnosticsView — System health, data summary, query console & schema browser.
   * Admiral-gated (router enforces role check).
   */
  import { onMount } from "svelte";
  import {
    fetchDiagnosticHealth,
    fetchDiagnosticSummary,
    fetchDiagnosticSchema,
    executeDiagnosticQuery,
  } from "../lib/api/diagnostic.js";
  import "../styles/diagnostics-view.css";
  import { getCacheMetrics, resetCacheMetrics, getCacheReady, cacheClear } from "../lib/cache/index.js";
  import type { CacheMetrics } from "../lib/cache/index.js";
  import type {
    DiagnosticHealth,
    DiagnosticSummary,
    DiagnosticSchema,
    DiagnosticSchemaTable,
    QueryResult,
  } from "../lib/types.js";

  // ── State ──

  type Tab = "health" | "summary" | "query" | "schema" | "cache";
  let activeTab = $state<Tab>("health");
  let loading = $state(true);
  let error = $state("");

  let healthData = $state<DiagnosticHealth | null>(null);
  let summaryData = $state<DiagnosticSummary | null>(null);
  let schemaData = $state<DiagnosticSchema | null>(null);
  let schemaLoaded = $state(false);
  let cacheMetrics = $state<CacheMetrics | null>(null);

  // Query console
  let sqlInput = $state("");
  let queryResult = $state<QueryResult | null>(null);
  let queryError = $state("");
  let queryRunning = $state(false);
  let queryHistory = $state<string[]>([]);

  // Schema browser — which tables are expanded
  let expandedTables = $state<Set<string>>(new Set());

  const PRESET_QUERIES = [
    { label: "All Officers", sql: "SELECT id, name, rarity, group_name FROM reference_officers ORDER BY name LIMIT 50" },
    { label: "All Ships", sql: "SELECT id, name, ship_class, rarity, faction FROM reference_ships ORDER BY name LIMIT 50" },
    { label: "Ownership Stats", sql: "SELECT ownership_state, COUNT(*) AS count FROM officer_overlay GROUP BY ownership_state" },
    { label: "Recent Overlays", sql: "SELECT o.id, r.name, o.ownership_state, o.updated_at FROM officer_overlay o JOIN reference_officers r ON o.officer_id = r.id ORDER BY o.updated_at DESC LIMIT 20" },
    { label: "Ship Overlays", sql: "SELECT o.id, r.name, o.ownership_state, o.updated_at FROM ship_overlay o JOIN reference_ships r ON o.ship_id = r.id ORDER BY o.updated_at DESC LIMIT 20" },
    { label: "Dock Summary", sql: "SELECT d.dock_number, d.label, COUNT(ds.id) AS ship_count FROM docks d LEFT JOIN dock_ships ds ON d.id = ds.dock_id GROUP BY d.dock_number, d.label ORDER BY d.dock_number" },
  ] as const;

  // ── Lifecycle ──

  onMount(() => { refresh(); });

  async function refresh() {
    loading = true;
    error = "";
    try {
      const [h, s] = await Promise.all([
        fetchDiagnosticHealth(),
        fetchDiagnosticSummary(),
      ]);
      healthData = h;
      summaryData = s;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load diagnostics.";
    } finally {
      loading = false;
    }
  }

  async function switchTab(tab: Tab) {
    activeTab = tab;
    if (tab === "schema" && !schemaLoaded) {
      try {
        schemaData = await fetchDiagnosticSchema();
        schemaLoaded = true;
      } catch (err: unknown) {
        error = err instanceof Error ? err.message : "Failed to load schema.";
      }
    }
    if (tab === "cache") {
      cacheMetrics = getCacheMetrics();
    }
  }

  function refreshCacheMetrics() {
    cacheMetrics = getCacheMetrics();
  }

  async function handleClearCache() {
    await cacheClear();
    resetCacheMetrics();
    cacheMetrics = getCacheMetrics();
  }

  // ── Query Console ──

  async function runQuery(sql: string) {
    if (!sql.trim()) return;
    sqlInput = sql;
    queryError = "";
    queryRunning = true;
    queryResult = null;
    try {
      queryResult = await executeDiagnosticQuery(sql, 200);
      // Prepend to history (unique, max 20)
      queryHistory = [sql, ...queryHistory.filter((q) => q !== sql)].slice(0, 20);
    } catch (err: unknown) {
      queryError = err instanceof Error ? err.message : "Query failed.";
    } finally {
      queryRunning = false;
    }
  }

  function handleQueryKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery(sqlInput);
    }
  }

  // ── Schema Browser ──

  function toggleTable(name: string) {
    const next = new Set(expandedTables);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    expandedTables = next;
  }

  // ── Helpers ──

  function statusClass(val: string): string {
    const lc = String(val).toLowerCase();
    if (lc === "connected" || lc === "active" || lc === "online" || lc === "true") return "diag-ok";
    if (lc === "not configured" || lc === "false") return "diag-warn";
    return "";
  }

  function renderValue(val: unknown): string {
    if (val == null) return "—";
    if (typeof val === "boolean") return val ? "Yes" : "No";
    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return "[unserializable object]";
      }
    }
    return String(val);
  }
</script>

<section class="diagnostics">
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="diag-tabs" role="tablist">
    <button class="diag-tab" class:active={activeTab === "health"} onclick={() => switchTab("health")} role="tab" aria-selected={activeTab === "health"}>💓 System Health</button>
    <button class="diag-tab" class:active={activeTab === "summary"} onclick={() => switchTab("summary")} role="tab" aria-selected={activeTab === "summary"}>📊 Data Summary</button>
    <button class="diag-tab" class:active={activeTab === "query"} onclick={() => switchTab("query")} role="tab" aria-selected={activeTab === "query"}>🔍 Query Console</button>
    <button class="diag-tab" class:active={activeTab === "schema"} onclick={() => switchTab("schema")} role="tab" aria-selected={activeTab === "schema"}>🗂️ Schema Browser</button>
    <button class="diag-tab" class:active={activeTab === "cache"} onclick={() => switchTab("cache")} role="tab" aria-selected={activeTab === "cache"}>⚡ Cache</button>
  </nav>

  {#if error}
    <div class="diag-error" role="alert">
      <span>⚠ {error}</span>
      <button class="diag-retry-btn" onclick={() => { error = ""; refresh(); }}>Retry</button>
    </div>
  {/if}

  {#if loading}
    <div class="diag-loading">Loading diagnostics…</div>

  {:else if activeTab === "health" && healthData}
    {@render healthSection(healthData)}

  {:else if activeTab === "summary" && summaryData}
    {@render summarySection(summaryData)}

  {:else if activeTab === "query"}
    {@render querySection()}

  {:else if activeTab === "schema"}
    {@render schemaSection()}

  {:else if activeTab === "cache"}
    {@render cacheSection()}
  {/if}
</section>

<!-- ── Snippets ── -->

{#snippet healthSection(h: DiagnosticHealth)}
  <div class="diag-grid">
    {@render healthGroup("System", [
      ["Version", h.system.version],
      ["Uptime", h.system.uptime],
      ...(h.system.nodeVersion ? [["Node", h.system.nodeVersion] as [string, string]] : []),
      ["Timestamp", h.system.timestamp],
      ["Startup Complete", h.system.startupComplete ? "Yes" : "No"],
    ])}
    {@render healthGroup("Gemini Engine", [
      ["Status", h.gemini.status],
      ...(h.gemini.model ? [["Model", h.gemini.model] as [string, string]] : []),
      ...(h.gemini.activeSessions != null ? [["Active Sessions", String(h.gemini.activeSessions)] as [string, string]] : []),
    ])}
    {@render healthGroup("Lex Memory", [
      ["Status", h.memory.status],
      ...(h.memory.frameCount != null ? [["Frame Count", String(h.memory.frameCount)] as [string, string]] : []),
      ...(h.memory.dbPath ? [["DB Path", h.memory.dbPath] as [string, string]] : []),
    ])}
    {@render healthGroup("Settings Store", [
      ["Status", h.settings.status],
      ...(h.settings.userOverrides != null ? [["User Overrides", String(h.settings.userOverrides)] as [string, string]] : []),
    ])}
    {@render healthGroup("Sessions", [
      ["Status", h.sessions.status],
      ...(h.sessions.count != null ? [["Count", String(h.sessions.count)] as [string, string]] : []),
    ])}
    {@render storeGroup("Reference Store", h.referenceStore)}
    {@render storeGroup("Overlay Store", h.overlayStore)}
    {@render storeGroup("Crew Store", h.crewStore)}
  </div>
{/snippet}

{#snippet healthGroup(title: string, rows: [string, string][])}
  <div class="diag-section">
    <h4>{title}</h4>
    {#each rows as [label, val]}
      <div class="diag-row">
        <span>{label}</span>
        <span class={statusClass(val)}>{val}</span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet storeGroup(title: string, store: { status: string; [key: string]: unknown })}
  <div class="diag-section">
    <h4>{title}</h4>
    {#each Object.entries(store) as [k, v]}
      {@const displayValue = renderValue(v)}
      <div class="diag-row">
        <span>{k}</span>
        <span class={statusClass(displayValue)}>{displayValue}</span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet summarySection(s: DiagnosticSummary)}
  <div class="diag-summary-grid">
    {@render summaryCard("Officers", s.reference.officers.total, s.reference.officers.byRarity.map((r) => [r.rarity ?? "Unknown", Number(r.count)]))}
    {@render summaryCard("Ships", s.reference.ships.total, s.reference.ships.byClass.map((r) => [r.ship_class ?? "Unknown", Number(r.count)]))}
    {@render summaryCard("Officer Overlays", s.overlay.officers.total, s.overlay.officers.byOwnership.map((r) => [r.ownership_state, Number(r.count)]))}
    {@render summaryCard("Ship Overlays", s.overlay.ships.total, s.overlay.ships.byOwnership.map((r) => [r.ownership_state, Number(r.count)]))}
  </div>

  {#if s.samples.officers.length > 0 || s.samples.ships.length > 0}
    <div class="diag-section" style="margin-top: 16px;">
      <h4>Sample Data</h4>
      {#if s.samples.officers.length > 0}
        <p class="diag-muted">Officers (first 5)</p>
        {@render sampleTable(s.samples.officers)}
      {/if}
      {#if s.samples.ships.length > 0}
        <p class="diag-muted" style="margin-top: 8px;">Ships (first 5)</p>
        {@render sampleTable(s.samples.ships)}
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet summaryCard(title: string, total: number, breakdown: [string, number][])}
  <div class="diag-summary-card">
    <div class="diag-summary-header">
      <span class="diag-summary-title">{title}</span>
      <span class="diag-badge">{total}</span>
    </div>
    {#if breakdown.length > 0}
      <div class="diag-breakdown">
        {#each breakdown as [label, count]}
          <div class="diag-breakdown-row">
            <span>{label}</span>
            <span>{count}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet sampleTable(rows: Record<string, unknown>[])}
  {#if rows.length > 0}
    <div class="diag-table-wrap">
      <table class="diag-table">
        <thead>
          <tr>{#each Object.keys(rows[0]) as col}<th>{col}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each rows as row}
            <tr>{#each Object.values(row) as val}<td>{val == null ? "—" : String(val)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

{#snippet querySection()}
  <div class="diag-presets">
    {#each PRESET_QUERIES as p}
      <button class="diag-preset-btn" onclick={() => runQuery(p.sql)}>{p.label}</button>
    {/each}
  </div>

  <div class="diag-query-input">
    <textarea
      class="diag-sql-textarea"
      rows="3"
      maxlength="10000"
      spellcheck="false"
      placeholder="SELECT … FROM reference_officers LIMIT 50"
      bind:value={sqlInput}
      onkeydown={handleQueryKeydown}
    ></textarea>
    <button class="diag-run-btn" onclick={() => runQuery(sqlInput)} disabled={queryRunning}>
      {queryRunning ? "Running…" : "▶ Run Query"}
    </button>
  </div>

  {#if queryError}
    <p class="diag-error">{queryError}</p>
  {/if}

  {#if queryResult}
    <div class="diag-query-meta">
      {queryResult.rowCount} row(s) in {queryResult.durationMs}ms
      {#if queryResult.truncated}
        <span class="diag-warn">(truncated from {queryResult.totalBeforeLimit})</span>
      {/if}
    </div>
    <div class="diag-table-wrap">
      <table class="diag-table">
        <thead>
          <tr>{#each queryResult.columns as col}<th>{col}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each queryResult.rows as row}
            <tr>
              {#each queryResult.columns as col}
                <td class:diag-null={row[col] == null}>{row[col] == null ? "NULL" : String(row[col])}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/snippet}

{#snippet schemaSection()}
  {#if !schemaData}
    <div class="diag-loading">Loading schema…</div>
  {:else}
    {#each schemaData.tables as t (t.table)}
      {@render schemaTable(t)}
    {/each}
  {/if}
{/snippet}

{#snippet schemaTable(t: DiagnosticSchemaTable)}
  <div class="diag-schema-table">
    <button class="diag-schema-header" onclick={() => toggleTable(t.table)}>
      <span class="diag-schema-toggle">{expandedTables.has(t.table) ? "▼" : "▶"}</span>
      <span class="diag-schema-name">{t.table}</span>
      <span class="diag-badge">{t.rowCount} rows</span>
    </button>
    {#if expandedTables.has(t.table)}
      <div class="diag-schema-detail">
        <table class="diag-table">
          <thead>
            <tr><th>Column</th><th>Type</th><th>Nullable</th><th>PK</th><th>Default</th></tr>
          </thead>
          <tbody>
            {#each t.columns as col}
              <tr>
                <td>{col.name}</td>
                <td>{col.type}</td>
                <td>{col.nullable ? "Yes" : "No"}</td>
                <td>{col.primaryKey ? "🔑" : ""}</td>
                <td class:diag-null={!col.defaultValue}>{col.defaultValue ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if t.indexes.length > 0}
          <div class="diag-indexes">
            {#each t.indexes as idx}
              <span class="diag-index" class:diag-index-unique={idx.unique}>
                {idx.unique ? "🔒" : "📇"} {idx.name}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet cacheSection()}
  <div class="diag-grid">
    <div class="diag-section">
      <h4>Cache Status</h4>
      <div class="diag-row">
        <span>Status</span>
        <span class={getCacheReady() ? "diag-ok" : "diag-warn"}>{getCacheReady() ? "Connected" : "Unavailable"}</span>
      </div>
      <div class="diag-row">
        <span>Purge Window</span>
        <span>7 days</span>
      </div>
    </div>
    {#if cacheMetrics}
      <div class="diag-section">
        <h4>Performance</h4>
        <div class="diag-row">
          <span>Total Requests</span>
          <span>{cacheMetrics.total}</span>
        </div>
        <div class="diag-row">
          <span>Cache Hits</span>
          <span class="diag-ok">{cacheMetrics.hits}</span>
        </div>
        <div class="diag-row">
          <span>Cache Misses</span>
          <span>{cacheMetrics.misses}</span>
        </div>
        <div class="diag-row">
          <span>Revalidations</span>
          <span>{cacheMetrics.revalidations}</span>
        </div>
        <div class="diag-row">
          <span>Hit Rate</span>
          <span class={cacheMetrics.hitRate > 0.5 ? "diag-ok" : ""}>{(cacheMetrics.hitRate * 100).toFixed(1)}%</span>
        </div>
        <div class="diag-row">
          <span>Est. Bandwidth Saved</span>
          <span>{cacheMetrics.bytesSaved > 1024 ? `${(cacheMetrics.bytesSaved / 1024).toFixed(1)} KB` : `${cacheMetrics.bytesSaved} B`}</span>
        </div>
      </div>
    {/if}
  </div>
  <div class="diag-cache-actions">
    <button class="diag-preset-btn" onclick={refreshCacheMetrics}>↻ Refresh Metrics</button>
    <button class="diag-preset-btn diag-cache-clear" onclick={handleClearCache}>🗑 Clear Cache</button>
  </div>
{/snippet}

