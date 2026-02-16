/**
 * chat.js — Chat View Logic
 * 
 * Majel — STFC Fleet Intelligence System
 * Handles chat UI, message rendering, markdown, and input controls.
 */

import { sendChat as apiSendChat } from 'api/chat.js';
import { ApiError } from 'api/_fetch.js';
import { registerView } from 'router';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const chatForm = $("#chat-form");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");
const chatArea = $("#chat-area");
const scrollBottomBtn = $("#scroll-bottom");
const welcomeScreen = $("#welcome");
const inputArea = $("#input-area");

// ─── View Registration ──────────────────────────────────────
registerView('chat', {
    area: chatArea,
    extraAreas: [inputArea],
    icon: '💬', title: 'Chat', subtitle: 'Gemini-powered fleet advisor',
    cssHref: 'views/chat/chat.css',
    refresh: () => { },
});

// ─── State ──────────────────────────────────────────────────
let hasMessages = false;
let currentSessionId = null;

// ─── Markdown Rendering ─────────────────────────────────────
function renderMarkdown(text) {
    if (text == null) return '<em>(no response)</em>';
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
    html = html.replace(/^### (.+)$/gm, '<p><strong class="md-h3">$1</strong></p>');
    html = html.replace(/^## (.+)$/gm, '<p><strong class="md-h2">$1</strong></p>');
    html = html.replace(/^# (.+)$/gm, '<p><strong class="md-h1">$1</strong></p>');

    // Blockquotes (> ...)
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // Unordered lists (- ... or * ...)
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    // Wrap consecutive <li> in <ul> - safer approach without nested quantifiers
    const lines = html.split('\n');
    const ulProcessed = [];
    let inUlList = false;
    for (const line of lines) {
        if (line.trim().startsWith('<li>') && line.trim().endsWith('</li>')) {
            if (!inUlList) {
                ulProcessed.push('<ul>');
                inUlList = true;
            }
            ulProcessed.push(line);
        } else {
            if (inUlList) {
                ulProcessed.push('</ul>');
                inUlList = false;
            }
            ulProcessed.push(line);
        }
    }
    if (inUlList) ulProcessed.push('</ul>');
    html = ulProcessed.join('\n');

    // Ordered lists (1. ...)
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
    // Wrap consecutive <li> not inside <ul> in <ol> - safer approach
    const lines2 = html.split('\n');
    const olProcessed = [];
    let inOlList = false;
    let insideUl = false;
    for (const line of lines2) {
        const trimmed = line.trim();
        if (trimmed === '<ul>') {
            insideUl = true;
            if (inOlList) {
                olProcessed.push('</ol>');
                inOlList = false;
            }
            olProcessed.push(line);
        } else if (trimmed === '</ul>') {
            insideUl = false;
            olProcessed.push(line);
        } else if (trimmed.startsWith('<li>') && trimmed.endsWith('</li>') && !insideUl) {
            if (!inOlList) {
                olProcessed.push('<ol>');
                inOlList = true;
            }
            olProcessed.push(line);
        } else {
            if (inOlList && trimmed) {
                olProcessed.push('</ol>');
                inOlList = false;
            }
            olProcessed.push(line);
        }
    }
    if (inOlList) olProcessed.push('</ol>');
    html = olProcessed.join('\n');

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

// ─── Message Rendering ──────────────────────────────────────
/**
 * Add a message to the chat
 * @param {string} role - Message role: 'user', 'model', 'system', or 'error'
 * @param {string} text - Message text
 * @param {Object} options - Optional config
 * @returns {HTMLElement} Message row element
 */
export function addMessage(role, text, options = {}) {
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
        avatarLabel = "A";
        senderName = "Aria";
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

/**
 * Add typing indicator
 */
export function addTypingIndicator() {
    const row = document.createElement("div");
    row.className = "message-row model-row typing-row";
    row.id = "typing";
    row.innerHTML = `
    <div class="message-content">
      <div class="message-avatar">A</div>
      <div class="message-body">
        <div class="message-sender">Aria</div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
    messagesEl.appendChild(row);
    scrollToBottom();
}

/**
 * Remove typing indicator
 */
export function removeTypingIndicator() {
    const el = document.getElementById("typing");
    if (el) el.remove();
}

/**
 * Scroll chat area to bottom
 */
export function scrollToBottom() {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

/**
 * Clear all messages from the chat
 */
export function clearMessages() {
    messagesEl.innerHTML = "";
    hasMessages = false;
    welcomeScreen.style.display = "flex";
}

/**
 * Set the current session ID for API calls
 * @param {string} sessionId - Session ID
 */
export function setSessionId(sessionId) {
    currentSessionId = sessionId;
}

/**
 * Send a chat message
 * @param {string} message - User message
 * @param {Function} onRefreshSessions - Callback to refresh session list
 */
async function sendChat(message, onRefreshSessions) {
    chatInput.disabled = true;
    sendBtn.disabled = true;
    addTypingIndicator();

    try {
        const data = await apiSendChat(currentSessionId, message);
        removeTypingIndicator();

        addMessage("model", data.answer);
        // Refresh session list (server already saved the messages)
        if (onRefreshSessions) onRefreshSessions();
    } catch (err) {
        removeTypingIndicator();
        if (err instanceof ApiError) {
            addMessage("error", `Error: ${err.message}`);
        } else {
            addMessage("error", `Connection error: ${err.message}`);
        }
    } finally {
        chatInput.disabled = false;
        sendBtn.disabled = !chatInput.value.trim();
        chatInput.focus();
    }
}

// ─── Event Handlers ─────────────────────────────────────────
/**
 * Initialize chat module event handlers
 * @param {Function} onRefreshSessions - Callback to refresh session list
 */
export function init(onRefreshSessions) {
    // Chat form submission
    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        if (!message) return;

        addMessage("user", message);
        chatInput.value = "";
        chatInput.style.height = "auto";
        sendBtn.disabled = true;

        sendChat(message, onRefreshSessions);
    });

    // Auto-grow textarea
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

    // Scroll-to-bottom button visibility
    chatArea.addEventListener("scroll", () => {
        const distFromBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
        if (distFromBottom > 200) {
            scrollBottomBtn.classList.remove("hidden");
        } else {
            scrollBottomBtn.classList.add("hidden");
        }
    });

    scrollBottomBtn.addEventListener("click", scrollToBottom);

    // Copy button handler (event delegation)
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

    // Suggestion chips
    document.querySelectorAll(".suggestion").forEach((btn) => {
        btn.addEventListener("click", () => {
            const msg = btn.dataset.msg;
            chatInput.value = msg;
            chatInput.dispatchEvent(new Event("input"));
            chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
        });
    });
}
