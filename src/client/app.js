/**
 * app.js — Majel Frontend Logic
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Modern chat UI — vanilla JS, no build step.
 * Features: markdown rendering, auto-grow textarea, copy buttons,
 * suggestion chips, scroll-to-bottom, sidebar nav.
 */

// ─── Session ID ─────────────────────────────────────────────
// Each browser tab gets a unique session ID for conversation isolation.
const SESSION_ID = crypto.randomUUID();

// ─── DOM elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const chatForm = $("#chat-form");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");
const statusDot = $("#status-indicator");
const mobileStatusDot = $("#mobile-status-dot");
const statusText = $("#status-text");
const rosterBadge = $("#roster-status");
const historyBtn = $("#history-btn");
const recallBtn = $("#recall-btn");
const refreshRosterBtn = $("#refresh-roster-btn");
const diagnosticBtn = $("#diagnostic-btn");
const diagnosticDialog = $("#diagnostic-dialog");
const diagnosticClose = $("#diagnostic-close");
const diagnosticContent = $("#diagnostic-content");
const recallDialog = $("#recall-dialog");
const recallForm = $("#recall-form");
const recallInput = $("#recall-input");
const recallResults = $("#recall-results");
const recallClose = $("#recall-close");
const setupGuide = $("#setup-guide");
const chatArea = $("#chat-area");
const inputArea = $("#input-area");
const setupGemini = $("#setup-gemini");
const setupSheets = $("#setup-sheets");
const welcomeScreen = $("#welcome");
const scrollBottomBtn = $("#scroll-bottom");
const sidebar = $("#sidebar");
const sidebarToggle = $("#sidebar-toggle");
const sidebarOverlay = $("#sidebar-overlay");
const newChatBtn = $("#new-chat-btn");

// ─── State ──────────────────────────────────────────────────
let isOnline = false;
let hasMessages = false;

