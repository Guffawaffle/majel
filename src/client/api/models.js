/**
 * models.js — Model Selection API
 *
 * @module  api/models
 * @layer   api-client
 * @domain  gemini
 * @depends api/_fetch
 * @exports fetchModels, selectModel
 * @emits   none
 * @state   none
 *
 * Client module for the model selector (Admiral-only).
 * See GET /api/models and POST /api/models/select.
 */

import { apiFetch } from './_fetch.js';

/**
 * Fetch available models and current selection.
 *
 * @returns {Promise<{
 *   current: string,
 *   defaultModel: string,
 *   currentDef: Object,
 *   models: Array<{id: string, name: string, tier: string, description: string, thinking: boolean, contextWindow: number, costRelative: number, speed: string, active: boolean}>
 * }>}
 * @throws {ApiError} On non-2xx responses
 */
export async function fetchModels() {
    return apiFetch('/api/models');
}

/**
 * Switch the active Gemini model (Admiral only).
 * Clears all chat sessions on the server side.
 *
 * @param {string} modelId - The model ID to switch to
 * @returns {Promise<{
 *   previousModel: string,
 *   currentModel: string,
 *   modelDef: Object,
 *   sessionsCleared: boolean,
 *   hints: string[]
 * }>}
 * @throws {ApiError} On non-2xx responses
 */
export async function selectModel(modelId) {
    return apiFetch('/api/models/select', {
        method: 'POST',
        body: JSON.stringify({ model: modelId }),
    });
}
