<script lang="ts" module>
  /**
   * ConfirmDialog — Promise-based confirmation overlay.
   *
   * Usage:
   *   import { confirm } from "./ConfirmDialog.svelte";
   *   if (await confirm({ title: "Delete user?", severity: "danger" })) { ... }
   *
   * Place <ConfirmDialog /> once in App.svelte.
   */

  /** Options accepted by the confirm() function. */
  export interface ConfirmOptions {
    title: string;
    subtitle?: string;
    /** Optional cascade/preview sections shown in the dialog body. */
    sections?: { heading: string; body: string }[];
    approveLabel?: string;
    denyLabel?: string;
    severity?: "danger" | "warning";
    /** Custom hint text. Set to false to hide the hint entirely. */
    hint?: string | false;
  }

  type Resolver = (value: boolean) => void;

  let _state = $state<{ opts: ConfirmOptions; resolve: Resolver } | null>(null);

  /** Show a confirm dialog and return a Promise that resolves to true (approve) or false (deny). */
  export function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      _state = { opts, resolve };
    });
  }

  function _resolve(value: boolean) {
    if (_state) {
      _state.resolve(value);
      _state = null;
    }
  }
</script>

<script lang="ts">
  function approve() { _resolve(true); }
  function deny() { _resolve(false); }

  function handleKeydown(e: KeyboardEvent) {
    if (!_state) return;
    if (e.key === "Escape") { e.preventDefault(); deny(); }
    if (e.key === "Enter") { e.preventDefault(); approve(); }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if _state}
  {@const opts = _state.opts}
  {@const sev = opts.severity ?? "warning"}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="confirm-overlay" onclick={deny}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="confirm-dialog {sev}" onclick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={opts.title} tabindex="-1">
      <div class="confirm-header">
        <span class="confirm-icon">{sev === "danger" ? "⚠" : "⚡"}</span>
        <div>
          <div class="confirm-title">{opts.title}</div>
          {#if opts.subtitle}
            <div class="confirm-subtitle">{opts.subtitle}</div>
          {/if}
        </div>
      </div>

      {#if opts.sections && opts.sections.length > 0}
        <div class="confirm-sections">
          {#each opts.sections as section}
            <div class="confirm-section">
              <div class="confirm-section-heading">{section.heading}</div>
              <div class="confirm-section-body">{@html section.body}</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if opts.hint !== false}
        <div class="confirm-hint">{opts.hint ?? "This action cannot be undone."}</div>
      {/if}

      <div class="confirm-actions">
        <!-- Deny is listed first so it gets autofocus -->
        <!-- svelte-ignore a11y_autofocus -->
        <button class="confirm-btn deny" onclick={deny} autofocus>
          {opts.denyLabel ?? "Cancel"}
        </button>
        <button class="confirm-btn approve {sev}" onclick={approve}>
          {opts.approveLabel ?? "Confirm"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Overlay ── */
  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: confirm-fade-in 0.15s ease;
  }

  /* ── Dialog ── */
  .confirm-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 24px;
    max-width: 440px;
    width: 90vw;
    animation: confirm-slide-in 0.2s ease;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .confirm-dialog.danger { border-color: #c0392b; }
  .confirm-dialog.warning { border-color: var(--accent-gold-dim); }

  /* ── Header ── */
  .confirm-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }
  .confirm-icon {
    font-size: 1.6rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .confirm-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text-primary);
  }
  .confirm-subtitle {
    font-size: 0.84rem;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* ── Sections (cascade preview) ── */
  .confirm-sections {
    margin-bottom: 12px;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .confirm-section { margin-bottom: 8px; }
  .confirm-section:last-child { margin-bottom: 0; }
  .confirm-section-heading {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .confirm-section-body {
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* ── Hint ── */
  .confirm-hint {
    font-size: 0.78rem;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 16px;
  }

  /* ── Actions ── */
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .confirm-btn {
    padding: 8px 18px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 500;
    transition: all var(--transition);
  }
  .confirm-btn.deny {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }
  .confirm-btn.deny:hover { background: var(--bg-tertiary); }
  .confirm-btn.approve {
    background: var(--accent-gold);
    color: var(--bg-primary);
    border-color: var(--accent-gold);
  }
  .confirm-btn.approve.danger {
    background: #c0392b;
    border-color: #c0392b;
    color: #fff;
  }
  .confirm-btn.approve.danger:hover { background: #e74c3c; border-color: #e74c3c; }
  .confirm-btn.approve.warning:hover { background: var(--accent-gold-bright, #ffd54f); }

  /* ── Animations ── */
  @keyframes confirm-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes confirm-slide-in {
    from { transform: translateY(-20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
</style>
