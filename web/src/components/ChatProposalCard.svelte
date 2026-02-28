<!--
  ChatProposalCard — inline approval card for batched approve-tier mutations.
  Rendered within ChatMessage when Aria stages mutations for user review.
-->
<script lang="ts">
  import type { ChatProposal } from "../lib/types.js";
  import { applyProposal, declineProposal } from "../lib/api/proposals.js";
  import { onDestroy } from "svelte";

  interface Props {
    proposal: ChatProposal;
  }

  let { proposal }: Props = $props();

  // ── Card state ──
  type CardState = "pending" | "applying" | "applied" | "declined" | "error" | "expired";
  let cardState = $state<CardState>("pending");
  let errorMsg = $state("");

  // ── Expiry countdown ──
  let now = $state(Date.now());
  const timer = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(timer));

  let remainingMs = $derived(new Date(proposal.expiresAt).getTime() - now);

  let remaining = $derived.by(() => {
    if (remainingMs <= 0) return "Expired";
    const mins = Math.floor(remainingMs / 60_000);
    const secs = Math.floor((remainingMs % 60_000) / 1000);
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  });

  let expired = $derived(remainingMs <= 0);

  // Auto-expire cards that were pending
  $effect(() => {
    if (expired && cardState === "pending") {
      cardState = "expired";
    }
  });

  // ── Tool icons ──
  function toolIcon(tool: string): string {
    if (tool.includes("dock") || tool.includes("assign")) return "⚓";
    if (tool.includes("bridge") || tool.includes("core")) return "🎖";
    if (tool.includes("loadout")) return "📦";
    if (tool.includes("variant")) return "🔀";
    if (tool.includes("reservation") || tool.includes("reserve")) return "🔒";
    if (tool.includes("officer") || tool.includes("crew")) return "👤";
    if (tool.includes("ship")) return "🚀";
    if (tool.includes("sync")) return "🔄";
    return "⚙";
  }

  // ── Actions ──
  async function handleApply() {
    cardState = "applying";
    try {
      await applyProposal(proposal.id);
      cardState = "applied";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to apply";
      cardState = "error";
    }
  }

  async function handleDecline() {
    try {
      await declineProposal(proposal.id);
      cardState = "declined";
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : "Failed to decline";
      cardState = "error";
    }
  }
</script>

<div class="proposal-card" class:resolved={cardState !== "pending"}>
  <!-- Header -->
  <div class="proposal-header">
    <span class="proposal-label">Pending Changes</span>
    <span class="proposal-id">{proposal.id.slice(0, 8)}</span>
  </div>

  <!-- Batch items -->
  <div class="proposal-items">
    {#each proposal.batchItems as item}
      <div class="proposal-item">
        <span class="item-icon">{toolIcon(item.tool)}</span>
        <span class="item-preview">{item.preview}</span>
      </div>
    {/each}
  </div>

  <!-- Footer -->
  {#if cardState === "pending"}
    <div class="proposal-footer">
      <span class="proposal-expiry">
        {remaining}
      </span>
      <div class="proposal-actions">
        <button class="proposal-btn decline" onclick={handleDecline}>Decline</button>
        <button class="proposal-btn apply" onclick={handleApply} disabled={expired}>Approve</button>
      </div>
    </div>
  {:else if cardState === "applying"}
    <div class="proposal-status applying">Applying changes…</div>
  {:else if cardState === "applied"}
    <div class="proposal-status applied">Changes applied</div>
  {:else if cardState === "declined"}
    <div class="proposal-status declined">Declined</div>
  {:else if cardState === "expired"}
    <div class="proposal-status expired">Proposal expired</div>
  {:else if cardState === "error"}
    <div class="proposal-status error">{errorMsg}</div>
  {/if}
</div>

<style>
  .proposal-card {
    margin-top: 12px;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--accent-gold-dim, #b07820);
    border-left: 3px solid var(--accent-gold);
    border-radius: var(--radius-sm);
  }
  .proposal-card.resolved {
    opacity: 0.7;
    border-left-color: var(--border);
  }

  /* ── Header ── */
  .proposal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .proposal-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent-gold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .proposal-id {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: monospace;
  }

  /* ── Items ── */
  .proposal-items {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .proposal-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.82rem;
    color: var(--text-primary);
    padding: 4px 6px;
    background: var(--bg-primary);
    border-radius: 3px;
  }
  .item-icon {
    flex-shrink: 0;
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .item-preview {
    line-height: 1.4;
  }

  /* ── Footer ── */
  .proposal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .proposal-expiry {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .proposal-actions {
    display: flex;
    gap: 8px;
  }

  /* ── Buttons ── */
  .proposal-btn {
    padding: 5px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    transition: all var(--transition);
  }
  .proposal-btn.decline {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }
  .proposal-btn.decline:hover {
    background: var(--bg-hover);
  }
  .proposal-btn.apply {
    background: var(--accent-gold);
    color: var(--bg-primary);
    border-color: var(--accent-gold);
  }
  .proposal-btn.apply:hover {
    background: var(--accent-gold-bright, #ffd54f);
  }
  .proposal-btn.apply:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Status ── */
  .proposal-status {
    font-size: 0.78rem;
    font-weight: 500;
    padding: 4px 0;
  }
  .proposal-status.applying {
    color: var(--accent-blue);
  }
  .proposal-status.applied {
    color: var(--accent-green);
  }
  .proposal-status.declined {
    color: var(--text-muted);
  }
  .proposal-status.expired {
    color: var(--accent-red);
  }
  .proposal-status.error {
    color: var(--accent-red);
  }
</style>
