<!--
  ChatInput — textarea, send button, image attach, model selector.
  Mirrors vanilla #input-area / #chat-form structure.
-->
<script lang="ts">
  import {
    isSending,
    getPendingImage,
    attachImage,
    clearPendingImage,
    send,
    cancelCurrentRun,
    getRunPhase,
  } from "../lib/chat.svelte.js";
  import { openLightbox } from "./ImageLightbox.svelte";
  import { confirm } from "./ConfirmDialog.svelte";
  import { refreshSessions } from "../lib/sessions.svelte.js";
  import { hasRole } from "../lib/auth.svelte.js";
  import { fetchModels, selectModel } from "../lib/api/models.js";
  import { fetchBudgetStatus } from "../lib/api/chat.js";
  import { addSystemMessage } from "../lib/chat.svelte.js";
  import type { ModelsResponse, BudgetStatus } from "../lib/types.js";
  import { onDestroy, onMount } from "svelte";

  // ── Text input ──
  let inputText = $state("");
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  function autoGrow() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 200) + "px";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── Send ──
  const canSend = $derived(!isSending() && (inputText.trim().length > 0 || getPendingImage() != null));
  const showStop = $derived(isSending() && getRunPhase() !== "cancelling");
  const isCancelling = $derived(getRunPhase() === "cancelling");
  let sessionRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleSessionsRefresh() {
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = setTimeout(() => {
      void refreshSessions();
    }, 350);
  }

  async function handleSend() {
    if (!canSend) return;
    const text = inputText;
    inputText = "";
    if (textareaEl) textareaEl.style.height = "auto";
    await send(text, scheduleSessionsRefresh);
    // Refresh budget after send completes
    budgetStatus = await fetchBudgetStatus();
  }

  // ── Budget Indicator ──
  let budgetStatus = $state<BudgetStatus | null>(null);

  const budgetLabel = $derived.by(() => {
    const s = budgetStatus;
    if (!s) return null;
    // Unlimited users: show consumed today (informational, no warning)
    if (s.dailyLimit === -1) {
      if (s.consumed <= 0) return null;
      const used = s.consumed >= 1000 ? `${(s.consumed / 1000).toFixed(0)}K` : String(s.consumed);
      return { text: `${used} tokens today`, color: "muted" };
    }
    if (s.remaining <= 0) return { text: "Budget exceeded", color: "red" };
    const pct = s.dailyLimit > 0 ? (s.consumed / s.dailyLimit) * 100 : 0;
    const rem = s.remaining >= 1000 ? `${(s.remaining / 1000).toFixed(0)}K` : String(s.remaining);
    if (pct >= 95) return { text: `${rem} tokens left`, color: "red" };
    if (s.warning) return { text: `${rem} tokens left`, color: "amber" };
    return { text: `${rem} remaining`, color: "muted" };
  });

  // ── Image ──
  let fileInputEl: HTMLInputElement | undefined = $state();

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function handleFilePick() { fileInputEl?.click(); }

  async function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      try { await attachImage(file); } catch (err) {
        addSystemMessage((err as Error).message);
      }
    }
    input.value = "";
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          attachImage(blob).catch((err) => addSystemMessage((err as Error).message));
        }
        return;
      }
    }
  }

  // ── Model selector ──
  let modelsData = $state<ModelsResponse | null>(null);
  let pickerOpen = $state(false);
  const showModelSelector = $derived(hasRole("admiral") && modelsData != null);
  const modelLocked = $derived(modelsData != null && modelsData.models.length <= 1);
  const currentModelLabel = $derived(modelsData?.currentDef?.name ?? modelsData?.current ?? "");

  onMount(async () => {
    if (hasRole("admiral")) {
      try { modelsData = await fetchModels(); } catch { /* non-admiral or error */ }
    }
    budgetStatus = await fetchBudgetStatus();
  });

  onDestroy(() => {
    if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
  });

  function togglePicker() { if (!modelLocked) pickerOpen = !pickerOpen; }
  function closePicker() { pickerOpen = false; }

  async function handleModelSelect(modelId: string) {
    if (!modelsData || modelId === modelsData.current) {
      closePicker();
      return;
    }
    const entry = modelsData.models.find((m) => m.id === modelId);
    if (entry && !entry.available) {
      addSystemMessage(`${entry.name} is unavailable: ${entry.unavailableReason ?? "unknown reason"}.`);
      return;
    }
    if (!(await confirm({ title: "Switching models will clear existing sessions. Continue?", severity: "warning" }))) return;
    try {
      const result = await selectModel(modelId);
      addSystemMessage(`Model switched to ${result.modelDef.name}. ${result.sessionsCleared} session(s) cleared.`);
      modelsData = await fetchModels();
    } catch (err) {
      addSystemMessage(`Model switch failed: ${(err as Error).message}`);
    }
    closePicker();
  }

  // Close picker on outside click / Escape
  function handleDocClick(e: MouseEvent) {
    if (pickerOpen) {
      const target = e.target as HTMLElement;
      if (!target.closest(".model-picker") && !target.closest(".model-selector-btn")) {
        closePicker();
      }
    }
  }

  function handleDocKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && pickerOpen) closePicker();
  }

  /** Focus the textarea (called by parent after actions). */
  export function focus(): void {
    textareaEl?.focus();
  }

  // Cost → star display (1★ cheapest, 5★ most expensive)
  function costStars(cost: number): string { return "★".repeat(cost); }
