/**
 * sessions.js — Session Management
 * 
 * Majel — STFC Fleet Intelligence System
 * Handles session list, creation, switching, deletion, and sidebar navigation.
 */

import { fetchSessions, getCachedSessions, restoreSession as apiRestoreSession, deleteSession } from './api/sessions.js';
import * as chat from './chat.js';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const sessionListEl = $("#session-list");
const newChatBtn = $("#new-chat-btn");
const sidebar = $("#sidebar");
const sidebarToggle = $("#sidebar-toggle");
const sidebarOverlay = $("#sidebar-overlay");

// ─── State ──────────────────────────────────────────────────
let currentSessionId = crypto.randomUUID();
let isRestoredSession = false;

/**
 * Get the current session ID
 * @returns {string} Current session ID
 */
export function getCurrentSessionId() {
    return currentSessionId;
}

/**
 * Check if current session is restored
 * @returns {boolean} True if restored
 */
export function isRestored() {
    return isRestoredSession;
}

/**
 * Escape HTML entities
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Close the mobile sidebar
 */
function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
}

/**
 * Render the session list
 */
function renderSessionList() {
    if (!sessionListEl) return;

    const sessions = getCachedSessions();

    if (sessions.length === 0) {
        sessionListEl.innerHTML = '<div class="session-empty">No saved chats yet</div>';
        return;
    }

    sessionListEl.innerHTML = sessions.map((s) => {
        const isActive = s.id === currentSessionId;
        const preview = s.preview
            ? s.preview.length > 40 ? s.preview.slice(0, 40) + "…" : s.preview
            : "Empty session";
        return `
      <div class="session-item ${isActive ? "active" : ""}" data-session-id="${s.id}">
        <div class="session-item-content">
          <span class="session-item-title">${escapeHtml(s.title)}</span>
          <span class="session-item-preview">${escapeHtml(preview)}</span>
        </div>
        <button class="session-delete" data-delete-id="${s.id}" title="Delete session">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </div>`;
    }).join("");

    // Attach click handlers
    sessionListEl.querySelectorAll(".session-item").forEach((el) => {
        el.addEventListener("click", (e) => {
            // Don't restore if clicking delete button
            if (e.target.closest(".session-delete")) return;
            const id = el.dataset.sessionId;
            if (id && id !== currentSessionId) {
                restoreSession(id);
            }
        });
    });

    // Attach delete handlers
    sessionListEl.querySelectorAll(".session-delete").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const id = btn.dataset.deleteId;
            if (!id) return;

            const success = await deleteSession(id);
            if (success) {
                await refreshSessionList();
                // If we deleted the active session, start fresh
                if (id === currentSessionId) {
                    newChatBtn.click();
                }
            }
        });
    });
}

/**
 * Restore a session by ID
 * @param {string} id - Session ID to restore
 */
async function restoreSession(id) {
    try {
        const session = await apiRestoreSession(id);
        if (!session) return;

        // Update session tracking
        currentSessionId = id;
        isRestoredSession = true;
        chat.setSessionId(id);

        // Clear current messages
        chat.clearMessages();

        // Replay messages
        if (session.messages && session.messages.length > 0) {
            session.messages.forEach((msg) => {
                chat.addMessage(msg.role, msg.text, { skipSave: true });
            });
        }

        // Update active state in sidebar
        renderSessionList();

        // Close sidebar on mobile
        closeSidebar();

        // Focus input
        const chatInput = $("#chat-input");
        if (chatInput) chatInput.focus();
    } catch (err) {
        chat.addMessage("error", `Failed to load session: ${err.message}`);
    }
}

/**
 * Refresh the session list from the server
 */
async function refreshSessionList() {
    await fetchSessions();
    renderSessionList();
}

/**
 * Start a new chat session
 */
function startNewChat() {
    currentSessionId = crypto.randomUUID();
    isRestoredSession = false;
    chat.setSessionId(currentSessionId);
    chat.clearMessages();
    refreshSessionList();
    closeSidebar();

    // Focus input
    const chatInput = $("#chat-input");
    if (chatInput) chatInput.focus();
}

// ─── Event Handlers ─────────────────────────────────────────
/**
 * Initialize sessions module
 */
export function init() {
    // Set initial session ID in chat module
    chat.setSessionId(currentSessionId);

    // New chat button
    newChatBtn.addEventListener("click", startNewChat);

    // Sidebar toggle (mobile)
    if (sidebarToggle) {
        sidebarToggle.addEventListener("click", () => {
            sidebar.classList.toggle("open");
            sidebarOverlay.classList.toggle("hidden");
        });
    }

    // Sidebar overlay click (mobile)
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener("click", closeSidebar);
    }

    // Initial session list load
    refreshSessionList();
}

/**
 * Export refresh function for use by other modules
 */
export { refreshSessionList };
