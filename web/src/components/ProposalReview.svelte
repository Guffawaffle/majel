<script lang="ts" module>
  /**
   * ProposalReview — Modal review overlay for safe mutation proposals (ADR-026b #93).
   *
   * Usage:
   *   import { reviewProposal } from "./ProposalReview.svelte";
   *   const result = await reviewProposal(proposal); // "apply" | "decline" | "dismiss"
   *
   * Place <ProposalReview /> once in App.svelte.
   */

  import type { ProposalSummary } from "../lib/api/proposals.js";

  export type ReviewResult = "apply" | "decline" | "dismiss";

  type Resolver = (value: ReviewResult) => void;

  let _state = $state<{ proposal: ProposalSummary; resolve: Resolver } | null>(null);

  /** Show the proposal review modal and return the user's decision. */
  export function reviewProposal(proposal: ProposalSummary): Promise<ReviewResult> {
    return new Promise<ReviewResult>((resolve) => {
      _state = { proposal, resolve };
    });
  }

  function _resolve(value: ReviewResult) {
    if (_state) {
      _state.resolve(value);
      _state = null;
    }
  }
</script>

<script lang="ts">
  import { onDestroy } from "svelte";

  // ── Expiry countdown ──
  let now = $state(Date.now());
  const timer = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(timer));

  let remaining = $derived.by(() => {
    if (!_state) return "";
    const ms = new Date(_state.proposal.expiresAt).getTime() - now;
    if (ms <= 0) return "Expired";
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  });

  let expired = $derived.by(() => {
    if (!_state) return false;
    return new Date(_state.proposal.expiresAt).getTime() - now <= 0;
  });

  // ── Helpers ──
  interface ChangeItem { refId: string; changedFields: string[] }

  type CategoryKey = "officers" | "ships" | "docks";
  const CATEGORY_LABELS: Record<CategoryKey, string> = {
    officers: "Officers",
    ships: "Ships",
    docks: "Docks",
  };

  const MAX_PREVIEW_ITEMS = 20;

  function getCategoryItems(proposal: ProposalSummary, key: CategoryKey): ChangeItem[] {
    const preview = proposal.changesPreview as Record<string, ChangeItem[]> | undefined;
    if (!preview?.[key]) return [];
    return preview[key];
  }

  function getCategorySummary(proposal: ProposalSummary, key: CategoryKey): Record<string, number> | null {
    const summary = proposal.summary as Record<string, Record<string, number>> | undefined;
    return summary?.[key] ?? null;
  }

  function formatToolName(tool: string): string {
    return tool.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Actions ──
  function apply() { _resolve("apply"); }
  function decline() { _resolve("decline"); }
  function dismiss() { _resolve("dismiss"); }

  function handleKeydown(e: KeyboardEvent) {
    if (!_state) return;
    if (e.key === "Escape") { e.preventDefault(); dismiss(); }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if _state}
  {@const proposal = _state.proposal}
  {@const categories = (["officers", "ships", "docks"] as CategoryKey[]).filter(
    k => getCategoryItems(proposal, k).length > 0 || getCategorySummary(proposal, k) !== null
  )}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="review-overlay" onclick={dismiss}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="review-dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Review Changes — {formatToolName(proposal.tool)}" tabindex="-1">

      <!-- Header -->
      <div class="review-header">
        <div class="review-header-left">
          <span class="review-icon">📋</span>
          <div>
            <div class="review-title">Review Changes — {formatToolName(proposal.tool)}</div>
            <div class="review-subtitle">Proposal {proposal.id.slice(0, 8)}… · {proposal.status}</div>
          </div>
        </div>
        <button class="review-close" onclick={dismiss} aria-label="Close">×</button>
      </div>

      <!-- Summary -->
      {#if proposal.summary}
        <div class="review-section">
          <div class="review-section-heading">Summary</div>
          <div class="review-summary-grid">
            {#each categories as cat}
              {@const s = getCategorySummary(proposal, cat)}
              {#if s}
                <div class="summary-row">
                  <span class="summary-label">{CATEGORY_LABELS[cat]}</span>
                  <span class="summary-stats">
                    {#if s.changed != null}<span class="stat changed">{s.changed} changed</span>{/if}
                    {#if s.unchanged != null}<span class="stat">{s.unchanged} unchanged</span>{/if}
                    {#if s.skipped != null}<span class="stat">{s.skipped} skipped</span>{/if}
                    {#if s.applied != null}<span class="stat">{s.applied} applied</span>{/if}
                    {#if s.input != null}<span class="stat muted">{s.input} input</span>{/if}
                  </span>
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      <!-- Changes Preview -->
      {#if proposal.changesPreview}
        <div class="review-section">
          <div class="review-section-heading">Changes Preview</div>
          {#each categories as cat}
            {@const items = getCategoryItems(proposal, cat)}
            {#if items.length > 0}
              <div class="category-block">
                <div class="category-heading">{CATEGORY_LABELS[cat]} ({items.length} change{items.length !== 1 ? "s" : ""})</div>
                <div class="change-list">
                  {#each items.slice(0, MAX_PREVIEW_ITEMS) as item}
                    <div class="change-item">
                      <span class="change-ref">{item.refId}</span>
                      <span class="change-fields">
                        {#each item.changedFields as field}
                          <span class="field-badge">{field}</span>
                        {/each}
                      </span>
                    </div>
                  {/each}
                  {#if items.length > MAX_PREVIEW_ITEMS}
                    <div class="change-overflow">… and {items.length - MAX_PREVIEW_ITEMS} more</div>
                  {/if}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      <!-- Risk -->
      {#if proposal.risk}
        <div class="review-section risk-section">
          <div class="review-section-heading risk-heading">
            ⚠ Risk ({proposal.risk.warnings.length} warning{proposal.risk.warnings.length !== 1 ? "s" : ""})
          </div>
          {#if proposal.risk.bulkCount > 0}
            <div class="risk-bulk">Bulk operation: {proposal.risk.bulkCount} items affected</div>
          {/if}
          {#if proposal.risk.warnings.length > 0}
            <ul class="risk-warnings">
              {#each proposal.risk.warnings as warning}
                <li>{warning}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <!-- Expiry -->
      <div class="review-expiry" class:expired>
        {#if expired}
          ⏰ Proposal has expired
        {:else}
          ⏱ Expires in {remaining}
        {/if}
      </div>

      <!-- Actions -->
      <div class="review-actions">
        <button class="review-btn decline" onclick={decline}>Decline</button>
        <button class="review-btn apply" onclick={apply} disabled={expired}>Apply Changes</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Overlay ── */
  .review-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: review-fade-in 0.15s ease;
  }

  /* ── Dialog ── */
  .review-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 24px;
    max-width: 560px;
    width: 92vw;
    max-height: 85vh;
    overflow-y: auto;
    animation: review-slide-in 0.2s ease;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  /* ── Header ── */
  .review-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .review-header-left {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .review-icon {
    font-size: 1.5rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .review-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .review-subtitle {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .review-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.4rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    transition: color var(--transition);
  }
  .review-close:hover { color: var(--text-primary); }

  /* ── Sections ── */
  .review-section {
    margin-bottom: 12px;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .review-section-heading {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ── Summary Grid ── */
  .review-summary-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .summary-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.82rem;
  }
  .summary-label {
    font-weight: 500;
    color: var(--text-primary);
    min-width: 70px;
  }
  .summary-stats {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .stat {
    color: var(--text-muted);
    font-size: 0.78rem;
  }
  .stat.changed {
    color: var(--accent-gold);
    font-weight: 500;
  }
  .stat.muted {
    opacity: 0.6;
  }

  /* ── Category Blocks ── */
  .category-block {
    margin-bottom: 8px;
  }
  .category-block:last-child { margin-bottom: 0; }
  .category-heading {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 4px;
  }

  /* ── Change List ── */
  .change-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .change-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78rem;
    padding: 3px 6px;
    border-radius: 3px;
    background: var(--bg-primary);
  }
  .change-ref {
    font-weight: 500;
    color: var(--text-primary);
    font-family: monospace;
    font-size: 0.76rem;
    flex-shrink: 0;
  }
  .change-fields {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .field-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-gold);
    color: var(--bg-primary);
    font-size: 0.7rem;
    font-weight: 500;
  }
  .change-overflow {
    font-size: 0.76rem;
    color: var(--text-muted);
    font-style: italic;
    padding: 2px 6px;
  }

  /* ── Risk ── */
  .risk-section {
    border-color: var(--accent-red, #e74c3c);
  }
  .risk-heading {
    color: var(--accent-red, #e74c3c);
  }
  .risk-bulk {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .risk-warnings {
    margin: 0;
    padding-left: 18px;
    font-size: 0.78rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ── Expiry ── */
  .review-expiry {
    font-size: 0.8rem;
    color: var(--text-muted);
    text-align: center;
    margin-bottom: 14px;
    padding: 6px;
    border-radius: 4px;
    background: var(--bg-secondary);
  }
  .review-expiry.expired {
    color: var(--accent-red, #e74c3c);
    font-weight: 600;
  }

  /* ── Actions ── */
  .review-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .review-btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 500;
    transition: all var(--transition);
  }
  .review-btn.decline {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }
  .review-btn.decline:hover { background: var(--bg-tertiary); }
  .review-btn.apply {
    background: var(--accent-gold);
    color: var(--bg-primary);
    border-color: var(--accent-gold);
  }
  .review-btn.apply:hover { background: var(--accent-gold-bright, #ffd54f); }
  .review-btn.apply:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Animations ── */
  @keyframes review-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes review-slide-in {
    from { transform: translateY(-20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
