/**
 * app.js — Majel Frontend Logic
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Vanilla JS — no build step, served as static file.
 */

// ─── DOM elements ───────────────────────────────────────────
const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const statusDot = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const rosterBadge = document.getElementById("roster-status");
const historyBtn = document.getElementById("history-btn");
const recallBtn = document.getElementById("recall-btn");
const refreshRosterBtn = document.getElementById("refresh-roster-btn");
const recallDialog = document.getElementById("recall-dialog");
const recallForm = document.getElementById("recall-form");
const recallInput = document.getElementById("recall-input");
const recallResults = document.getElementById("recall-results");
const recallClose = document.getElementById("recall-close");
const setupGuide = document.getElementById("setup-guide");
const chatArea = document.getElementById("chat-area");
const setupGemini = document.getElementById("setup-gemini");
const setupSheets = document.getElementById("setup-sheets");
const footerEl = document.querySelector("footer");

// ─── State ──────────────────────────────────────────────────
let isOnline = false;

// ─── Message rendering ──────────────────────────────────────
function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `message ${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
}

function addTypingIndicator() {
    const div = document.createElement("div");
    div.className = "typing-indicator";
    div.id = "typing";
    div.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(div);
    scrollToBottom();
}

function removeTypingIndicator() {
    const el = document.getElementById("typing");
    if (el) el.remove();
}

function scrollToBottom() {
    const chatArea = document.getElementById("chat-area");
    chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── API calls ──────────────────────────────────────────────
async function checkHealth() {
    try {
        const res = await fetch("/api/health");
        const data = await res.json();

        isOnline = data.status === "online";

        // Status dot reflects server reachability
        if (isOnline && data.gemini === "connected") {
            statusDot.className = "status-dot online";
            statusText.textContent = "Majel online";
        } else if (isOnline) {
            statusDot.className = "status-dot loading";
            statusText.textContent = "Setup needed";
        } else {
            statusDot.className = "status-dot loading";
            statusText.textContent = "Initializing...";
        }

        // Roster badge
        if (data.roster?.loaded) {
            rosterBadge.textContent = `Roster: ${data.roster.chars.toLocaleString()} chars`;
            rosterBadge.className = "roster-badge loaded";
        } else if (data.roster?.error) {
            rosterBadge.textContent = "Roster: Error";
            rosterBadge.className = "roster-badge error";
        } else {
            rosterBadge.textContent = "";
            rosterBadge.className = "roster-badge";
        }

        // Enable/disable chat input
        const canChat = data.gemini === "connected";
        chatInput.disabled = !canChat;
        sendBtn.disabled = !canChat;

        return data;
    } catch {
        statusDot.className = "status-dot offline";
        statusText.textContent = "Server offline";
        rosterBadge.textContent = "";
        chatInput.disabled = true;
        sendBtn.disabled = true;
        return null;
    }
}

async function sendChat(message) {
    chatInput.disabled = true;
    sendBtn.disabled = true;
    addTypingIndicator();

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        });

        removeTypingIndicator();
        const data = await res.json();

        if (res.ok) {
            addMessage("model", data.answer);
        } else {
            addMessage("error", `Error: ${data.error}`);
        }
    } catch (err) {
        removeTypingIndicator();
        addMessage("error", `Connection error: ${err.message}`);
    } finally {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
    }
}

async function loadHistory() {
    try {
        const res = await fetch("/api/history?source=lex&limit=20");
        const data = await res.json();

        if (data.lex && data.lex.length > 0) {
            addMessage("system", `── Lex Memory: ${data.lex.length} past conversations ──`);
            data.lex.forEach((item) => {
                const time = new Date(item.timestamp).toLocaleString();
                addMessage("system", `[${time}] ${item.summary}`);
            });
        } else {
            addMessage("system", "No conversation history found in Lex memory.");
        }
    } catch (err) {
        addMessage("error", `Failed to load history: ${err.message}`);
    }
}

async function searchRecall(query) {
    recallResults.innerHTML = "<p style='color: var(--text-muted)'>Searching...</p>";

    try {
        const res = await fetch(`/api/recall?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (!res.ok) {
            recallResults.innerHTML = `<p class="recall-item" style="color: var(--accent-red)">${data.error}</p>`;
            return;
        }

        if (data.results.length === 0) {
            recallResults.innerHTML = '<p class="recall-item">No results found.</p>';
            return;
        }

        recallResults.innerHTML = data.results
            .map(
                (r) => `
        <div class="recall-item">
          <div>${r.summary}</div>
          <div class="timestamp">${new Date(r.timestamp).toLocaleString()}</div>
          ${r.keywords?.length ? `<div class="timestamp">Keywords: ${r.keywords.join(", ")}</div>` : ""}
        </div>
      `
            )
            .join("");
    } catch (err) {
        recallResults.innerHTML = `<p class="recall-item" style="color: var(--accent-red)">Error: ${err.message}</p>`;
    }
}

