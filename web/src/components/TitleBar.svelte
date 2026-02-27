<!--
  TitleBar — Displays the current view's icon, title, subtitle, and help button.
-->
<script lang="ts">
  import { getCurrentViewDef } from "../lib/router.svelte.js";

  interface Props {
    helpOpen?: boolean;
    ontogglehelp?: () => void;
  }

  const { helpOpen = false, ontogglehelp }: Props = $props();

  let view = $derived(getCurrentViewDef());
</script>

<div class="title-bar">
  <h1>
    <span class="icon">{view.icon}</span>
    {view.title}
  </h1>
  <span class="subtitle">{view.subtitle}</span>
  <button class="help-btn" class:active={helpOpen} title="Help (?)" aria-label="Toggle help panel" onclick={ontogglehelp}>?</button>
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

  .title-bar .help-btn {
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
  .title-bar .help-btn:hover,
  .title-bar .help-btn.active {
    color: var(--accent-blue);
    border-color: var(--accent-blue-dim);
  }
</style>
