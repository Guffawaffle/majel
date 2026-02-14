/**
 * chat.js — Chat & Recall API
 *
 * @module  api/chat
 * @layer   api-client
 * @domain  chat
 * @depends api/_fetch
 * @exports sendChat, loadHistory, searchRecall
 * @emits   none
 * @state   none
 */

import { _fetch } from './_fetch.js';

/**
 * Send a chat message to the backend
 * @param {string} sessionId - Current session ID
 * @param {string} message - User message text
 * @returns {Promise<Object>} Response envelope with data or error
 */
export async function sendChat(sessionId, message) {
    const res = await _fetch("/api/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Session-Id": sessionId,
        },
        body: JSON.stringify({ message }),
    });

    return {
        ok: res.ok,
        data: await res.json(),
    };
}

/**
 * Load conversation history from Lex memory
 * @returns {Promise<Object>} History data
 */
export async function loadHistory() {
    const res = await _fetch("/api/history?source=lex&limit=20");
    const data = (await res.json()).data || {};
    return data;
}

/**
 * Search past conversations using recall
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
export async function searchRecall(query) {
    const res = await _fetch(`/api/recall?q=${encodeURIComponent(query)}`);
    const _env = await res.json();
    return {
        ok: res.ok,
        data: _env.data || {},
        error: _env.error,
    };
}
