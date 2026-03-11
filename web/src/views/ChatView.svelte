<!--
  ChatView — full chat interface: welcome screen, messages, input, model selector.
  Phase 3 migration of vanilla views/chat/.
-->
<script lang="ts">
  import ChatMessageComponent from "../components/ChatMessage.svelte";
  import TypingIndicator from "../components/TypingIndicator.svelte";
  import ChatInput from "../components/ChatInput.svelte";
  import {
    getMessages,
    hasMessages,
    isSending,
    send,
    attachImage,
    getRunPhase,
    getRunElapsedMs,
    getRunModel,
  } from "../lib/chat.svelte.js";
  import { refreshSessions } from "../lib/sessions.svelte.js";
  import { tick } from "svelte";

  // ── Auto-scroll ──
  let chatAreaEl: HTMLElement | undefined = $state();
  let showScrollBtn = $state(false);
  let chatInputRef: ChatInput | undefined = $state();

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (chatAreaEl) chatAreaEl.scrollTop = chatAreaEl.scrollHeight;
    });
  }

  function handleScroll() {
    if (!chatAreaEl) return;
    const distFromBottom = chatAreaEl.scrollHeight - chatAreaEl.scrollTop - chatAreaEl.clientHeight;
    showScrollBtn = distFromBottom > 200;
  }

  // Auto-scroll when messages change
  $effect(() => {
    // Read the messages array length to subscribe
    const _len = getMessages().length;
    tick().then(scrollToBottom);
  });

  // ── Welcome suggestions ──
  const suggestions = [
    "What officers should I prioritize for a Vidar?",
    "Compare Stella and Kirk for PvP.",
    "What's the best below-deck setup for hostiles?",
    "Help me plan my next research path.",
  ];

  function handleSuggestion(text: string) {
    send(text, () => refreshSessions());
  }

  // ── Drag & drop ──
  let dragging = $state(false);
  function handleDragOver(e: DragEvent) { e.preventDefault(); dragging = true; }
  function handleDragLeave() { dragging = false; }
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file?.type.startsWith("image/")) {
      attachImage(file).catch(() => {});
      chatInputRef?.focus();
    }
  }
</script>

<div class="chat-view">
  <main
    class="chat-area"
    class:drag-over={dragging}
    bind:this={chatAreaEl}
    onscroll={handleScroll}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
  >
    {#if !hasMessages() && !isSending()}
      <!-- Welcome screen -->
      <div class="welcome-screen">
        <div class="welcome-icon">🖖</div>
        <h2>Aria</h2>
        <p class="welcome-sub">STFC Fleet Intelligence System</p>
        <div class="welcome-suggestions">
          {#each suggestions as s}
            <button class="suggestion" onclick={() => handleSuggestion(s)}>{s}</button>
          {/each}
        </div>
      </div>
    {:else}
      <!-- Messages -->
      <div class="messages" aria-live="polite" aria-relevant="additions">
        {#each getMessages() as msg (msg.id)}
          <ChatMessageComponent message={msg} />
        {/each}
        {#if isSending()}
          <TypingIndicator phase={getRunPhase()} elapsedMs={getRunElapsedMs()} model={getRunModel()} />
        {/if}
      </div>
    {/if}

    <!-- Scroll-to-bottom FAB -->
    <button
      class="scroll-bottom"
      class:hidden={!showScrollBtn}
      onclick={scrollToBottom}
      aria-label="Scroll to bottom"
    >↓</button>
  </main>

  <ChatInput bind:this={chatInputRef} />
</div>

<style>
  .chat-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .chat-area {
    flex: 1;
    overflow-y: auto;
    position: relative;
    scroll-behavior: smooth;
  }
  .chat-area.drag-over {
    outline: 2px dashed var(--accent-gold);
    outline-offset: -4px;
  }

  /* ── Welcome ── */
  .welcome-screen {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 60vh; padding: 40px 20px;
    text-align: center;
  }
  .welcome-icon { font-size: 3rem; margin-bottom: 12px; }
  .welcome-screen h2 {
    font-size: 1.6rem; font-weight: 700; color: var(--accent-gold); margin-bottom: 4px;
  }
  .welcome-sub { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 32px; }

  .welcome-suggestions {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    max-width: 480px; width: 100%;
  }
  .suggestion {
    padding: 14px 16px; background: var(--bg-secondary);
    border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text-secondary); font-size: 0.84rem; cursor: pointer;
    transition: background var(--transition), border-color var(--transition), color var(--transition);
    text-align: left; line-height: 1.4; font-family: inherit;
  }
  .suggestion:hover {
    background: var(--bg-hover); border-color: var(--text-muted); color: var(--text-primary);
  }

  /* ── Messages container ── */
  .messages { display: flex; flex-direction: column; }

  /* ── Scroll FAB ── */
  .scroll-bottom {
    position: sticky; bottom: 16px; left: 50%; transform: translateX(-50%);
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-muted);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: opacity var(--transition), background var(--transition);
    z-index: 10; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); font-size: 1rem;
  }
  .scroll-bottom:hover { background: var(--bg-hover); color: var(--text-primary); }
  .scroll-bottom.hidden { opacity: 0; pointer-events: none; }
</style>