// ─── Markdown rendering (lightweight) ───────────────────────
function renderMarkdown(text) {
    // Escape HTML first
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
        return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code (`...`)
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold (**...**)
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Italic (*...*)
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

    // Headers (## ... at start of line)
    html = html.replace(/^### (.+)$/gm, '<p><strong style="font-size:1em">$1</strong></p>');
    html = html.replace(/^## (.+)$/gm, '<p><strong style="font-size:1.05em">$1</strong></p>');
    html = html.replace(/^# (.+)$/gm, '<p><strong style="font-size:1.1em">$1</strong></p>');

    // Blockquotes (> ...)
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists (- ... or * ...)
    html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Ordered lists (1. ...)
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
    // Wrap consecutive <li> not inside <ul> in <ol>
    html = html.replace(
        /(?<!<\/ul>)((?:<li>.*<\/li>\n?)+)(?!<\/ul>)/g,
        (match) => {
            // Only wrap if not already in a list
            if (match.includes("<ul>")) return match;
            return `<ol>${match}</ol>`;
        }
    );

    // Tables (| ... | ... |)
    const tableRegex = /((?:^\|.+\|\n?)+)/gm;
    html = html.replace(tableRegex, (tableBlock) => {
        const rows = tableBlock.trim().split("\n").filter(r => r.trim());
        if (rows.length < 2) return tableBlock;

        let table = "<table>";
        rows.forEach((row, i) => {
            // Skip separator row (|---|---|)
            if (/^\|[\s\-:]+\|$/.test(row.trim())) return;

            const cells = row.split("|").filter(c => c.trim() !== "");
            const tag = i === 0 ? "th" : "td";
            const rowTag = i === 0 ? "thead" : (i === 1 ? "tbody" : "");
            if (rowTag === "thead") table += "<thead>";
            if (rowTag === "tbody") table += "</thead><tbody>";
            table += "<tr>" + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join("") + "</tr>";
        });
        table += "</tbody></table>";
        return table;
    });

    // Paragraphs: split on double newlines
    html = html
        .split(/\n\n+/)
        .map((block) => {
            block = block.trim();
            if (!block) return "";
            // Don't wrap blocks that are already HTML elements
            if (/^<(pre|ul|ol|blockquote|table|h[1-6]|p|div)/.test(block)) {
                return block;
            }
            // Replace single newlines with <br> within a paragraph
            return `<p>${block.replace(/\n/g, "<br>")}</p>`;
        })
        .join("");

    return html;
}

// ─── Message rendering ──────────────────────────────────────
function addMessage(role, text, options = {}) {
    // Hide welcome screen on first message
    if (!hasMessages) {
        welcomeScreen.style.display = "none";
        hasMessages = true;
    }

    const row = document.createElement("div");
    const isSystem = role === "system";
    const isError = role === "error";
    const isUser = role === "user";

    row.className = `message-row ${isUser ? "user-row" : isError ? "error-row model-row" : isSystem ? "system-row" : "model-row"}`;

    // Avatar
    let avatarLabel, senderName;
    if (isUser) {
        avatarLabel = "You";
        senderName = "You";
    } else if (isSystem) {
        avatarLabel = "ℹ";
        senderName = "System";
    } else {
        avatarLabel = "M";
        senderName = "Majel";
    }

    // Format body
    let bodyHtml;
    if (isUser || isSystem || isError) {
        // Plain text with basic escaping
        bodyHtml = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>");
    } else {
        // Model gets markdown rendering
        bodyHtml = renderMarkdown(text);
    }

    // Copy button (model responses only)
    const actionsHtml =
        !isSystem && !isError
            ? `<div class="message-actions">
          <button class="action-btn copy-btn" data-text="${encodeURIComponent(text)}">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.5"/></svg>
            Copy
          </button>
        </div>`
            : "";

    row.innerHTML = `
    <div class="message-content">
      <div class="message-avatar">${avatarLabel}</div>
      <div class="message-body">
        <div class="message-sender">${senderName}</div>
        <div class="message-text">${bodyHtml}</div>
        ${actionsHtml}
      </div>
    </div>
  `;

    messagesEl.appendChild(row);
    scrollToBottom();

    // Return reference for potential updates
    return row;
}

function addTypingIndicator() {
    const row = document.createElement("div");
    row.className = "message-row model-row typing-row";
    row.id = "typing";
    row.innerHTML = `
    <div class="message-content">
      <div class="message-avatar" style="background: var(--accent-gold); color: var(--bg-primary);">M</div>
      <div class="message-body">
        <div class="message-sender" style="color: var(--accent-gold);">Majel</div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
    messagesEl.appendChild(row);
    scrollToBottom();
}

function removeTypingIndicator() {
    const el = document.getElementById("typing");
    if (el) el.remove();
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

// ─── Scroll-to-bottom button visibility ─────────────────────
chatArea.addEventListener("scroll", () => {
    const distFromBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
    if (distFromBottom > 200) {
        scrollBottomBtn.classList.remove("hidden");
    } else {
        scrollBottomBtn.classList.add("hidden");
    }
});

scrollBottomBtn.addEventListener("click", scrollToBottom);

// ─── Auto-grow textarea ─────────────────────────────────────
chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + "px";

    // Enable/disable send button based on content
    sendBtn.disabled = !chatInput.value.trim();
});

// Enter to send, Shift+Enter for newline
chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (chatInput.value.trim()) {
            chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
        }
    }
});

// ─── Copy button handler (event delegation) ─────────────────
messagesEl.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest(".copy-btn");
    if (!copyBtn) return;

    const text = decodeURIComponent(copyBtn.dataset.text);
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Copied!
    `;
        copyBtn.classList.add("copied");
        setTimeout(() => {
            copyBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.5"/></svg>
        Copy
      `;
            copyBtn.classList.remove("copied");
        }, 2000);
    } catch {
        // Fallback — do nothing
    }
});

// ─── Suggestion chips ───────────────────────────────────────
document.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
        const msg = btn.dataset.msg;
        chatInput.value = msg;
        chatInput.dispatchEvent(new Event("input"));
        chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
    });
});

// ─── Sidebar (mobile) ───────────────────────────────────────
if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        sidebarOverlay.classList.toggle("hidden");
    });
}

if (sidebarOverlay) {
    sidebarOverlay.addEventListener("click", () => {
        sidebar.classList.remove("open");
        sidebarOverlay.classList.add("hidden");
    });
}

// ─── New chat ───────────────────────────────────────────────
newChatBtn.addEventListener("click", () => {
    messagesEl.innerHTML = "";
    hasMessages = false;
    welcomeScreen.style.display = "";
    chatInput.value = "";
    chatInput.style.height = "auto";
    sendBtn.disabled = true;
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
});

// ─── API calls ──────────────────────────────────────────────
async function checkHealth() {
    try {
        const res = await fetch("/api/health");
        const data = await res.json();

        isOnline = data.status === "online";

        // Status dots
        const dotClass = isOnline && data.gemini === "connected"
            ? "status-dot online"
            : isOnline
                ? "status-dot loading"
                : "status-dot loading";

        statusDot.className = dotClass;
        if (mobileStatusDot) mobileStatusDot.className = dotClass;

        statusText.textContent = isOnline && data.gemini === "connected"
            ? "Online"
            : isOnline
                ? "Setup needed"
                : "Initializing...";

        // Fleet data badge (new shape)
        if (data.fleet?.loaded) {
            const sectionInfo = data.fleet.sections?.map(s => `${s.label}: ${s.rows}`).join(", ") || "";
            rosterBadge.textContent = `Fleet: ${data.fleet.totalChars?.toLocaleString() || "?"} chars ${sectionInfo ? `(${sectionInfo})` : ""}`;
            rosterBadge.className = "roster-badge loaded";
        } else if (data.fleet?.error) {
            rosterBadge.textContent = "Fleet: Error";
            rosterBadge.className = "roster-badge error";
        } else {
            rosterBadge.textContent = "";
            rosterBadge.className = "roster-badge";
        }

        // Enable/disable input
        const canChat = data.gemini === "connected";
        chatInput.disabled = !canChat;
        if (!canChat) sendBtn.disabled = true;

        return data;
    } catch {
        statusDot.className = "status-dot offline";
        if (mobileStatusDot) mobileStatusDot.className = "status-dot offline";
        statusText.textContent = "Offline";
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
            headers: {
                "Content-Type": "application/json",
                "X-Session-Id": SESSION_ID,
            },
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
        sendBtn.disabled = !chatInput.value.trim();
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
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
}

async function searchRecall(query) {
    recallResults.innerHTML = '<p style="color: var(--text-muted); padding: 8px 0;">Searching...</p>';

    try {
        const res = await fetch(`/api/recall?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (!res.ok) {
            recallResults.innerHTML = `<p class="recall-item" style="color: var(--accent-red)">${data.error}</p>`;
            return;
        }

        if (data.results.length === 0) {
            recallResults.innerHTML = '<p class="recall-item" style="color: var(--text-muted)">No results found.</p>';
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
    rosterBadge.textContent = "Fleet: Loading...";
    rosterBadge.className = "roster-badge";

    try {
        const res = await fetch("/api/roster");
        const data = await res.json();

        if (res.ok) {
            const sectionInfo = data.sections?.map(s => `${s.label}: ${s.rows}`).join(", ") || "";
            rosterBadge.textContent = `Fleet: ${data.totalChars?.toLocaleString() || "?"} chars`;
            rosterBadge.className = "roster-badge loaded";
            addMessage("system", `Fleet data refreshed: ${sectionInfo || "loaded"}`);
        } else {
            rosterBadge.textContent = "Fleet: Error";
            rosterBadge.className = "roster-badge error";
            addMessage("error", `Fleet refresh failed: ${data.error}`);
        }
    } catch (err) {
        rosterBadge.textContent = "Fleet: Error";
        rosterBadge.className = "roster-badge error";
        addMessage("error", `Fleet refresh failed: ${err.message}`);
    }
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
}

// ─── Event handlers ─────────────────────────────────────────
chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg) return;

    addMessage("user", msg);
    chatInput.value = "";
    chatInput.style.height = "auto";
    sendBtn.disabled = true;
    sendChat(msg);
});

historyBtn.addEventListener("click", () => loadHistory());

recallBtn.addEventListener("click", () => {
    recallResults.innerHTML = "";
    recallInput.value = "";
    recallDialog.showModal();
    recallInput.focus();
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
});

recallForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = recallInput.value.trim();
    if (q) searchRecall(q);
});

recallClose.addEventListener("click", () => recallDialog.close());

refreshRosterBtn.addEventListener("click", () => refreshRoster());

// ─── Diagnostic ─────────────────────────────────────────────
diagnosticBtn.addEventListener("click", async () => {
    diagnosticContent.innerHTML = '<p class="diagnostic-loading">Querying subsystems...</p>';
    diagnosticDialog.showModal();
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
    try {
        const res = await fetch("/api/diagnostic");
        const data = await res.json();
        diagnosticContent.innerHTML = renderDiagnostic(data);
    } catch {
        diagnosticContent.innerHTML = '<p class="diagnostic-error">Failed to reach /api/diagnostic</p>';
    }
});

diagnosticClose.addEventListener("click", () => diagnosticDialog.close());

function renderDiagnostic(d) {
    const status = (s) => s === "connected" || s === "active" || s === "loaded"
        ? `<span class="diag-ok">${s}</span>`
        : `<span class="diag-warn">${s}</span>`;

    let html = '<div class="diag-grid">';

    // System
    html += '<div class="diag-section">';
    html += '<h4>System</h4>';
    html += `<div class="diag-row"><span>Version</span><span>${d.system?.version || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Uptime</span><span>${d.system?.uptime || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Node</span><span>${d.system?.nodeVersion || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Timestamp</span><span>${d.system?.timestamp?.slice(0, 19).replace("T", " ") || "?"}</span></div>`;
    html += '</div>';

    // Gemini
    html += '<div class="diag-section">';
    html += '<h4>Gemini Engine</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.gemini?.status)}</div>`;
    if (d.gemini?.model) html += `<div class="diag-row"><span>Model</span><span>${d.gemini.model}</span></div>`;
    if (d.gemini?.sessionMessageCount !== undefined) html += `<div class="diag-row"><span>Session msgs</span><span>${d.gemini.sessionMessageCount}</span></div>`;
    html += '</div>';

    // Memory
    html += '<div class="diag-section">';
    html += '<h4>Lex Memory</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.memory?.status)}</div>`;
    if (d.memory?.frameCount !== undefined) html += `<div class="diag-row"><span>Frames</span><span>${d.memory.frameCount}</span></div>`;
    html += '</div>';

    // Settings
    html += '<div class="diag-section">';
    html += '<h4>Settings Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.settings?.status)}</div>`;
    if (d.settings?.userOverrides !== undefined) html += `<div class="diag-row"><span>Overrides</span><span>${d.settings.userOverrides}</span></div>`;
    html += '</div>';

    // Fleet
    html += '<div class="diag-section">';
    html += '<h4>Fleet Data</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.fleet?.status)}</div>`;
    if (d.fleet?.totalChars) html += `<div class="diag-row"><span>Size</span><span>${d.fleet.totalChars.toLocaleString()} chars</span></div>`;
    if (d.fleet?.sections) html += `<div class="diag-row"><span>Sections</span><span>${d.fleet.sections.length}</span></div>`;
    if (d.fleet?.fetchedAt) html += `<div class="diag-row"><span>Fetched</span><span>${d.fleet.fetchedAt.slice(0, 19).replace("T", " ")}</span></div>`;
    if (d.fleet?.error) html += `<div class="diag-row"><span>Error</span><span class="diag-warn">${d.fleet.error}</span></div>`;
    html += '</div>';

    // Sheets
    html += '<div class="diag-section">';
    html += '<h4>Google Sheets</h4>';
    html += `<div class="diag-row"><span>Credentials</span><span>${d.sheets?.credentialsPresent ? "present" : "missing"}</span></div>`;
    html += '</div>';

    html += '</div>';
    return html;
}

// ─── View switching ─────────────────────────────────────────
function showSetup(health) {
    setupGuide.classList.remove("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");

    if (health.gemini === "connected") {
        setupGemini.classList.add("done");
    } else {
        setupGemini.classList.remove("done");
    }
    if (health.credentials && health.fleet?.loaded) {
        setupSheets.classList.add("done");
    }
}

function showChat(health) {
    setupGuide.classList.add("hidden");
    chatArea.classList.remove("hidden");
    inputArea.classList.remove("hidden");

    if (!hasMessages) {
        // Show welcome screen — messages will hide it when they start
        welcomeScreen.style.display = "";
    }
}

// ─── Init ───────────────────────────────────────────────────
let currentMode = "loading";

(async () => {
    const health = await checkHealth();

    if (!health) {
        chatArea.classList.remove("hidden");
        inputArea.classList.add("hidden");
        welcomeScreen.style.display = "none";
        hasMessages = true;
        addMessage("error", "Could not connect to Majel server. Is it running?");
        addMessage("system", "Expected: npm run dev");
        currentMode = "loading";
    } else if (health.gemini !== "connected") {
        showSetup(health);
        currentMode = "setup";
    } else {
        showChat(health);
        currentMode = "chat";
        chatInput.focus();
    }

    // Poll health every 10s
    setInterval(async () => {
        const h = await checkHealth();
        if (!h) return;

        if (currentMode === "setup" && h.gemini === "connected") {
            showChat(h);
            currentMode = "chat";
            addMessage("system", "✅ Configuration detected — Majel is online, Admiral.");
            chatInput.focus();
        } else if (currentMode === "chat" && h.gemini !== "connected") {
            showSetup(h);
            currentMode = "setup";
        }
    }, 10000);
})();
