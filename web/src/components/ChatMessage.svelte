<!--
  ChatMessage — renders a single chat message (user / model / system / error).
  Mirrors the vanilla .message-row DOM structure.
-->
<script lang="ts">
  import type { LocalMessage } from "../lib/chat.svelte.js";
  import { renderMarkdown, escapeHtml } from "../lib/markdown.js";
  import { openLightbox } from "./ImageLightbox.svelte";
  import { onDestroy } from "svelte";

  interface Props {
    message: LocalMessage;
  }

  let { message }: Props = $props();

  // Copy‐to‐clipboard
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout>;
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.text);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 2000);
    } catch { /* ignore */ }
  }
  onDestroy(() => clearTimeout(copyTimer));

  // Rendered HTML
  const bodyHtml = $derived(
    message.role === "model"
      ? renderMarkdown(message.text)
      : escapeHtml(message.text).replace(/\n/g, "<br>"),
  );

  // Role-specific config
  const avatar = $derived(
    message.role === "user"  ? "You" :
    message.role === "system" ? "ℹ" : "A"
  );
  const sender = $derived(
    message.role === "user"   ? "You" :
    message.role === "system" ? "System" : "Aria"
  );
  const showCopy = $derived(message.role === "user" || message.role === "model");
</script>

<div
  class="message-row"
  class:user-row={message.role === "user"}
  class:model-row={message.role === "model" || message.role === "error"}
  class:system-row={message.role === "system"}
  class:error-row={message.role === "error"}
>
  <div class="message-content">
    <div class="message-avatar">{avatar}</div>
    <div class="message-body">
      <div class="message-sender">{sender}</div>
      {#if message.imageDataUrl}
        <button class="message-image-btn" onclick={() => openLightbox(message.imageDataUrl!, "screenshot")} aria-label="View full-size image">
          <img class="message-image" src={message.imageDataUrl} alt="Attached screenshot" />
          <span class="image-zoom-hint">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </span>
        </button>
      {/if}
      <div class="message-text">{@html bodyHtml}</div>
      {#if showCopy}
        <div class="message-actions">
          <button class="action-btn copy-btn" class:copied onclick={handleCopy}>
            {#if copied}
              ✓ Copied
            {:else}
              📋 Copy
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .message-row { padding: 24px 0; border-bottom: 1px solid var(--border); }
  .message-row:last-child { border-bottom: none; }
  .user-row { background: var(--bg-user-msg); }
  .model-row { background: transparent; }
  .system-row { padding: 8px 0; border-bottom: none; }

  .message-content {
    max-width: var(--max-content);
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    gap: 16px;
    align-items: flex-start;
  }

  .message-avatar {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.75rem; font-weight: 700; flex-shrink: 0; margin-top: 2px;
  }
  .user-row .message-avatar { background: var(--accent-blue); color: var(--bg-primary); }
  .model-row .message-avatar { background: var(--accent-gold); color: var(--bg-primary); }
  .system-row .message-avatar { background: var(--border); color: var(--text-muted); font-size: 0.65rem; }

  .message-body { flex: 1; min-width: 0; }
  .message-sender { font-size: 0.8rem; font-weight: 600; margin-bottom: 4px; }
  .user-row .message-sender { color: var(--accent-blue); }
  .model-row .message-sender { color: var(--accent-gold); }
  .system-row .message-sender { color: var(--text-muted); }

  /* ── Message text + markdown ── */
  .message-text {
    font-size: 0.93rem; line-height: 1.65; color: var(--text-primary);
    word-wrap: break-word; overflow-wrap: break-word;
  }
  .system-row .message-text { color: var(--text-muted); font-size: 0.82rem; font-style: italic; }
  .error-row .message-text { color: var(--accent-red); }

  .message-text :global(p) { margin-bottom: 12px; }
  .message-text :global(p:last-child) { margin-bottom: 0; }
  .message-text :global(strong) { font-weight: 600; color: var(--text-primary); }
  .message-text :global(em) { font-style: italic; }
  .message-text :global(code) {
    background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.87em; color: var(--accent-gold);
  }
  .message-text :global(pre) {
    background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px; margin: 12px 0; overflow-x: auto;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 0.85em; line-height: 1.5;
  }
  .message-text :global(pre code) { background: none; padding: 0; border-radius: 0; color: var(--text-primary); }
  .message-text :global(ul), .message-text :global(ol) { margin: 8px 0 12px 20px; }
  .message-text :global(li) { margin-bottom: 4px; }
  .message-text :global(blockquote) {
    border-left: 3px solid var(--accent-gold); padding-left: 14px; margin: 12px 0; color: var(--text-secondary);
  }
  .message-text :global(table) { border-collapse: collapse; margin: 12px 0; width: 100%; font-size: 0.85rem; }
  .message-text :global(th), .message-text :global(td) { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  .message-text :global(th) { background: var(--bg-tertiary); font-weight: 600; color: var(--accent-gold); }

  .message-text :global(.md-h1) { font-size: 1.1em; }
  .message-text :global(.md-h2) { font-size: 1.05em; }
  .message-text :global(.md-h3) { font-size: 1em; }

  /* ── Actions ── */
  .message-actions { display: flex; gap: 4px; margin-top: 8px; opacity: 0; transition: opacity var(--transition); }
  .message-row:hover .message-actions { opacity: 1; }
  .message-row:focus-within .message-actions { opacity: 1; }

  .action-btn {
    background: none; border: 1px solid transparent; color: var(--text-muted);
    padding: 4px 8px; border-radius: 4px; font-size: 0.72rem; cursor: pointer;
    display: flex; align-items: center; gap: 4px; transition: color var(--transition), border-color var(--transition);
  }
  .action-btn:hover { color: var(--text-primary); border-color: var(--border); }
  .action-btn.copied { color: var(--accent-green); }

  /* ── Image ── */
  .message-image-btn {
    display: inline-block; background: none; border: none; padding: 0;
    cursor: zoom-in; line-height: 0; position: relative;
  }
  .message-image {
    max-width: 400px; max-height: 300px; border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--border); margin-bottom: 8px;
    transition: opacity var(--transition), border-color var(--transition);
  }
  .image-zoom-hint {
    position: absolute; bottom: 16px; right: 8px;
    width: 28px; height: 28px; border-radius: 6px;
    background: rgba(6, 8, 18, 0.7); backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.6);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity var(--transition);
    pointer-events: none;
  }
  .message-image-btn:hover .message-image {
    border-color: var(--accent-gold-dim, #b07820);
    opacity: 0.92;
  }
  .message-image-btn:hover .image-zoom-hint { opacity: 1; }
</style>
