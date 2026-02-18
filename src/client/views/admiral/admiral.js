/**
 * admiral.js — Admiral Console Module (ADR-020)
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
import { esc } from 'utils/escape.js';
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
// View ID 'admiral' matches sidebar data-view and DOM #admiral-area.
registerView('admiral', {
    area: $('#admiral-area'),
    icon: '🛡️', title: 'Admiral Console', subtitle: 'User management, invites & sessions',
    cssHref: 'views/admiral/admiral.css',
    init, refresh,
    gate: 'admiral',
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $("#admiral-area");
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
    const area = $("#admiral-area");
    if (!area) return;

    area.innerHTML = `
        <div class="admiral-tabs">
            <button class="admiral-tab ${activeTab === 'users' ? 'active' : ''}" data-tab="users">👥 Users</button>
            <button class="admiral-tab ${activeTab === 'invites' ? 'active' : ''}" data-tab="invites">🎫 Invites</button>
            <button class="admiral-tab ${activeTab === 'sessions' ? 'active' : ''}" data-tab="sessions">🔑 Sessions</button>
        </div>
        <div class="admiral-panel">
            ${loading ? '<div class="admiral-loading">Loading…</div>' : renderActiveTab()}
        </div>
    `;

    // Wire tab buttons
    area.querySelectorAll(".admiral-tab").forEach(btn => {
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
        return '<div class="admiral-empty">No registered users.</div>';
    }

    const rows = users.map(u => {
        const isSelf = u.email === currentUserEmail;
        const isLocked = !!u.lockedAt;
        const roleOptions = ['ensign', 'lieutenant', 'captain', 'admiral']
            .map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`)
            .join('');

        return `
            <tr class="${isLocked ? 'admiral-row-locked' : ''}">
                <td class="admiral-cell-email" title="${esc(u.email)}">${esc(u.email)}</td>
                <td>${esc(u.displayName)}</td>
                <td>
                    <select class="admiral-role-select" data-email="${esc(u.email)}" ${isSelf ? 'disabled title="Cannot change own role"' : ''}>
                        ${roleOptions}
                    </select>
                </td>
                <td>${u.emailVerified ? '✅' : '❌'}</td>
                <td>${isLocked ? '🔒' : '—'}</td>
                <td class="admiral-cell-date">${fmtDate(u.createdAt)}</td>
                <td class="admiral-cell-actions">
                    <button class="admiral-btn-lock" data-email="${esc(u.email)}" data-locked="${isLocked}" ${isSelf ? 'disabled' : ''}>
                        ${isLocked ? '🔓 Unlock' : '🔒 Lock'}
                    </button>
                    <button class="admiral-btn-delete-user" data-email="${esc(u.email)}" ${isSelf ? 'disabled' : ''}>
                        🗑️
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="admiral-table-wrap">
            <table class="admiral-table">
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
        <div class="admiral-count">${users.length} user${users.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Invites Panel ──────────────────────────────────────────

function renderInvites() {
    const form = `
        <div class="admiral-invite-form">
            <input type="text" id="invite-label" placeholder="Label (optional)" class="admiral-input" />
            <input type="number" id="invite-max-uses" placeholder="Max uses" min="1" max="100" value="10" class="admiral-input admiral-input-sm" />
            <select id="invite-expiry" class="admiral-input admiral-input-sm">
                <option value="1h">1 hour</option>
                <option value="24h">24 hours</option>
                <option value="7d" selected>7 days</option>
                <option value="30d">30 days</option>
            </select>
            <button id="admiral-create-invite" class="admiral-btn-primary">+ Create</button>
        </div>
    `;

    if (!invites.length) {
        return form + '<div class="admiral-empty">No invite codes.</div>';
    }

    const rows = invites.map(inv => {
        const isExpired = inv.expiresAt && new Date(inv.expiresAt) < new Date();
        const isRevoked = inv.revoked;
        const status = isRevoked ? '❌ Revoked' : isExpired ? '⏰ Expired' : '✅ Active';
        const codeMasked = inv.code.slice(0, 6) + '…';

        return `
            <tr class="${isRevoked || isExpired ? 'admiral-row-muted' : ''}">
                <td>
                    <code class="admiral-code" title="${esc(inv.code)}">${codeMasked}</code>
                    <button class="admiral-btn-copy" data-code="${esc(inv.code)}" title="Copy code">📋</button>
                </td>
                <td>${esc(inv.label || '—')}</td>
                <td>${inv.usedCount ?? 0} / ${inv.maxUses ?? '∞'}</td>
                <td>${status}</td>
                <td class="admiral-cell-date">${fmtDate(inv.createdAt)}</td>
                <td class="admiral-cell-date">${inv.expiresAt ? fmtDate(inv.expiresAt) : 'Never'}</td>
                <td class="admiral-cell-actions">
                    ${!isRevoked ? `<button class="admiral-btn-revoke" data-code="${esc(inv.code)}">Revoke</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    return form + `
        <div class="admiral-table-wrap">
            <table class="admiral-table">
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
        <div class="admiral-count">${invites.length} invite${invites.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Sessions Panel ─────────────────────────────────────────

function renderSessions() {
    const killAllBtn = sessions.length > 0
        ? '<button id="admiral-kill-all-sessions" class="admiral-btn-danger">Kill All Sessions</button>'
        : '';

    if (!sessions.length) {
        return '<div class="admiral-empty">No active tenant sessions.</div>';
    }

    const rows = sessions.map(s => `
        <tr>
            <td><code class="admiral-code">${esc(s.tenantId?.slice(0, 12) ?? s.id?.slice(0, 12) ?? '?')}…</code></td>
            <td>${esc(s.inviteCode || '—')}</td>
            <td class="admiral-cell-date">${fmtDate(s.createdAt)}</td>
            <td class="admiral-cell-date">${fmtDate(s.lastSeenAt)}</td>
            <td class="admiral-cell-actions">
                <button class="admiral-btn-kill-session" data-id="${esc(s.tenantId || s.id)}">Kill</button>
            </td>
        </tr>
    `).join('');

    return `
        <div class="admiral-session-toolbar">${killAllBtn}</div>
        <div class="admiral-table-wrap">
            <table class="admiral-table">
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
        <div class="admiral-count">${sessions.length} session${sessions.length !== 1 ? 's' : ''}</div>
    `;
}

// ─── Action Wiring ──────────────────────────────────────────

function wireActions(area) {
    // Role change selects
    area.querySelectorAll(".admiral-role-select").forEach(sel => {
        sel.addEventListener("change", async () => {
            const email = sel.dataset.email;
            const role = sel.value;
            if (!confirm(`Change ${email} to ${role}?`)) {
                await refresh();
                return;
            }
            try {
                await adminSetRole(email, role);
            } catch (err) {
                alert(err.message || "Failed to set role");
            }
            await refresh();
        });
    });

    // Lock/unlock buttons
    area.querySelectorAll(".admiral-btn-lock").forEach(btn => {
        btn.addEventListener("click", async () => {
            const email = btn.dataset.email;
            const isLocked = btn.dataset.locked === 'true';
            const action = isLocked ? 'unlock' : 'lock';
            if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${email}?`)) return;
            try {
                await adminSetLock(email, !isLocked);
            } catch (err) {
                alert(err.message || `Failed to ${action}`);
            }
            await refresh();
        });
    });

    // Delete user buttons
    area.querySelectorAll(".admiral-btn-delete-user").forEach(btn => {
        btn.addEventListener("click", async () => {
            const email = btn.dataset.email;
            if (!confirm(`⚠️ Permanently delete ${email}? This cannot be undone.`)) return;
            try {
                await adminDeleteUser(email);
            } catch (err) {
                alert(err.message || "Failed to delete user");
            }
            await refresh();
        });
    });

    // Create invite button
    const createBtn = area.querySelector("#admiral-create-invite");
    if (createBtn) {
        createBtn.addEventListener("click", async () => {
            const label = area.querySelector("#invite-label")?.value?.trim() || undefined;
            const maxUses = parseInt(area.querySelector("#invite-max-uses")?.value, 10) || undefined;
            const expiresIn = area.querySelector("#invite-expiry")?.value || undefined;
            try {
                const data = await adminCreateInvite({ label, maxUses, expiresIn });
                if (data?.code) {
                    // Copy new code to clipboard
                    try { await navigator.clipboard.writeText(data.code); } catch (_) { /* clipboard not available */ }
                    alert(`Invite code created: ${data.code}\n(Copied to clipboard)`);
                }
            } catch (err) {
                alert(err.message || "Failed to create invite");
            }
            await refresh();
        });
    }

    // Copy code buttons
    area.querySelectorAll(".admiral-btn-copy").forEach(btn => {
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
    area.querySelectorAll(".admiral-btn-revoke").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Revoke this invite code?")) return;
            try {
                await adminRevokeInvite(btn.dataset.code);
            } catch (err) {
                alert(err.message || "Failed to revoke");
            }
            await refresh();
        });
    });

    // Kill single session
    area.querySelectorAll(".admiral-btn-kill-session").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (!confirm("Kill this session?")) return;
            try {
                await adminDeleteSession(btn.dataset.id);
            } catch (err) {
                alert(err.message || "Failed to kill session");
            }
            await refresh();
        });
    });

    // Kill all sessions
    const killAllBtn = area.querySelector("#admiral-kill-all-sessions");
    if (killAllBtn) {
        killAllBtn.addEventListener("click", async () => {
            if (!confirm(`⚠️ Kill all ${sessions.length} tenant session(s)?`)) return;
            try {
                await adminDeleteAllSessions();
            } catch (err) {
                alert(err.message || "Failed to kill sessions");
            }
            await refresh();
        });
    }
}

// ─── Helpers ────────────────────────────────────────────────

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
