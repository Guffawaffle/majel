/**
 * Receipts API — import receipt tracking and undo.
 * All functions throw ApiError on failure.
 */

import { apiFetch, apiPost, pathEncode, qs } from "./fetch.js";
import type { ImportReceipt, UndoReceiptResult } from "../types.js";
import { runLockedMutation } from "./mutation.js";

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
  const data = await apiFetch<{ receipt: ImportReceipt }>(`/api/import/receipts/${pathEncode(id)}`);
  return data.receipt;
}

/** Undo an import receipt. */
export async function undoReceipt(id: string): Promise<UndoReceiptResult> {
  return runLockedMutation({
    label: `Undo receipt ${id}`,
    lockKey: `receipt:${id}`,
    mutationKey: "import-commit",
    mutate: async () => {
      const data = await apiPost<{ undo: UndoReceiptResult }>(`/api/import/receipts/${pathEncode(id)}/undo`, {});
      return data.undo;
    },
  });
}

/** Resolve conflicting items in a receipt. */
export async function resolveReceiptItems(
  id: string,
  resolvedItems: unknown,
): Promise<ImportReceipt> {
  return runLockedMutation({
    label: `Resolve receipt ${id}`,
    lockKey: `receipt:${id}`,
    mutationKey: "import-commit",
    mutate: async () => {
      const data = await apiPost<{ receipt: ImportReceipt }>(`/api/import/receipts/${pathEncode(id)}/resolve`, { resolvedItems });
      return data.receipt;
    },
  });
}
