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

import { apiFetch } from './_fetch.js';

/**
 * Send a chat message to the backend
 * @param {string} sessionId - Current session ID
 * @param {string} message - User message text
 * @returns {Promise<Object>} Unwrapped response data ({ answer, ... })
 * @throws {ApiError} On non-2xx responses
 */
export async function sendChat(sessionId, message) {
    return apiFetch("/api/chat", {
        method: "POST",
        headers: {
            "X-Session-Id": sessionId,
        },
        body: JSON.stringify({ message }),
    });
}

/**
 * Load conversation history from Lex memory
 * @returns {Promise<Object>} History data
 */
export async function loadHistory() {
    const data = await apiFetch("/api/history?source=lex&limit=20");
    return data || {};
}

/**
 * Search past conversations using recall
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
export async function searchRecall(query) {
    const data = await apiFetch(`/api/recall?q=${encodeURIComponent(query)}`);
    return data || {};
}
