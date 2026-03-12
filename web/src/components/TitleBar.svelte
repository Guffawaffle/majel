<!--
  TitleBar — Displays the current view's icon, title, subtitle, and action buttons.
  Action buttons are passed via the `actions` snippet for per-view extensibility.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { getCurrentViewDef } from "../lib/router.svelte.js";

  interface Props {
    actions?: Snippet;
  }

  const { actions }: Props = $props();

  let view = $derived(getCurrentViewDef());
</script>

<div class="title-bar">
  <h1>
    <span class="icon">{view.icon}</span>
    {view.title}
  </h1>
  <span class="subtitle">{view.subtitle}</span>
  <div class="title-bar-actions">
    {#if actions}
      {@render actions()}
    {/if}
  </div>
</div>

<style>
  .title-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .title-bar h1 {
    font-size: 18px;
    font-weight: 600;
    color: var(--accent-gold);
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }

  .title-bar .subtitle {
    font-size: 13px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .title-bar-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* Shared style for action buttons passed via snippet */
  .title-bar-actions :global(button) {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    transition: all var(--transition);
    font-family: inherit;
  }
  .title-bar-actions :global(button:hover),
  .title-bar-actions :global(button.active) {
    color: var(--accent-blue);
    border-color: var(--accent-blue-dim);
  }
</style>
