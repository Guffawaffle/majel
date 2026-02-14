/**
 * admin.js — Admiral Console Module (ADR-020)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Three-panel admin console for admirals:
 * 1. Users — list, promote/demote, lock/unlock, delete
 * 2. Invites — create, list, revoke invite codes
 * 3. Sessions — list, kill tenant sessions
 */

import {
    adminListUsers, adminSetRole, adminSetLock, adminDeleteUser,
    adminListInvites, adminCreateInvite, adminRevokeInvite,
    adminListSessions, adminDeleteSession, adminDeleteAllSessions,
} from 'api/admiral.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let users = [];
let invites = [];
let sessions = [];
let activeTab = 'users'; // 'users' | 'invites' | 'sessions'
let loading = false;
let currentUserEmail = null; // set from app.js

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('admin', {
    area: $('#admin-area'),
    icon: '🛡️', title: 'Admiral Console', subtitle: 'User management, invites & sessions',
    cssHref: 'views/admiral/admiral.css',
    init, refresh,
    gate: 'admiral',
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $("#admin-area");
    if (!area) return;
    render();
}

export function setCurrentUser(email) {
    currentUserEmail = email;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    render();
    try {
        const [u, i, s] = await Promise.all([
            adminListUsers(),
            adminListInvites(),
            adminListSessions(),
        ]);
        users = u;
        invites = i;
        sessions = s;
    } catch (err) {
        console.error("Admin fetch failed:", err);
    } finally {
        loading = false;
        render();
    }
}

// ─── Tab Navigation ─────────────────────────────────────────

function switchTab(tab) {
    activeTab = tab;
    render();
}

// ─── Render ─────────────────────────────────────────────────

function render() {
    const area = $("#admin-area");
    if (!area) return;

    area.innerHTML = `
        <div class="admin-tabs">
            <button class="admin-tab ${activeTab === 'users' ? 'active' : ''}" data-tab="users">👥 Users</button>
            <button class="admin-tab ${activeTab === 'invites' ? 'active' : ''}" data-tab="invites">🎫 Invites</button>
            <button class="admin-tab ${activeTab === 'sessions' ? 'active' : ''}" data-tab="sessions">🔑 Sessions</button>
        </div>
        <div class="admin-panel">
            ${loading ? '<div class="admin-loading">Loading…</div>' : renderActiveTab()}
        </div>
    `;

    // Wire tab buttons
    area.querySelectorAll(".admin-tab").forEach(btn => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Wire action buttons after render
    wireActions(area);
}

function renderActiveTab() {
    switch (activeTab) {
        case 'users': return renderUsers();
        case 'invites': return renderInvites();
        case 'sessions': return renderSessions();
        default: return '';
    }
}

// ─── Users Panel ────────────────────────────────────────────

function renderUsers() {
    if (!users.length) {
        return '<div class="admin-empty">No registered users.</div>';
    }

    const rows = users.map(u => {
        const isSelf = u.email === currentUserEmail;
        const isLocked = !!u.lockedAt;
        const roleOptions = ['ensign', 'lieutenant', 'captain', 'admiral']
            .map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`)
            .join('');

        return `
            <tr class="${isLocked ? 'admin-row-locked' : ''}">
                <td class="admin-cell-email" title="${esc(u.email)}">${esc(u.email)}</td>
                <td>${esc(u.displayName)}</td>
                <td>
                    <select class="admin-role-select" data-email="${esc(u.email)}" ${isSelf ? 'disabled title="Cannot change own role"' : ''}>
                        ${roleOptions}
                    </select>
                </td>
                <td>${u.emailVerified ? '✅' : '❌'}</td>
                <td>${isLocked ? '🔒' : '—'}</td>
                <td class="admin-cell-date">${fmtDate(u.createdAt)}</td>
                <td class="admin-cell-actions">
                    <button class="admin-btn-lock" data-email="${esc(u.email)}" data-locked="${isLocked}" ${isSelf ? 'disabled' : ''}>
                        ${isLocked ? '🔓 Unlock' : '🔒 Lock'}
                    </button>
                    <button class="admin-btn-delete-user" data-email="${esc(u.email)}" ${isSelf ? 'disabled' : ''}>
                        🗑️
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Role</th>
                        <th>Verified</th>
                        <th>Locked</th>
                        <th>Joined</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="admin-count">${users.length} user${users.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Invites Panel ──────────────────────────────────────────

function renderInvites() {
    const form = `
        <div class="admin-invite-form">
            <input type="text" id="invite-label" placeholder="Label (optional)" class="admin-input" />
            <input type="number" id="invite-max-uses" placeholder="Max uses" min="1" max="100" value="10" class="admin-input admin-input-sm" />
            <select id="invite-expiry" class="admin-input admin-input-sm">
                <option value="1h">1 hour</option>
                <option value="24h">24 hours</option>
                <option value="7d" selected>7 days</option>
                <option value="30d">30 days</option>
            </select>
            <button id="admin-create-invite" class="admin-btn-primary">+ Create</button>
        </div>
    `;

    if (!invites.length) {
        return form + '<div class="admin-empty">No invite codes.</div>';
    }

    const rows = invites.map(inv => {
        const isExpired = inv.expiresAt && new Date(inv.expiresAt) < new Date();
        const isRevoked = inv.revoked;
        const status = isRevoked ? '❌ Revoked' : isExpired ? '⏰ Expired' : '✅ Active';
        const codeMasked = inv.code.slice(0, 6) + '…';

        return `
            <tr class="${isRevoked || isExpired ? 'admin-row-muted' : ''}">
                <td>
                    <code class="admin-code" title="${esc(inv.code)}">${codeMasked}</code>
                    <button class="admin-btn-copy" data-code="${esc(inv.code)}" title="Copy code">📋</button>
                </td>
                <td>${esc(inv.label || '—')}</td>
                <td>${inv.usedCount ?? 0} / ${inv.maxUses ?? '∞'}</td>
                <td>${status}</td>
                <td class="admin-cell-date">${fmtDate(inv.createdAt)}</td>
                <td class="admin-cell-date">${inv.expiresAt ? fmtDate(inv.expiresAt) : 'Never'}</td>
                <td class="admin-cell-actions">
                    ${!isRevoked ? `<button class="admin-btn-revoke" data-code="${esc(inv.code)}">Revoke</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    return form + `
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Code</th>
                        <th>Label</th>
                        <th>Uses</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Expires</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="admin-count">${invites.length} invite${invites.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Sessions Panel ─────────────────────────────────────────

function renderSessions() {
    const killAllBtn = sessions.length > 0
        ? '<button id="admin-kill-all-sessions" class="admin-btn-danger">Kill All Sessions</button>'
        : '';

    if (!sessions.length) {
        return '<div class="admin-empty">No active tenant sessions.</div>';
    }

    const rows = sessions.map(s => `
        <tr>
            <td><code class="admin-code">${esc(s.tenantId?.slice(0, 12) ?? s.id?.slice(0, 12) ?? '?')}…</code></td>
            <td>${esc(s.inviteCode || '—')}</td>
            <td class="admin-cell-date">${fmtDate(s.createdAt)}</td>
            <td class="admin-cell-date">${fmtDate(s.lastSeenAt)}</td>
            <td class="admin-cell-actions">
                <button class="admin-btn-kill-session" data-id="${esc(s.tenantId || s.id)}">Kill</button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="admin-session-toolbar">${killAllBtn}</div>
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead>
                    <tr>
                        <th>Session ID</th>
                        <th>Invite Code</th>
                        <th>Created</th>
                        <th>Last Active</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="admin-count">${sessions.length} session${sessions.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Action Wiring ──────────────────────────────────────────

function wireActions(area) {
    // Role change selects
    area.querySelectorAll(".admin-role-select").forEach(sel => {
        sel.addEventListener("change", async () => {
            const email = sel.dataset.email;
            const role = sel.value;
            if (!confirm(`Change ${email} to ${role}?`)) {
                await refresh();
                return;
            }
            const res = await adminSetRole(email, role);
            if (!res.ok) alert(res.error?.message || "Failed to set role");
            await refresh();
        });
    });

    // Lock/unlock buttons
    area.querySelectorAll(".admin-btn-lock").forEach(btn => {
        btn.addEventListener("click", async () => {
            const email = btn.dataset.email;
            const isLocked = btn.dataset.locked === 'true';
            const action = isLocked ? 'unlock' : 'lock';
            if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${email}?`)) return;
            const res = await adminSetLock(email, !isLocked);
            if (!res.ok) alert(res.error?.message || `Failed to ${action}`);
            await refresh();
        });
    });

    // Delete user buttons
    area.querySelectorAll(".admin-btn-delete-user").forEach(btn => {
        btn.addEventListener("click", async () => {
            const email = btn.dataset.email;
            if (!confirm(`⚠️ Permanently delete ${email}? This cannot be undone.`)) return;
            const res = await adminDeleteUser(email);
            if (!res.ok) alert(res.error?.message || "Failed to delete user");
            await refresh();
        });
    });

    // Create invite button
    const createBtn = area.querySelector("#admin-create-invite");
    if (createBtn) {
        createBtn.addEventListener("click", async () => {
            const label = area.querySelector("#invite-label")?.value?.trim() || undefined;
            const maxUses = parseInt(area.querySelector("#invite-max-uses")?.value, 10) || undefined;
            const expiresIn = area.querySelector("#invite-expiry")?.value || undefined;
            const res = await adminCreateInvite({ label, maxUses, expiresIn });
            if (!res.ok) {
                alert(res.error?.message || "Failed to create invite");
            } else if (res.data?.code) {
                // Copy new code to clipboard
                try { await navigator.clipboard.writeText(res.data.code); } catch { }
                alert(`Invite code created: ${res.data.code}\n(Copied to clipboard)`);
            }
            await refresh();
        });
    }

    // Copy code buttons
    area.querySelectorAll(".admin-btn-copy").forEach(btn => {
        btn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(btn.dataset.code);
                btn.textContent = '✅';
                setTimeout(() => btn.textContent = '📋', 1500);
            } catch {
                alert(`Code: ${btn.dataset.code}`);
            }
        });
    });

    // Revoke invite buttons
    area.querySelectorAll(".admin-btn-revoke").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Revoke this invite code?")) return;
            const res = await adminRevokeInvite(btn.dataset.code);
            if (!res.ok) alert(res.error?.message || "Failed to revoke");
            await refresh();
        });
    });

    // Kill single session
    area.querySelectorAll(".admin-btn-kill-session").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Kill this session?")) return;
            const res = await adminDeleteSession(btn.dataset.id);
            if (!res.ok) alert(res.error?.message || "Failed to kill session");
            await refresh();
        });
    });

    // Kill all sessions
    const killAllBtn = area.querySelector("#admin-kill-all-sessions");
    if (killAllBtn) {
        killAllBtn.addEventListener("click", async () => {
            if (!confirm(`⚠️ Kill all ${sessions.length} tenant session(s)?`)) return;
            const res = await adminDeleteAllSessions();
            if (!res.ok) alert(res.error?.message || "Failed to kill sessions");
            await refresh();
        });
    }
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(dateStr) {
    if (!dateStr) return '—';
    try {
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    } catch {
        return '—';
    }
}
