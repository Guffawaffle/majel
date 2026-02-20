<!--
  Sidebar — Navigation, logo, tools, session placeholder, status footer.
  Mirrors the vanilla client sidebar structure from layout.css.
-->
<script lang="ts">
  import { views, getCurrentView, navigate } from "../lib/router.svelte.js";
  import { getUser, hasRole, logout } from "../lib/auth.svelte.js";
  import { checkHealth as apiCheckHealth } from "../lib/api/health.js";
  import { getSessionId } from "../lib/chat.svelte.js";
  import {
    getSessions,
    refreshSessions,
    switchToSession,
    removeSession,
    newChat,
  } from "../lib/sessions.svelte.js";

  interface Props {
    open?: boolean;
    onclose?: () => void;
  }

  let { open = false, onclose }: Props = $props();

  let healthStatus = $state<"loading" | "online" | "offline">("loading");
  let healthText = $state("Connecting…");

  async function checkHealth() {
    const data = await apiCheckHealth();
    if (data) {
      healthStatus = "online";
      healthText = data.status === "initializing" ? "Initializing…" : "Online";
    } else {
      healthStatus = "offline";
      healthText = "Offline";
    }
  }

  import { onMount } from "svelte";

  onMount(() => {
    checkHealth();
    refreshSessions();
  });

  function handleNav(name: string) {
    navigate(name);
    onclose?.();
  }

  function handleNewChat() {
    newChat();
    navigate("chat");
    onclose?.();
  }

  async function handleSessionClick(id: string) {
    await switchToSession(id);
    navigate("chat");
    onclose?.();
  }

  async function handleSessionDelete(e: Event, id: string) {
    e.stopPropagation();
    await removeSession(id);
  }

  async function handleLogout() {
    await logout();
  }
</script>

<nav class="sidebar" class:open aria-label="Main navigation">
  <!-- Logo -->
  <div class="sidebar-logo">⟐ ARIADNE</div>

  <!-- Main nav -->
  <div class="sidebar-section">
    {#each views as view}
      {#if !view.gate || hasRole(view.gate)}
        <button
          class="sidebar-nav-btn"
          class:active={getCurrentView() === view.name}
          aria-current={getCurrentView() === view.name ? 'page' : undefined}
          onclick={() => handleNav(view.name)}
        >
          <span class="icon">{view.icon}</span>
          {view.title}
        </button>
      {/if}
    {/each}
  </div>

  <!-- Tools -->
  <div class="sidebar-section-label">Tools</div>
  <div class="sidebar-section">
    <button class="sidebar-nav-btn" onclick={handleNewChat}>
      <span class="icon">✚</span>
      New Chat
    </button>
  </div>

  <!-- Session list -->
  <div class="sidebar-section-label">Recent Chats</div>
  <div class="session-section">
    <div class="session-list">
      {#each getSessions() as session (session.id)}
        <div
          class="session-item"
          class:active={session.id === getSessionId()}
          onclick={() => handleSessionClick(session.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSessionClick(session.id); }}}
          role="button"
          tabindex="0"
        >
          <div class="session-item-content">
            <span class="session-item-title">{session.title}</span>
            <span class="session-item-preview">{session.preview || "Empty session"}</span>
          </div>
          <button
            class="session-delete"
            onclick={(e) => handleSessionDelete(e, session.id)}
            title="Delete session"
          >✕</button>
        </div>
      {:else}
        <div class="session-empty">No saved chats yet</div>
      {/each}
    </div>
  </div>

  <!-- Spacer -->
  <div class="sidebar-spacer"></div>

  <!-- Logout -->
  <button class="sidebar-nav-btn logout-btn" onclick={handleLogout}>
    <span class="icon">🚪</span>
    Log Out
  </button>

  <!-- Footer -->
  <div class="sidebar-footer">
    <div class="sidebar-status">
      <span class="status-dot {healthStatus}"></span>
      <span class="status-text">{healthText}</span>
    </div>
    {#if getUser()}
      <div class="sidebar-meta">
        <span class="sidebar-user">{getUser()?.displayName}</span>
      </div>
    {/if}
  </div>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    gap: 4px;
    flex-shrink: 0;
  }

  .sidebar-logo {
    font-size: 20px;
    font-weight: 700;
    color: var(--accent-gold);
    letter-spacing: 3px;
    padding: 8px 8px 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sidebar-section-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-muted);
    padding: 12px 8px 4px;
    font-weight: 600;
  }

  .sidebar-nav-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 14px;
    color: var(--text-secondary);
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    transition: all var(--transition);
    font-family: inherit;
  }
  .sidebar-nav-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .sidebar-nav-btn.active {
    background: var(--bg-tertiary);
    color: var(--accent-gold);
    border-left: 3px solid var(--accent-gold);
  }
  .sidebar-nav-btn .icon {
    font-size: 18px;
    width: 24px;
    text-align: center;
  }

  .session-section {
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .session-list {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }

  .session-empty {
    font-size: 11px;
    color: var(--text-muted);
    padding: 8px 12px;
    font-style: italic;
  }

  .session-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background var(--transition);
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    font-family: inherit;
    color: inherit;
  }
  .session-item:hover { background: var(--bg-hover); }
  .session-item.active { background: var(--bg-tertiary); border-left: 2px solid var(--accent-gold); }

  .session-item-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .session-item-title {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-item-preview {
    font-size: 0.7rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-delete {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.7rem;
    opacity: 0;
    transition: opacity var(--transition), color var(--transition);
  }
  .session-item:hover .session-delete { opacity: 1; }
  .session-delete:hover { color: var(--accent-red); }

  .sidebar-spacer { flex: 0; }

  .logout-btn { color: var(--text-muted); }

  .sidebar-footer {
    padding-top: 12px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sidebar-status {
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .status-dot.online { background: var(--accent-green); }
  .status-dot.offline { background: var(--accent-red); }
  .status-dot.loading { background: var(--accent-gold); animation: pulse 1.5s infinite; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .sidebar-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
  }

  /* ── Mobile responsive ── */

  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 100;
      transform: translateX(-100%);
      transition: transform 0.3s ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
  }

  .sidebar-user {
    font-size: 12px;
    color: var(--text-secondary);
  }
</style>
