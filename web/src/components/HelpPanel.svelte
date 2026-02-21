<script lang="ts">
  /**
   * HelpPanel — Slide-in contextual help drawer.
   * Toggled by the ? button in TitleBar or the ? keyboard shortcut.
   */
  import {
    getHelpForView,
    getHelpViewNames,
    VIEW_META,
    type ViewHelp,
  } from "../lib/help-content.js";
  import { getCurrentView } from "../lib/router.svelte.js";

  // ── Props ──

  interface Props {
    open: boolean;
    pinned?: boolean;
    onclose: () => void;
    ontogglepin?: () => void;
  }

  const { open, pinned = false, onclose, ontogglepin }: Props = $props();

  // ── State ──

  /** Which view's help we're currently displaying (null = global) */
  let helpView = $state<string | null>(null);
  let help = $derived<ViewHelp>(getHelpForView(helpView));
  let viewNames = getHelpViewNames();

  // When the panel opens, reset to the current view's help
  $effect(() => {
    if (open) {
      helpView = getCurrentView();
    }
  });

  function showViewHelp(name: string | null) {
    helpView = name;
  }

  function handleBackdropClick() {
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  {#if !pinned}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="help-backdrop" class:visible={open} onclick={handleBackdropClick}></div>
  {/if}

  <aside class="help-panel" class:open class:pinned aria-label="Help">
    <div class="help-header">
      <div class="help-header-text">
        <h3 class="help-title">{help.title}</h3>
        <p class="help-intro">{help.intro}</p>
      </div>
      <button class="help-pin" class:active={pinned} onclick={ontogglepin} aria-label={pinned ? "Unpin help" : "Pin help"} title={pinned ? "Unpin panel" : "Pin panel"}>📌</button>
      <button class="help-close" onclick={onclose} aria-label="Close help">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="4" y1="4" x2="14" y2="14" /><line x1="14" y1="4" x2="4" y2="14" />
        </svg>
      </button>
    </div>

    <div class="help-body">
      <!-- Sections -->
      {#each help.sections as section}
        <div class="help-section">
          <h4 class="help-section-heading">{section.heading}</h4>
          <div class="help-section-body">{@html section.body}</div>
        </div>
      {/each}

      <!-- Tips -->
      {#if help.tips.length > 0}
        <div class="help-tips">
          <div class="help-tips-label">💡 Tips</div>
          <ul>
            {#each help.tips as tip}
              <li>{tip}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Keyboard shortcuts -->
      {#if help.keys.length > 0}
        <div class="help-keys">
          <div class="help-keys-label">⌨ Keyboard</div>
          <div class="help-keys-grid">
            {#each help.keys as k}
              <kbd>{k.key}</kbd><span>{k.action}</span>
            {/each}
          </div>
        </div>
      {/if}

      <!-- About link (when viewing a specific view's help) -->
      {#if helpView !== null}
        <div class="help-divider"></div>
        <button class="help-about-btn" onclick={() => showViewHelp(null)}>⟐ About Ariadne</button>
      {/if}

      <!-- View index -->
      <div class="help-divider"></div>
      <div class="help-index">
        <div class="help-index-label">Help for other views</div>
        <div class="help-index-grid">
          {#each viewNames as name}
            {@const meta = VIEW_META[name]}
            {#if meta}
              <button
                class="help-index-link"
                class:current={helpView === name}
                onclick={() => showViewHelp(name)}
              >
                <span class="help-index-icon">{meta.icon}</span>
                <span class="help-index-name">{meta.label}</span>
              </button>
            {/if}
          {/each}
        </div>
      </div>
    </div>
  </aside>
{/if}

<style>
  /* ── Backdrop ── */
  .help-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .help-backdrop.visible { opacity: 1; }

  /* ── Panel ── */
  .help-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-width: 100vw;
    background: var(--bg-primary);
    border-left: 1px solid var(--border);
    z-index: 91;
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.25s ease;
    overflow: hidden;
  }
  .help-panel.open { transform: translateX(0); }
  .help-panel.pinned {
    position: relative;
    top: auto;
    right: auto;
    bottom: auto;
    height: 100%;
    transform: none;
    transition: width 0.25s ease;
    z-index: 1;
  }

  /* ── Header ── */
  .help-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .help-header-text { flex: 1; }
  .help-title {
    margin: 0;
    font-size: 1.1rem;
    color: var(--accent-gold);
  }
  .help-intro {
    margin: 6px 0 0;
    font-size: 0.84rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .help-close {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .help-close:hover { color: var(--text-primary); border-color: var(--text-muted); }
  .help-pin {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    padding: 6px 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .help-pin:hover,
  .help-pin.active {
    color: var(--accent-blue);
    border-color: var(--accent-blue-dim);
  }

  /* ── Body ── */
  .help-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 24px;
  }

  /* ── Sections ── */
  .help-section { margin-bottom: 16px; }
  .help-section-heading {
    margin: 0 0 8px;
    font-size: 0.9rem;
    color: var(--text-primary);
    font-weight: 600;
  }
  .help-section-body {
    font-size: 0.84rem;
    line-height: 1.55;
    color: var(--text-secondary, var(--text-muted));
  }
  .help-section-body :global(p) { margin: 0 0 8px; }
  .help-section-body :global(ul),
  .help-section-body :global(ol) {
    margin: 4px 0 8px 18px;
    padding: 0;
  }
  .help-section-body :global(li) { margin-bottom: 4px; }
  .help-section-body :global(strong) { color: var(--text-primary); }

  /* ── Tips ── */
  .help-tips { margin-top: 16px; }
  .help-tips-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent-gold);
    margin-bottom: 6px;
  }
  .help-tips ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .help-tips li {
    padding: 4px 0 4px 16px;
    position: relative;
    font-size: 0.82rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .help-tips li::before {
    content: "→";
    position: absolute;
    left: 0;
    color: var(--accent-gold-dim);
  }

  /* ── Keys ── */
  .help-keys { margin-top: 16px; }
  .help-keys-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent-gold);
    margin-bottom: 6px;
  }
  .help-keys-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    align-items: baseline;
  }
  .help-keys-grid kbd {
    font-family: monospace;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .help-keys-grid span {
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  /* ── Divider ── */
  .help-divider {
    height: 1px;
    background: var(--border);
    margin: 16px 0;
  }

  /* ── About button ── */
  .help-about-btn {
    display: block;
    width: 100%;
    text-align: center;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    color: var(--accent-gold);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .help-about-btn:hover { background: var(--bg-tertiary); }

  /* ── View Index ── */
  .help-index-label {
    font-size: 0.78rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .help-index-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 6px;
  }
  .help-index-link {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.78rem;
    transition: all var(--transition);
  }
  .help-index-link:hover { background: var(--bg-tertiary); color: var(--text-primary); }
  .help-index-link.current {
    border-color: var(--accent-gold-dim);
    color: var(--accent-gold);
    background: rgba(255, 193, 7, 0.06);
  }
  .help-index-icon { font-size: 1.3rem; }
  .help-index-name { text-align: center; }

  @media (max-width: 768px) {
    .help-panel { width: 100vw; }
  }
</style>
