<script lang="ts">
  /**
   * AdmiralView — User management, invite codes & session control.
   * Admiral-gated (router enforces role check).
   */
  import { onMount } from "svelte";
  import {
    adminListUsers,
    adminSetRole,
    adminSetLock,
    adminDeleteUser,
    adminListInvites,
    adminCreateInvite,
    adminRevokeInvite,
    adminListSessions,
    adminDeleteSession,
    adminDeleteAllSessions,
  } from "../lib/api/admiral.js";
  import type { InviteOpts } from "../lib/api/admiral.js";
  import type { AdminUser, AdminInvite, AdminSession, Role } from "../lib/types.js";
  import { confirm } from "../components/ConfirmDialog.svelte";
  import { getUser } from "../lib/auth.svelte.js";

  // ── State ──

  let activeTab = $state<"users" | "invites" | "sessions">("users");
  let loading = $state(true);
  let error = $state("");

  let users = $state<AdminUser[]>([]);
  let invites = $state<AdminInvite[]>([]);
  let sessions = $state<AdminSession[]>([]);

  // Invite form
  let invLabel = $state("");
  let invMaxUses = $state(10);
  let invExpiry = $state("7d");

  const currentEmail = $derived(getUser()?.email ?? "");

  const ROLES: Role[] = ["ensign", "lieutenant", "captain", "admiral"];

  // ── Lifecycle ──

  onMount(() => { refresh(); });

  async function refresh() {
    loading = true;
    error = "";
    try {
      const [u, i, s] = await Promise.all([
        adminListUsers(),
        adminListInvites(),
        adminListSessions(),
      ]);
      users = u;
      invites = i;
      sessions = s;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load data.";
    } finally {
      loading = false;
    }
  }

  // ── Helpers ──

  function fmtDate(d: string | null): string {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function inviteStatus(inv: AdminInvite): string {
    if (inv.revokedAt) return "🚫 Revoked";
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return "⏰ Expired";
    return "✅ Active";
  }

  function copyToClipboard(text: string, evt: MouseEvent) {
    navigator.clipboard.writeText(text);
    const btn = evt.currentTarget as HTMLButtonElement;
    const orig = btn.textContent;
    btn.textContent = "✅";
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  // ── Actions: Users ──

  async function handleRoleChange(email: string, newRole: Role) {
    if (!(await confirm({ title: `Change ${email} to ${newRole}?` }))) return;
    try {
      await adminSetRole(email, newRole);
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Role change failed."; }
  }

  async function handleLock(email: string, isLocked: boolean) {
    const action = isLocked ? "unlock" : "lock";
    if (!(await confirm({ title: `${action.charAt(0).toUpperCase() + action.slice(1)} ${email}?` }))) return;
    try {
      await adminSetLock(email, !isLocked);
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Lock toggle failed."; }
  }

  async function handleDeleteUser(email: string) {
    if (!(await confirm({ title: `Permanently delete user ${email}?`, subtitle: "This cannot be undone.", severity: "danger", approveLabel: "Delete" }))) return;
    try {
      await adminDeleteUser(email);
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Delete failed."; }
  }

  // ── Actions: Invites ──

  async function handleCreateInvite() {
    try {
      const opts: InviteOpts = { maxUses: invMaxUses, expiresIn: invExpiry };
      if (invLabel.trim()) opts.label = invLabel.trim();
      const result = await adminCreateInvite(opts);
      await navigator.clipboard.writeText(result.code);
      invLabel = "";
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Invite creation failed."; }
  }

  async function handleRevoke(code: string) {
    if (!(await confirm({ title: `Revoke invite ${code.slice(0, 6)}…?`, severity: "warning" }))) return;
    try {
      await adminRevokeInvite(code);
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Revoke failed."; }
  }

  // ── Actions: Sessions ──

  async function handleKillSession(id: string) {
    if (!(await confirm({ title: `Kill session ${id.slice(0, 12)}…?`, severity: "warning" }))) return;
    try {
      await adminDeleteSession(id);
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Kill failed."; }
  }

  async function handleKillAll() {
    if (!(await confirm({ title: "Kill ALL sessions?", subtitle: "This will log out every user.", severity: "danger", approveLabel: "Kill All" }))) return;
    try {
      await adminDeleteAllSessions();
      await refresh();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Kill all failed."; }
  }
</script>

<section class="admiral">
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="adm-tabs" role="tablist">
    <button class="adm-tab" class:active={activeTab === "users"} onclick={() => (activeTab = "users")} role="tab" aria-selected={activeTab === "users"}>👥 Users</button>
    <button class="adm-tab" class:active={activeTab === "invites"} onclick={() => (activeTab = "invites")} role="tab" aria-selected={activeTab === "invites"}>🎫 Invites</button>
    <button class="adm-tab" class:active={activeTab === "sessions"} onclick={() => (activeTab = "sessions")} role="tab" aria-selected={activeTab === "sessions"}>🔑 Sessions</button>
  </nav>

  {#if error}
    <p class="adm-error">{error}</p>
  {/if}

  {#if loading}
    <div class="adm-loading">Loading…</div>
  {:else if activeTab === "users"}
    <div class="adm-table-wrap">
      <table class="adm-table">
        <thead>
          <tr><th>Email</th><th>Name</th><th>Role</th><th>Verified</th><th>Locked</th><th>Joined</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {#each users as u (u.id)}
            {@const isSelf = u.email === currentEmail}
            <tr class:adm-row-locked={!!u.lockedAt}>
              <td class="adm-cell-email" title={u.email}>{u.email}</td>
              <td>{u.displayName}</td>
              <td>
                <select
                  class="adm-role-select"
                  value={u.role}
                  disabled={isSelf}
                  onchange={(e) => handleRoleChange(u.email, (e.currentTarget as HTMLSelectElement).value as Role)}
                >
                  {#each ROLES as r}
                    <option value={r}>{r}</option>
                  {/each}
                </select>
              </td>
              <td>{u.emailVerified ? "✅" : "❌"}</td>
              <td>{u.lockedAt ? "🔒" : "—"}</td>
              <td class="adm-cell-date">{fmtDate(u.createdAt)}</td>
              <td class="adm-cell-actions">
                {#if !isSelf}
                  <button class="adm-btn" onclick={() => handleLock(u.email, !!u.lockedAt)}>
                    {u.lockedAt ? "🔓 Unlock" : "🔒 Lock"}
                  </button>
                  <button class="adm-btn adm-btn-danger" onclick={() => handleDeleteUser(u.email)}>🗑️</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="adm-count">{users.length} user(s)</div>

  {:else if activeTab === "invites"}
    <div class="adm-invite-form">
      <input class="adm-input" placeholder="Label (optional)" bind:value={invLabel} />
      <input class="adm-input adm-input-sm" type="number" min="1" max="100" bind:value={invMaxUses} />
      <select class="adm-input adm-input-sm" bind:value={invExpiry}>
        <option value="1h">1 hour</option>
        <option value="24h">24 hours</option>
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
      </select>
      <button class="adm-btn adm-btn-primary" onclick={handleCreateInvite}>+ Create</button>
    </div>

    <div class="adm-table-wrap">
      <table class="adm-table">
        <thead>
          <tr><th>Code</th><th>Label</th><th>Uses</th><th>Status</th><th>Created</th><th>Expires</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {#each invites as inv (inv.code)}
            {@const muted = !!inv.revokedAt || (inv.expiresAt != null && new Date(inv.expiresAt) < new Date())}
            <tr class:adm-row-muted={muted}>
              <td>
                <code class="adm-code">{inv.code.slice(0, 6)}…</code>
                <button class="adm-btn-copy" onclick={(e) => copyToClipboard(inv.code, e)}>📋</button>
              </td>
              <td>{inv.label ?? "—"}</td>
              <td>{inv.usedCount} / {inv.maxUses ?? "∞"}</td>
              <td>{inviteStatus(inv)}</td>
              <td class="adm-cell-date">{fmtDate(inv.createdAt)}</td>
              <td class="adm-cell-date">{inv.expiresAt ? fmtDate(inv.expiresAt) : "Never"}</td>
              <td class="adm-cell-actions">
                {#if !inv.revokedAt}
                  <button class="adm-btn" onclick={() => handleRevoke(inv.code)}>Revoke</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="adm-count">{invites.length} invite(s)</div>

  {:else if activeTab === "sessions"}
    {#if sessions.length > 0}
      <div class="adm-session-toolbar">
        <button class="adm-btn adm-btn-danger" onclick={handleKillAll}>Kill All Sessions</button>
      </div>
    {/if}

    <div class="adm-table-wrap">
      <table class="adm-table">
        <thead>
          <tr><th>Session ID</th><th>Invite Code</th><th>Created</th><th>Last Active</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {#each sessions as s (s.id)}
            <tr>
              <td><code class="adm-code">{s.id.slice(0, 12)}…</code></td>
              <td>{s.inviteCode ?? "—"}</td>
              <td class="adm-cell-date">{fmtDate(s.createdAt)}</td>
              <td class="adm-cell-date">{fmtDate(s.lastSeenAt)}</td>
              <td class="adm-cell-actions">
                <button class="adm-btn" onclick={() => handleKillSession(s.id)}>Kill</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="adm-count">{sessions.length} session(s)</div>
  {/if}
</section>

<style>
  .admiral {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 16px 24px;
    overflow-y: auto;
  }

  /* ── Tabs ── */
  .adm-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
  }
  .adm-tab {
    padding: 8px 16px;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 0.88rem;
    cursor: pointer;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    transition: all var(--transition);
  }
  .adm-tab:hover { color: var(--text-primary); background: var(--bg-tertiary); }
  .adm-tab.active { color: var(--accent-gold); border-bottom: 2px solid var(--accent-gold); }

  /* ── Error / Loading ── */
  .adm-error {
    color: var(--accent-red, #e55);
    background: rgba(255, 50, 50, 0.08);
    padding: 8px 12px;
    border-radius: 4px;
    margin-bottom: 12px;
    font-size: 0.85rem;
  }
  .adm-loading {
    text-align: center;
    color: var(--text-muted);
    padding: 48px 0;
    font-size: 0.9rem;
  }

  /* ── Table ── */
  .adm-table-wrap { overflow-x: auto; margin-bottom: 8px; }
  .adm-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .adm-table th {
    text-align: left;
    padding: 8px 10px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.75rem;
  }
  .adm-table td {
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    color: var(--text-primary);
  }
  .adm-row-locked { opacity: 0.55; }
  .adm-row-muted { opacity: 0.45; }
  .adm-cell-email {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .adm-cell-date { white-space: nowrap; color: var(--text-muted); font-size: 0.8rem; }
  .adm-cell-actions { white-space: nowrap; }

  /* ── Controls ── */
  .adm-role-select {
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.82rem;
  }
  .adm-role-select:disabled { opacity: 0.4; cursor: not-allowed; }

  .adm-btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .adm-btn:hover { background: var(--bg-tertiary); }
  .adm-btn-primary { color: var(--accent-gold); border-color: var(--accent-gold-dim); }
  .adm-btn-danger { color: var(--accent-red, #e55); }
  .adm-btn-danger:hover { background: rgba(255, 50, 50, 0.12); }

  .adm-code {
    font-family: monospace;
    font-size: 0.82rem;
    color: var(--accent-blue);
    background: rgba(100, 180, 255, 0.06);
    padding: 2px 6px;
    border-radius: 3px;
  }
  .adm-btn-copy {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0 4px;
    vertical-align: middle;
  }

  /* ── Invite Form ── */
  .adm-invite-form {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .adm-input {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.85rem;
    min-width: 120px;
  }
  .adm-input-sm { min-width: 70px; width: 90px; }

  /* ── Session Toolbar ── */
  .adm-session-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  /* ── Count ── */
  .adm-count {
    text-align: right;
    color: var(--text-muted);
    font-size: 0.78rem;
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .admiral { padding: 12px; }
    .adm-invite-form { flex-direction: column; align-items: stretch; }
    .adm-input-sm { width: 100%; }
  }
</style>
