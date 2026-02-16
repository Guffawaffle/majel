/**
 * receipts.js — ADR-026 Import Receipt API Client
 *
 * @module  api/receipts
 * @layer   api-client
 * @domain  receipts
 * @depends api/_fetch
 *
 * Fetch wrappers for import receipt endpoints: list, detail, undo, resolve.
 */

import { apiFetch } from './_fetch.js';

// ─── Receipts ───────────────────────────────────────────────

export function fetchReceipts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.limit != null) params.set('limit', String(filters.limit));
    if (filters.layer) params.set('layer', filters.layer);
    const qs = params.toString();
    return apiFetch(`/api/import/receipts${qs ? `?${qs}` : ''}`);
}

export const fetchReceipt = (id) =>
    apiFetch(`/api/import/receipts/${id}`);

export const undoReceipt = (id) =>
    apiFetch(`/api/import/receipts/${id}/undo`, { method: 'POST' });

export const resolveReceiptItems = (id, resolvedItems) =>
    apiFetch(`/api/import/receipts/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolvedItems }),
    });