async function refreshRoster() {
    rosterBadge.textContent = "Roster: Loading...";
    rosterBadge.className = "roster-badge";

    try {
        const res = await fetch("/api/roster");
        const data = await res.json();

        if (res.ok) {
            rosterBadge.textContent = `Roster: ${data.chars.toLocaleString()} chars (${data.rows} rows)`;
            rosterBadge.className = "roster-badge loaded";
            addMessage("system", `Roster refreshed: ${data.rows} rows loaded.`);
        } else {
            rosterBadge.textContent = "Roster: Error";
            rosterBadge.className = "roster-badge error";
            addMessage("error", `Roster refresh failed: ${data.error}`);
        }
    } catch (err) {
        rosterBadge.textContent = "Roster: Error";
        rosterBadge.className = "roster-badge error";
        addMessage("error", `Roster refresh failed: ${err.message}`);
    }
}

// ─── Event handlers ─────────────────────────────────────────
chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    addMessage("user", msg);
    chatInput.value = "";
    sendChat(msg);
});

historyBtn.addEventListener("click", () => loadHistory());

recallBtn.addEventListener("click", () => {
    recallResults.innerHTML = "";
    recallInput.value = "";
    recallDialog.showModal();
    recallInput.focus();
});

recallForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = recallInput.value.trim();
    if (q) searchRecall(q);
});

recallClose.addEventListener("click", () => recallDialog.close());

refreshRosterBtn.addEventListener("click", () => refreshRoster());

// ─── View switching ─────────────────────────────────────────
function showSetup(health) {
    setupGuide.classList.remove("hidden");
    chatArea.classList.add("hidden");
    footerEl.classList.add("hidden");

    // Mark completed sections
    if (health.gemini === "connected") {
        setupGemini.classList.add("done");
    } else {
        setupGemini.classList.remove("done");
    }
    if (health.credentials && health.roster?.loaded) {
        setupSheets.classList.add("done");
    }
}

function showChat(health) {
    setupGuide.classList.add("hidden");
    chatArea.classList.remove("hidden");
    footerEl.classList.remove("hidden");

    // Only add welcome messages once
    if (!messagesEl.hasChildNodes()) {
        addMessage("system", "🖖 Majel online. Awaiting input, Admiral.");
        if (health.roster?.loaded) {
            addMessage("system", `Roster loaded — ${health.roster.chars.toLocaleString()} chars of fleet data.`);
        } else if (!health.credentials) {
            addMessage("system", "ℹ️ Google Sheets not configured — chat works without roster data.");
        } else {
            addMessage("system", "ℹ️ Roster not loaded yet. Use \"Refresh Roster\" below to connect.");
        }
    }
}

// ─── Init ───────────────────────────────────────────────────
let currentMode = "loading"; // "loading" | "setup" | "chat"

(async () => {
    const health = await checkHealth();

    if (!health) {
        // Server unreachable
        chatArea.classList.remove("hidden");
        footerEl.classList.add("hidden");
        addMessage("error", "Could not connect to Majel server. Is it running?");
        addMessage("system", "Expected: npm run dev");
        currentMode = "loading";
    } else if (health.gemini !== "connected") {
        showSetup(health);
        currentMode = "setup";
    } else {
        showChat(health);
        currentMode = "chat";
    }

    // Poll health every 10s — auto-transition when config changes
    setInterval(async () => {
        const h = await checkHealth();
        if (!h) return;

        if (currentMode === "setup" && h.gemini === "connected") {
            // Config was fixed! Switch to chat mode
            showChat(h);
            currentMode = "chat";
            addMessage("system", "✅ Configuration detected. Majel is now online!");
        } else if (currentMode === "chat" && h.gemini !== "connected") {
            // Lost config somehow
            showSetup(h);
            currentMode = "setup";
        }
    }, 10000);
})();