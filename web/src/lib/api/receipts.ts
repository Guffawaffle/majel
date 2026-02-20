/**
 * Receipts API — import receipt tracking and undo.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiPost, pathEncode, qs } from "./fetch.js";

export interface ReceiptFilters {
  limit?: number;
  layer?: string;
}

/** Fetch import receipts with optional filters. */
export async function fetchReceipts(filters?: ReceiptFilters): Promise<unknown[]> {
  const data = await apiFetch<{ receipts: unknown[] }>(`/api/import/receipts${qs({ ...filters })}`);
  return data.receipts;
}

/** Fetch a single receipt by ID. */
export async function fetchReceipt(id: string): Promise<unknown> {
  return apiFetch(`/api/import/receipts/${pathEncode(id)}`);
}

/** Undo an import receipt. */
export async function undoReceipt(id: string): Promise<unknown> {
  return apiPost(`/api/import/receipts/${pathEncode(id)}/undo`, {});
}

/** Resolve conflicting items in a receipt. */
export async function resolveReceiptItems(
  id: string,
  resolvedItems: unknown,
): Promise<unknown> {
  return apiPost(`/api/import/receipts/${pathEncode(id)}/resolve`, { resolvedItems });
}