</script>

<svelte:document onclick={handleDocClick} onkeydown={handleDocKeydown} />

<footer class="input-area">
  <form class="chat-form" onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
    <!-- Image preview bar -->
    {#if getPendingImage()}
      {@const img = getPendingImage()}
      <div class="image-preview-bar">
        <div class="image-preview-content">
          <button class="image-preview-btn" type="button" onclick={() => { if (img) openLightbox(img.dataUrl, img.name); }} aria-label="View full-size image">
            <img class="image-preview-thumb" src={img?.dataUrl} alt="Preview" />
            <span class="image-preview-zoom">
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="2"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </span>
          </button>
          <div class="image-preview-info">
            <span class="image-preview-name">{img?.name}</span>
            {#if img?.fileSize}
              <span class="image-preview-size">{formatFileSize(img.fileSize)}</span>
            {/if}
          </div>
        </div>
        <button type="button" class="image-preview-remove" onclick={clearPendingImage} title="Remove image" aria-label="Remove attached image">✕</button>
      </div>
    {/if}

    <!-- Input pill -->
    <div class="input-container">
      <input
        bind:this={fileInputEl}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="visually-hidden"
        onchange={handleFileChange}
      />
      <button type="button" class="image-upload-btn" onclick={handleFilePick} title="Attach image" aria-label="Attach image">
        📎
      </button>
      <textarea
        bind:this={textareaEl}
        bind:value={inputText}
        placeholder="Message Aria..."
        aria-label="Message Aria"
        rows="1"
        maxlength={10000}
        disabled={isSending()}
        oninput={autoGrow}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
      ></textarea>
      {#if showStop || isCancelling}
        <button
          type="button"
          class="stop-btn"
          disabled={isCancelling}
          onclick={() => cancelCurrentRun()}
          title={isCancelling ? "Stopping..." : "Stop generation"}
          aria-label={isCancelling ? "Stopping" : "Stop generation"}
        >■</button>
      {:else}
        <button type="submit" class="send-btn" disabled={!canSend}>
          ➤
        </button>
      {/if}
    </div>

    <!-- Hint line + model selector -->
    <p class="input-hint">
      {#if showModelSelector}
        {#if modelLocked}
          <span class="model-selector-label model-locked" title="Model is locked by admin">🔒 {currentModelLabel}</span>
        {:else}
          <button type="button" class="model-selector-btn" onclick={togglePicker}
            aria-expanded={pickerOpen} aria-haspopup="listbox">
            <span class="model-selector-label">{currentModelLabel}</span>
            <span class="model-chevron" class:open={pickerOpen}>▾</span>
          </button>
        {/if}
        ·
      {/if}
      <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline
      {#if budgetLabel}{@const b = budgetLabel}
        · <span class="budget-indicator budget-{b.color}">{b.text}</span>
      {/if}
    </p>

    <!-- Model picker dropdown -->
    {#if pickerOpen && modelsData}
      <div class="model-picker">
        <div class="model-picker-header">Select Model</div>
        <div class="model-picker-list">
          {#each modelsData.models as model}
            <button
              type="button"
              class="model-card"
              class:model-card-active={model.id === modelsData?.current}
              class:model-card-unavailable={!model.available}
              aria-disabled={!model.available}
              title={model.available ? undefined : (model.unavailableReason ?? 'Unavailable')}
              onclick={() => handleModelSelect(model.id)}
            >
              <div class="model-card-header">
                <span class="model-card-name">{model.name}</span>
                <span class="provider-badge provider-{model.provider}">{model.provider === 'gemini' ? 'Gemini' : 'Claude'}</span>
                {#if model.thinking}<span class="model-thinking">🧠</span>{/if}
                <span class="model-tier-badge tier-{model.tier}">{costStars(model.costRelative)}</span>
              </div>
              <div class="model-card-desc">{model.description}</div>
              <div class="model-card-meta">
                <span class="model-speed">{model.speed}</span>
                {#if model.id === modelsData?.current}
                  <span class="model-active-badge">Active</span>
                {/if}
                {#if !model.available}
                  <span class="model-unavailable-reason">{model.unavailableReason ?? 'Unavailable'}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </form>
</footer>

<style>
  .input-area { padding: 0 24px 20px; background: var(--bg-primary); }
  .chat-form { max-width: var(--max-content); margin: 0 auto; position: relative; }

  .input-container {
    display: flex; align-items: flex-end; gap: 0;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 24px; padding: 8px 8px 8px 20px;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  .input-container:focus-within {
    border-color: var(--accent-gold);
    box-shadow: 0 0 0 1px var(--accent-gold-soft);
  }

  textarea {
    flex: 1; background: transparent; border: none; color: var(--text-primary);
    font-size: 0.93rem; line-height: 1.5; resize: none; outline: none;
    max-height: 200px; padding: 6px 0; font-family: inherit;
  }
  textarea::placeholder { color: var(--text-muted); }

  .send-btn {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-gold); border: none; color: var(--bg-primary);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: opacity var(--transition), transform var(--transition);
    font-size: 1rem;
  }
  .send-btn:hover:not(:disabled) { opacity: 0.9; transform: scale(1.05); }
  .send-btn:disabled { opacity: 0.3; cursor: not-allowed; background: var(--border); }

  .stop-btn {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--accent-red, #e06050); border: none; color: #fff;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: opacity var(--transition), transform var(--transition);
    font-size: 0.85rem;
  }
  .stop-btn:hover:not(:disabled) { opacity: 0.9; transform: scale(1.05); }
  .stop-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .input-hint {
    text-align: center; font-size: 0.7rem; color: var(--text-muted);
    margin-top: 8px; opacity: 0.7;
  }
  .input-hint :global(kbd) {
    background: var(--bg-tertiary); padding: 1px 5px; border-radius: 3px;
    border: 1px solid var(--border); font-family: inherit; font-size: 0.9em;
  }

  .budget-indicator { font-size: 0.72rem; font-weight: 600; }
  .budget-muted { color: var(--text-muted); }
  .budget-amber { color: #e0a030; }
  .budget-red { color: var(--accent-red, #e55); }

  /* ── Image upload ── */
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px;
    padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0;
  }
  .image-upload-btn {
    background: none; border: none; color: var(--text-muted);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
    margin-right: 4px; font-size: 1rem;
  }
  .image-upload-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

  /* ── Image preview bar ── */
  .image-preview-bar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 8px 12px; margin-bottom: 6px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 8px; animation: fadeIn 0.15s ease-out;
  }
  .image-preview-content { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .image-preview-btn {
    background: none; border: none; padding: 0; cursor: zoom-in;
    line-height: 0; position: relative; flex-shrink: 0;
  }
  .image-preview-thumb {
    width: 44px; height: 44px; object-fit: cover;
    border-radius: 6px; border: 1px solid var(--border);
    transition: opacity var(--transition), border-color var(--transition);
  }
  .image-preview-zoom {
    position: absolute; bottom: 2px; right: 2px;
    width: 18px; height: 18px; border-radius: 4px;
    background: rgba(6, 8, 18, 0.75);
    color: rgba(255, 255, 255, 0.7);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity var(--transition);
    pointer-events: none;
  }
  .image-preview-btn:hover .image-preview-thumb {
    border-color: var(--accent-gold-dim, #b07820); opacity: 0.85;
  }
  .image-preview-btn:hover .image-preview-zoom { opacity: 1; }
  .image-preview-info {
    display: flex; flex-direction: column; gap: 1px; min-width: 0;
  }
  .image-preview-name {
    font-size: 0.8rem; color: var(--text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .image-preview-size {
    font-size: 0.7rem; color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .image-preview-remove {
    background: none; border: 1px solid transparent; color: var(--text-muted);
    cursor: pointer; width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: color var(--transition), border-color var(--transition);
  }
  .image-preview-remove:hover { color: var(--accent-red); border-color: var(--accent-red); }

  /* ── Model selector ── */
  .model-selector-btn {
    background: none; border: none; color: var(--accent-gold); cursor: pointer;
    font-size: inherit; font-family: inherit; padding: 0;
    display: inline-flex; align-items: center; gap: 3px;
    transition: color var(--transition); font-weight: 500;
  }
  .model-selector-btn:hover { color: var(--text-primary); }
  .model-chevron { transition: transform var(--transition); display: inline-block; }
  .model-chevron.open { transform: rotate(180deg); }

  /* ── Model picker ── */
  .model-picker {
    position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    width: min(420px, calc(100vw - 48px));
    background: var(--bg-secondary); border: 1px solid var(--border-light, var(--border));
    border-radius: var(--radius); box-shadow: 0 -8px 32px rgba(0,0,0,0.4);
    z-index: 100; margin-bottom: 8px; overflow: hidden;
  }
  .model-picker-header {
    padding: 12px 16px 8px; font-size: 0.75rem; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }
  .model-picker-list { max-height: 380px; overflow-y: auto; padding: 6px; }

  .model-card {
    display: block; width: 100%; text-align: left;
    background: transparent; border: 1px solid transparent;
    border-radius: 6px; padding: 10px 12px; cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
    color: var(--text-primary); font-family: inherit;
  }
  .model-card + .model-card { margin-top: 2px; }
  .model-card:hover { background: var(--bg-hover); border-color: var(--border); }
  .model-card-active { background: var(--bg-hover); border-color: var(--accent-gold-dim); }
  .model-card-active:hover { border-color: var(--accent-gold); }

  .model-card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .model-card-name { font-size: 0.88rem; font-weight: 600; }
  .model-thinking { font-size: 0.75rem; }
  .provider-badge {
    font-size: 0.6rem; font-weight: 600; padding: 1px 5px;
    border-radius: 3px; text-transform: uppercase; letter-spacing: 0.03em;
  }
  :global(.provider-gemini) { background: rgba(66, 133, 244, 0.15); color: #6ea8fe; }
  :global(.provider-claude) { background: rgba(204, 120, 50, 0.15); color: #e0964a; }
  .model-tier-badge {
    font-size: 0.65rem; font-weight: 700; padding: 1px 6px;
    border-radius: 3px; margin-left: auto; letter-spacing: 0.02em;
  }
  :global(.tier-budget)   { background: var(--bg-tertiary); color: var(--accent-green); }
  :global(.tier-balanced) { background: var(--bg-tertiary); color: var(--accent-blue); }
  :global(.tier-thinking) { background: var(--bg-tertiary); color: var(--accent-purple); }
  :global(.tier-premium)  { background: var(--bg-tertiary); color: var(--accent-orange); }
  :global(.tier-frontier) { background: var(--bg-tertiary); color: var(--accent-red); }

  .model-card-desc { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; margin-bottom: 4px; }
  .model-card-meta { display: flex; align-items: center; gap: 8px; font-size: 0.72rem; color: var(--text-muted); }
  .model-speed { text-transform: capitalize; }
  .model-active-badge { color: var(--accent-green); font-weight: 600; }

  .model-card-unavailable { opacity: 0.4; cursor: not-allowed; }
  .model-card-unavailable:hover { background: transparent; border-color: transparent; }
  .model-unavailable-reason { color: var(--accent-red, #e06050); font-style: italic; margin-left: auto; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>
