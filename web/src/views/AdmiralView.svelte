<script lang="ts">
  /**
   * AdmiralView — User management, invite codes & session control.
   * Admiral-gated (router enforces role check).
   */
  import {
    adminListUsers,
    adminSetRole,
    adminSetLock,
    adminDeleteUser,
    adminResendVerification,
    adminVerifyUser,
    adminListInvites,
    adminCreateInvite,
    adminRevokeInvite,
    adminListSessions,
    adminDeleteSession,
    adminDeleteAllSessions,
    adminListModels,
    adminSetModelAvailability,
    adminGetBudgetDefaults,
    adminSetBudgetDefaults,
    adminGetUsage,
    adminGetOverrides,
    adminSetOverride,
  } from "../lib/api/admiral.js";
  import type { InviteOpts } from "../lib/api/admiral.js";
  import type { AdminUser, AdminInvite, AdminSession, AdminModelEntry, Role, BudgetRankDefaults, UsageRow, BudgetOverride } from "../lib/types.js";
  import { confirm } from "../components/ConfirmDialog.svelte";
  import { getUser } from "../lib/auth.svelte.js";

  // ── State ──

  let activeTab = $state<"users" | "invites" | "sessions" | "models" | "budgets">("users");
  let loading = $state(true);
  let error = $state("");

  let users = $state<AdminUser[]>([]);
  let invites = $state<AdminInvite[]>([]);
  let sessions = $state<AdminSession[]>([]);
  let models = $state<AdminModelEntry[]>([]);
  let togglingModel = $state<string | null>(null);

  // Budget state
  let budgetDefaults = $state<BudgetRankDefaults | null>(null);
  let budgetUsage = $state<UsageRow[]>([]);
  let budgetOverrides = $state<BudgetOverride[]>([]);
  let budgetFrom = $state(new Date().toISOString().slice(0, 10));
  let budgetTo = $state(new Date().toISOString().slice(0, 10));
  let savingBudget = $state(false);

  // Override form
  let overrideUserId = $state("");
  let overrideLimit = $state("");
  let overrideNote = $state("");

  // Invite form
  let invLabel = $state("");
  let invMaxUses = $state(10);
  let invExpiry = $state("7d");

  const currentUserId = $derived(getUser()?.id ?? "");

  const ROLES: Role[] = ["ensign", "lieutenant", "captain", "admiral"];

  // ── Lifecycle ──

  // Track which tabs have loaded data to avoid redundant fetches
  const loaded = new Set<string>();

  $effect(() => {
    const tab = activeTab; // track reactive dependency
    if (!loaded.has(tab)) {
      refreshActiveTab(tab);
    }
  });

  async function refreshActiveTab(tab?: typeof activeTab) {
    const target = tab ?? activeTab;
    loading = true;
    error = "";
    try {
      if (target === "users") {
        users = await adminListUsers();
      } else if (target === "invites") {
        invites = await adminListInvites();
      } else if (target === "sessions") {
        sessions = await adminListSessions();
      } else if (target === "models") {
        models = await adminListModels();
      } else if (target === "budgets") {
        const [defaults, overridesData, usageData] = await Promise.all([
          adminGetBudgetDefaults(),
          adminGetOverrides(),
          adminGetUsage(budgetFrom, budgetTo),
        ]);
        budgetDefaults = defaults;
        budgetOverrides = overridesData;
        budgetUsage = usageData.usage;
      }
      loaded.add(target);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to load data.";
    } finally {
      loading = false;
    }
  }

  async function refreshUsers() {
    try {
      users = await adminListUsers();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to refresh users.";
    }
  }

  async function refreshInvites() {
    try {
      invites = await adminListInvites();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to refresh invites.";
    }
  }

  async function refreshSessions() {
    try {
      sessions = await adminListSessions();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "Failed to refresh sessions.";
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

  async function handleRoleChange(userId: string, displayName: string, newRole: Role) {
    if (!(await confirm({ title: `Change ${displayName} to ${newRole}?` }))) return;
    try {
      await adminSetRole(userId, newRole);
      await refreshUsers();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Role change failed."; }
  }

  async function handleLock(userId: string, displayName: string, isLocked: boolean) {
    const action = isLocked ? "unlock" : "lock";
    if (!(await confirm({ title: `${action.charAt(0).toUpperCase() + action.slice(1)} ${displayName}?` }))) return;
    try {
      await adminSetLock(userId, !isLocked);
      await refreshUsers();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Lock toggle failed."; }
  }

  async function handleDeleteUser(userId: string, displayName: string) {
    if (!(await confirm({ title: `Permanently delete user ${displayName}?`, subtitle: "This cannot be undone.", severity: "danger", approveLabel: "Delete" }))) return;
    try {
      await adminDeleteUser(userId);
      await refreshUsers();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Delete failed."; }
  }

  async function handleApprove(userId: string, displayName: string) {
    if (!(await confirm({ title: `Approve ${displayName}?`, subtitle: "This will mark the account as verified.", approveLabel: "Approve" }))) return;
    try {
      await adminVerifyUser(userId);
      await refreshUsers();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Approve failed."; }
  }

  async function handleResendVerification(userId: string, displayName: string) {
    if (!(await confirm({ title: `Resend verification for ${displayName}?`, approveLabel: "Resend" }))) return;
    try {
      await adminResendVerification(userId);
      await refreshUsers();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Resend verification failed."; }
  }

  // ── Actions: Invites ──

  async function handleCreateInvite() {
    if (invMaxUses < 1 || invMaxUses > 100) {
      error = "Max uses must be between 1 and 100.";
      return;
    }
    try {
      const opts: InviteOpts = { maxUses: invMaxUses, expiresIn: invExpiry };
      if (invLabel.trim()) opts.label = invLabel.trim();
      const result = await adminCreateInvite(opts);
      await navigator.clipboard.writeText(result.code);
      invLabel = "";
      await refreshInvites();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Invite creation failed."; }
  }

  async function handleRevoke(code: string) {
    if (!(await confirm({ title: `Revoke invite ${code.slice(0, 6)}…?`, severity: "warning" }))) return;
    try {
      await adminRevokeInvite(code);
      await refreshInvites();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Revoke failed."; }
  }

  // ── Actions: Sessions ──

  async function handleKillSession(id: string) {
    if (!(await confirm({ title: `Kill session ${id.slice(0, 12)}…?`, severity: "warning" }))) return;
    try {
      await adminDeleteSession(id);
      await refreshSessions();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Kill failed."; }
  }

  async function handleKillAll() {
    if (!(await confirm({ title: "Kill ALL sessions?", subtitle: "This will log out every user.", severity: "danger", approveLabel: "Kill All" }))) return;
    try {
      await adminDeleteAllSessions();
      await refreshSessions();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Kill all failed."; }
  }

  // ── Actions: Models ──

  async function handleToggleModel(model: AdminModelEntry) {
    const newEnabled = model.adminEnabled === null ? !model.defaultEnabled : !model.adminEnabled;
    togglingModel = model.id;
    try {
      await adminSetModelAvailability(model.id, newEnabled);
      models = await adminListModels();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Model toggle failed."; }
    finally { togglingModel = null; }
  }

  async function handleResetModelOverride(model: AdminModelEntry) {
    // Reset to registry default by setting adminEnabled to match defaultEnabled (effectively clearing the override spirit)
    // Actually we need to remove the override entirely — set adminEnabled back to default
    togglingModel = model.id;
    try {
      await adminSetModelAvailability(model.id, model.defaultEnabled, "Reset to default");
      models = await adminListModels();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Reset failed."; }
    finally { togglingModel = null; }
  }

  // ── Actions: Budgets ──

  function fmtTokens(n: number): string {
    if (n === -1) return "∞";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  }

  async function handleSaveBudgetDefaults() {
    if (!budgetDefaults) return;
    savingBudget = true;
    try {
      await adminSetBudgetDefaults(budgetDefaults.defaults, budgetDefaults.paddingPct);
      loaded.delete("budgets");
      await refreshActiveTab("budgets");
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Save failed."; }
    finally { savingBudget = false; }
  }

  async function handleRefreshUsage() {
    loading = true;
    try {
      const data = await adminGetUsage(budgetFrom, budgetTo);
      budgetUsage = data.usage;
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Usage fetch failed."; }
    finally { loading = false; }
  }

  async function handleSetOverride() {
    if (!overrideUserId.trim()) return;
    const limit = overrideLimit.trim() === "" ? null : Number(overrideLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < -1)) {
      error = "Daily limit must be an integer >= -1, or blank to remove";
      return;
    }
    try {
      await adminSetOverride(overrideUserId.trim(), limit, overrideNote.trim() || null);
      overrideUserId = "";
      overrideLimit = "";
      overrideNote = "";
      budgetOverrides = await adminGetOverrides();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Override failed."; }
  }

  async function handleRemoveOverride(userId: string) {
    if (!(await confirm({ title: `Remove budget override for ${userId.slice(0, 12)}…?`, severity: "warning" }))) return;
    try {
      await adminSetOverride(userId, null, null);
      budgetOverrides = await adminGetOverrides();
    } catch (err: unknown) { error = err instanceof Error ? err.message : "Remove failed."; }
  }
</script>

<section class="admiral">
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <nav class="adm-tabs" role="tablist">
    <button class="adm-tab" class:active={activeTab === "users"} onclick={() => (activeTab = "users")} role="tab" aria-selected={activeTab === "users"}>👥 Users</button>
    <button class="adm-tab" class:active={activeTab === "invites"} onclick={() => (activeTab = "invites")} role="tab" aria-selected={activeTab === "invites"}>🎫 Invites</button>
    <button class="adm-tab" class:active={activeTab === "sessions"} onclick={() => (activeTab = "sessions")} role="tab" aria-selected={activeTab === "sessions"}>🔑 Sessions</button>
    <button class="adm-tab" class:active={activeTab === "models"} onclick={() => (activeTab = "models")} role="tab" aria-selected={activeTab === "models"}>🤖 Models</button>
    <button class="adm-tab" class:active={activeTab === "budgets"} onclick={() => (activeTab = "budgets")} role="tab" aria-selected={activeTab === "budgets"}>💰 Budgets</button>
  </nav>

  {#if error}
    <div class="adm-error" role="alert">
      <span>⚠ {error}</span>
      <button onclick={() => { error = ""; }}>✕</button>
    </div>
  {/if}

  {#if loading}
    <div class="adm-loading">Loading…</div>
  {:else if activeTab === "users"}
    <div class="adm-table-wrap">
      <table class="adm-table" aria-label="Registered users">
        <thead>
          <tr><th>Name</th><th>Role</th><th>Verified</th><th>Locked</th><th>Joined</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {#each users as u (u.id)}
            {@const isSelf = u.id === currentUserId}
            <tr class:adm-row-locked={!!u.lockedAt}>
              <td>{u.displayName}</td>
              <td>
                <select
                  class="adm-role-select"
                  value={u.role}
                  disabled={isSelf}
                  onchange={(e) => handleRoleChange(u.id, u.displayName, (e.currentTarget as HTMLSelectElement).value as Role)}
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
                  {#if !u.emailVerified}
                    <button class="adm-btn adm-btn-primary" onclick={() => handleApprove(u.id, u.displayName)}>
                      Approve
                    </button>
                    <button class="adm-btn" onclick={() => handleResendVerification(u.id, u.displayName)}>
                      Resend Verification
                    </button>
                  {/if}
                  <button class="adm-btn" onclick={() => handleLock(u.id, u.displayName, !!u.lockedAt)}>
                    {u.lockedAt ? "🔓 Unlock" : "🔒 Lock"}
                  </button>
                  <button class="adm-btn adm-btn-danger" onclick={() => handleDeleteUser(u.id, u.displayName)}>🗑️</button>
                {/if}
              </td>
            </tr>
          {/each}
          {#if users.length === 0}
            <tr><td colspan="6" class="adm-empty">No users registered yet.</td></tr>
          {/if}
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
      <table class="adm-table" aria-label="Invite codes">
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
          {#if invites.length === 0}
            <tr><td colspan="7" class="adm-empty">No invites created yet. Create one above.</td></tr>
          {/if}
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
      <table class="adm-table" aria-label="Active sessions">
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
          {#if sessions.length === 0}
            <tr><td colspan="5" class="adm-empty">No active sessions.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="adm-count">{sessions.length} session(s)</div>

  {:else if activeTab === "models"}
    <div class="adm-table-wrap">
      <table class="adm-table" aria-label="Model availability">
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Tier</th><th>Default</th><th>Provider Ready</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {#each models as m (m.id)}
            {@const isOverridden = m.adminEnabled !== null}
            {@const effectiveEnabled = m.adminEnabled ?? m.defaultEnabled}
            <tr class:adm-row-muted={!m.effectiveAvailable}>
              <td>
                <div class="adm-model-name">{m.name}</div>
                <div class="adm-model-desc">{m.description}</div>
              </td>
              <td><span class="adm-badge adm-badge-{m.provider}">{m.provider}</span></td>
              <td>{m.tier}</td>
              <td>{m.defaultEnabled ? "✅" : "❌"}</td>
              <td>{m.providerCapable ? "✅" : "❌"}</td>
              <td>
                {#if m.effectiveAvailable}
                  <span class="adm-status-available">Available</span>
                {:else}
                  <span class="adm-status-unavailable" title={m.unavailableReason ?? ""}>{m.unavailableReason ?? "Unavailable"}</span>
                {/if}
                {#if isOverridden}
                  <span class="adm-override-badge" title={m.adminReason ?? "Admin override"}>overridden</span>
                {/if}
              </td>
              <td class="adm-cell-actions">
                <button
                  class="adm-btn"
                  class:adm-btn-primary={!effectiveEnabled}
                  class:adm-btn-danger={effectiveEnabled}
                  disabled={togglingModel === m.id}
                  onclick={() => handleToggleModel(m)}
                >
                  {togglingModel === m.id ? "…" : effectiveEnabled ? "Disable" : "Enable"}
                </button>
                {#if isOverridden}
                  <button
                    class="adm-btn"
                    disabled={togglingModel === m.id}
                    onclick={() => handleResetModelOverride(m)}
                    title="Reset to registry default"
                  >↩ Reset</button>
                {/if}
              </td>
            </tr>
          {/each}
          {#if models.length === 0}
            <tr><td colspan="7" class="adm-empty">No models found.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="adm-count">{models.length} model(s)</div>

  {:else if activeTab === "budgets"}
    {#if budgetDefaults}
      <!-- Rank Defaults -->
      <h3 class="adm-section-title">Rank Default Budgets (daily tokens)</h3>
      <div class="adm-budget-grid">
        {#each ROLES as role}
          <label class="adm-budget-label">
            <span class="adm-budget-rank">{role}</span>
            <input
              class="adm-input adm-input-sm"
              type="number"
              min="-1"
              bind:value={budgetDefaults.defaults[role]}
            />
            <span class="adm-budget-hint">{fmtTokens(budgetDefaults.defaults[role] ?? -1)}</span>
          </label>
        {/each}
        <label class="adm-budget-label">
          <span class="adm-budget-rank">Warning %</span>
          <input
            class="adm-input adm-input-sm"
            type="number"
            min="0"
            max="50"
            bind:value={budgetDefaults.paddingPct}
          />
          <span class="adm-budget-hint">Warn at {100 - (budgetDefaults.paddingPct ?? 10)}% consumed</span>
        </label>
      </div>
      <button class="adm-btn adm-btn-primary" disabled={savingBudget} onclick={handleSaveBudgetDefaults}>
        {savingBudget ? "Saving…" : "Save Defaults"}
      </button>

      <!-- Per-user Overrides -->
      <h3 class="adm-section-title" style="margin-top:24px">Per-User Overrides</h3>
      <div class="adm-override-form">
        <input class="adm-input" placeholder="User ID" bind:value={overrideUserId} />
        <input class="adm-input adm-input-sm" type="number" min="-1" placeholder="Limit (-1=∞)" bind:value={overrideLimit} />
        <input class="adm-input" placeholder="Note (optional)" bind:value={overrideNote} />
        <button class="adm-btn adm-btn-primary" onclick={handleSetOverride}>Set Override</button>
      </div>
      {#if budgetOverrides.length > 0}
        <div class="adm-table-wrap">
          <table class="adm-table" aria-label="Budget overrides">
            <thead>
              <tr><th>User</th><th>Daily Limit</th><th>Note</th><th>Set By</th><th>Updated</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {#each budgetOverrides as o (o.userId)}
                <tr>
                  <td><span class="adm-code">{o.userId.slice(0, 12)}…</span></td>
                  <td>{o.dailyLimit === null ? "rank default" : fmtTokens(o.dailyLimit)}</td>
                  <td>{o.note ?? "—"}</td>
                  <td>{o.setBy ? o.setBy.slice(0, 8) + "…" : "—"}</td>
                  <td class="adm-cell-date">{new Date(o.updatedAt).toLocaleDateString()}</td>
                  <td class="adm-cell-actions">
                    <button class="adm-btn adm-btn-danger" onclick={() => handleRemoveOverride(o.userId)}>🗑️</button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="adm-empty">No per-user overrides set.</p>
      {/if}
      <div class="adm-count">{budgetOverrides.length} override(s)</div>

      <!-- Usage Dashboard -->
      <h3 class="adm-section-title" style="margin-top:24px">Token Usage</h3>
      <div class="adm-usage-controls">
        <label>From <input class="adm-input adm-input-sm" type="date" bind:value={budgetFrom} /></label>
        <label>To <input class="adm-input adm-input-sm" type="date" bind:value={budgetTo} /></label>
        <button class="adm-btn" onclick={handleRefreshUsage}>Refresh</button>
      </div>
      {#if budgetUsage.length > 0}
        <div class="adm-table-wrap">
          <table class="adm-table" aria-label="Token usage">
            <thead>
              <tr><th>User</th><th>Date</th><th>Tokens</th><th>Calls</th></tr>
            </thead>
            <tbody>
              {#each budgetUsage as row (row.userId + row.date)}
                <tr>
                  <td><span class="adm-code">{row.userId.slice(0, 12)}…</span></td>
                  <td>{row.date}</td>
                  <td>{fmtTokens(row.totalTokens)}</td>
                  <td>{row.callCount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="adm-empty">No usage data for this period.</p>
      {/if}
    {:else}
      <p class="adm-empty">Budget data not loaded.</p>
    {/if}
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
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .adm-error button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
  }
  .adm-empty {
    text-align: center;
    color: var(--text-muted);
    padding: 16px;
    font-style: italic;
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

  /* ── Models ── */
  .adm-model-name { font-weight: 600; font-size: 0.85rem; }
  .adm-model-desc { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
  .adm-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .adm-badge-gemini { background: rgba(66, 133, 244, 0.15); color: #4285f4; }
  .adm-badge-claude { background: rgba(204, 120, 50, 0.15); color: #cc7832; }
  .adm-status-available { color: var(--accent-green, #4c4); font-size: 0.82rem; }
  .adm-status-unavailable { color: var(--text-muted); font-size: 0.82rem; }
  .adm-override-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.68rem;
    background: rgba(255, 200, 50, 0.12);
    color: var(--accent-gold);
    text-transform: uppercase;
  }

  @media (max-width: 768px) {
    .admiral { padding: 12px; }
    .adm-invite-form { flex-direction: column; align-items: stretch; }
    .adm-input-sm { width: 100%; }
  }

  /* ── Budget tab ── */
  .adm-section-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 12px;
  }
  .adm-budget-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }
  .adm-budget-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
  }
  .adm-budget-rank {
    text-transform: capitalize;
    font-weight: 600;
    min-width: 80px;
    color: var(--text-muted);
  }
  .adm-budget-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 60px;
  }
  .adm-override-form {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .adm-usage-controls {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
    font-size: 0.85rem;
  }
  .adm-usage-controls label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
  }
</style>
