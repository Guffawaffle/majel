/**
 * Receipts API — import receipt tracking and undo.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiPost, pathEncode, qs } from "./fetch.js";
import type { ImportReceipt, UndoReceiptResult } from "../types.js";

export interface ReceiptFilters {
  limit?: number;
  layer?: string;
}

/** Fetch import receipts with optional filters. */
export async function fetchReceipts(filters?: ReceiptFilters): Promise<ImportReceipt[]> {
  const data = await apiFetch<{ receipts: ImportReceipt[] }>(`/api/import/receipts${qs({ ...filters })}`);
  return data.receipts;
}

/** Fetch a single receipt by ID. */
export async function fetchReceipt(id: string): Promise<ImportReceipt> {
  return apiFetch<ImportReceipt>(`/api/import/receipts/${pathEncode(id)}`);
}

/** Undo an import receipt. */
export async function undoReceipt(id: string): Promise<UndoReceiptResult> {
  return apiPost<UndoReceiptResult>(`/api/import/receipts/${pathEncode(id)}/undo`, {});
}

/** Resolve conflicting items in a receipt. */
export async function resolveReceiptItems(
  id: string,
  resolvedItems: unknown,
): Promise<ImportReceipt> {
  return apiPost<ImportReceipt>(`/api/import/receipts/${pathEncode(id)}/resolve`, { resolvedItems });
}
