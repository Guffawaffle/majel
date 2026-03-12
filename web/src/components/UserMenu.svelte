<!--
  UserMenu — Avatar initial + display name with dropdown for theme, logout, etc.
  Placed at the top of the sidebar, below the logo.
-->
<script lang="ts">
  import { getUser, hasRole, logout } from "../lib/auth.svelte.js";
  import { getTheme, toggleTheme } from "../lib/theme.svelte.js";

  let menuOpen = $state(false);

  function toggle() {
    menuOpen = !menuOpen;
  }

  function close() {
    menuOpen = false;
  }

  function handleClickOutside(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest(".user-menu");
    if (!el) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function handleThemeToggle() {
    toggleTheme();
  }

  async function handleLogout() {
    close();
    await logout();
  }

  function initial(name: string): string {
    return name.charAt(0).toUpperCase();
  }
</script>

<svelte:document onclick={handleClickOutside} onkeydown={handleKeydown} />

{#if getUser()}
  {@const user = getUser()!}
  <div class="user-menu">
    <button
      class="user-trigger"
      onclick={toggle}
      aria-expanded={menuOpen}
      aria-haspopup="menu"
      title={user.displayName}
    >
      <span class="user-avatar">{initial(user.displayName)}</span>
      <span class="user-name">{user.displayName}</span>
      <span class="user-chevron" class:open={menuOpen}>▾</span>
    </button>

    {#if menuOpen}
      <div class="user-dropdown" role="menu">
        <div class="dropdown-header">
          <span class="dropdown-email">{user.email}</span>
          <span class="dropdown-role">{user.role}</span>
        </div>

        <div class="dropdown-divider"></div>

        <button class="dropdown-item" role="menuitem" onclick={handleThemeToggle}>
          <span class="dropdown-icon">{getTheme() === 'lcars' ? '🖖' : '🌑'}</span>
          Theme: {getTheme() === 'lcars' ? 'LCARS' : 'Dark'}
        </button>

        <div class="dropdown-divider"></div>

        <button class="dropdown-item dropdown-item-danger" role="menuitem" onclick={handleLogout}>
          <span class="dropdown-icon">🚪</span>
          Log Out
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .user-menu {
    position: relative;
  }

  .user-trigger {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    font-family: inherit;
    color: var(--text-secondary);
    transition: background var(--transition);
  }
  .user-trigger:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .user-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent-gold);
    color: var(--bg-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .user-name {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-chevron {
    font-size: 10px;
    color: var(--text-muted);
    transition: transform var(--transition);
    flex-shrink: 0;
  }
  .user-chevron.open {
    transform: rotate(180deg);
  }

  .user-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    z-index: 200;
    padding: 4px;
    min-width: 180px;
  }

  .dropdown-header {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dropdown-email {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dropdown-role {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent-gold);
    font-weight: 600;
  }

  .dropdown-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .dropdown-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .dropdown-item-danger:hover {
    color: var(--accent-red);
  }

  .dropdown-icon {
    font-size: 14px;
    width: 20px;
    text-align: center;
  }
</style>
