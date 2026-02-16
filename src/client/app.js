/**
 * app.js — Majel Frontend Shell
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Thin initialization shell: health, auth, ops, recall, setup.
 * Views self-register with router via import side effects.
 */

import { getMe } from 'api/auth.js';
import { checkHealth } from 'api/health.js';
import { searchRecall as apiSearchRecall } from 'api/chat.js';
import { saveFleetSetting, loadFleetSettings } from 'api/settings.js';
import { _fetch } from 'api/_fetch.js';
import { esc } from 'utils/escape.js';
import * as chat from 'views/chat/chat.js';
import * as sessions from 'views/chat/sessions.js';
import * as catalog from 'views/catalog/catalog.js';
import * as admin from 'views/admiral/admiral.js';
import 'views/fleet/fleet.js';
import 'views/drydock/drydock.js';
import 'views/crew-builder/crew-builder.js';
import 'views/fleet-ops/fleet-ops.js';
import 'views/diagnostics/diagnostics.js';
import * as router from 'router';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusDot = $("#status-indicator");
const mobileStatusDot = $("#mobile-status-dot");
const statusText = $("#status-text");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");
const recallDialog = $("#recall-dialog");
const recallForm = $("#recall-form");
const recallInput = $("#recall-input");
const recallResults = $("#recall-results");
const recallClose = $("#recall-close");
const logoutBtn = $("#logout-btn");

// ─── State ──────────────────────────────────────────────────
let appState = "loading"; // "loading" | "setup" | "active"
let opsLevel = 1;
let userRole = null;

// ─── Ops Level ──────────────────────────────────────────────
async function initOpsLevel() {
    try {
        const settings = await loadFleetSettings();
        if (settings.settings) {
            const ol = settings.settings.find(s => s.key === "fleet.opsLevel");
            if (ol) opsLevel = parseInt(ol.value, 10) || 1;
        }
    } catch { /* ignore */ }
    const el = $("#ops-level-value");
    if (el) el.textContent = opsLevel;
}

// ─── Health Check ───────────────────────────────────────────
async function checkHealthAndUpdateUI() {
    const data = await checkHealth();
    if (!data) {
        if (statusDot) statusDot.className = "status-dot offline";
        if (mobileStatusDot) mobileStatusDot.className = "status-dot offline";
        if (statusText) statusText.textContent = "Offline";
        if (chatInput) chatInput.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
        return null;
    }

    const online = data.status === "online";
    const connected = online && data.gemini === "connected";
    const dotClass = connected ? "status-dot online" : online ? "status-dot loading" : "status-dot offline";
    if (statusDot) statusDot.className = dotClass;
    if (mobileStatusDot) mobileStatusDot.className = dotClass;
    if (statusText) statusText.textContent = connected ? "Online" : online ? "Setup needed" : "Offline";
    if (chatInput) chatInput.disabled = !connected;
    if (sendBtn && !connected) sendBtn.disabled = true;
    return data;
}

// ─── Recall Search ──────────────────────────────────────────
async function searchRecall(query) {
    recallResults.innerHTML = '<p class="recall-searching">Searching...</p>';
    try {
        const result = await apiSearchRecall(query);
        if (!result.ok) {
            recallResults.innerHTML = `<p class="recall-item recall-error">${esc(result.error?.message || "Error")}</p>`;
            return;
        }
        if (result.data.results.length === 0) {
            recallResults.innerHTML = '<p class="recall-item recall-empty">No results found.</p>';
            return;
        }
        recallResults.innerHTML = result.data.results
            .map((r) => `
        <div class="recall-item">
          <div>${esc(r.summary)}</div>
          <div class="timestamp">${new Date(r.timestamp).toLocaleString()}</div>
          ${r.keywords?.length ? `<div class="timestamp">Keywords: ${esc(r.keywords.join(", "))}</div>` : ""}
        </div>`).join("");
    } catch (err) {
        recallResults.innerHTML = `<p class="recall-item recall-error">Error: ${esc(err.message)}</p>`;
    }
}

// ─── Setup Guide ────────────────────────────────────────────
function showSetup(health) {
    for (const [, v] of router.getRegisteredViews()) {
        if (v.area) v.area.classList.add('hidden');
        for (const ex of v.extraAreas) { if (ex) ex.classList.add('hidden'); }
    }
    const setupGuide = $("#setup-guide");
    const setupGemini = $("#setup-gemini");
    if (setupGuide) setupGuide.classList.remove("hidden");
    const titleBar = $("#title-bar");
    if (titleBar) titleBar.classList.add("hidden");
    if (setupGemini) setupGemini.classList.toggle("done", health.gemini === "connected");
}

// ─── Event Handlers ─────────────────────────────────────────
const opsBtn = $("#ops-level-global");
if (opsBtn) {
    opsBtn.addEventListener("click", () => {
        const input = prompt("Enter your Ops Level (1-80):", opsLevel);
        if (input === null) return;
        const val = parseInt(input, 10);
        if (isNaN(val) || val < 1 || val > 80) {
            alert("Ops level must be between 1 and 80.");
            return;
        }
        opsLevel = val;
        saveFleetSetting("fleet.opsLevel", val);
        const el = $("#ops-level-value");
        if (el) el.textContent = opsLevel;
    });
}

const recallBtn = $("#recall-btn");
if (recallBtn) {
    recallBtn.addEventListener("click", () => {
        recallResults.innerHTML = "";
        recallInput.value = "";
        recallDialog.showModal();
        recallInput.focus();
    });
}
recallForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = recallInput.value.trim();
    if (q) searchRecall(q);
});
recallClose?.addEventListener("click", () => recallDialog.close());

if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        try { await _fetch("/api/auth/logout", { method: "POST" }); } catch { }
        window.location.href = "/";
    });
}

// ─── Init ───────────────────────────────────────────────────
(async () => {
    router.initRouting();

    // Chat + sessions: eager init (sidebar UI must be ready immediately)
    chat.init(sessions.refreshSessionList);
    sessions.init();
    router.markInitialized('chat');
    await initOpsLevel();

    // Auth & gating
    const me = await getMe();
    userRole = me?.role ?? null;
    router.setUserRoleFn(() => userRole);
    router.applySidebarGating();
    catalog.setAdminMode(userRole === 'admiral');
    admin.setCurrentUser(me?.email ?? null);

    // Initial health check
    const health = await checkHealthAndUpdateUI();
    if (!health) {
        await router.navigateToView('chat');
        const inputArea = $("#input-area");
        if (inputArea) inputArea.classList.add('hidden');
        appState = "loading";
    } else if (health.gemini !== "connected") {
        showSetup(health);
        appState = "setup";
    } else {
        const savedView = router.getViewFromHash();
        if (savedView && savedView !== 'chat') {
            await router.navigateToView(savedView);
        } else {
            await router.navigateToView('chat');
            chatInput.focus();
        }
        appState = "active";
    }

    // Health polling (10s)
    setInterval(async () => {
        const h = await checkHealthAndUpdateUI();
        if (!h) return;
        if ((appState === "setup" || appState === "loading") && h.gemini === "connected") {
            await router.navigateToView('chat');
            chatInput.focus();
            appState = "active";
        } else if (appState === "loading" && h.gemini !== "connected") {
            showSetup(h);
            appState = "setup";
        } else if (appState === "active" && h.gemini !== "connected"
            && router.getCurrentView() === 'chat') {
            showSetup(h);
            appState = "setup";
        }
    }, 10000);
})();
