/**
 * receipts.ts — ADR-026 Import Receipt API Routes
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides receipt listing, detail, undo, and resolve endpoints.
 *
 * Pattern: factory function createReceiptRoutes(appState) → Router
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";

export function createReceiptRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  router.use("/api/import", visitor);

  /** Guard: return receipt store or 503 */
  function getStore() {
    return appState.receiptStore;
  }

  // ── List receipts ─────────────────────────────────────

  router.get("/api/import/receipts", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const layer = req.query.layer as string | undefined;
    if (layer && !["reference", "ownership", "composition"].includes(layer)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, 'layer must be one of: reference, ownership, composition', 400);
    }
    const receipts = await store.listReceipts(limit, layer as "reference" | "ownership" | "composition" | undefined);
    sendOk(res, { receipts, count: receipts.length });
  });

  // ── Get receipt ───────────────────────────────────────

  router.get("/api/import/receipts/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);
    const receipt = await store.getReceipt(id);
    if (!receipt) return sendFail(res, ErrorCode.NOT_FOUND, `Receipt ${id} not found`, 404);
    sendOk(res, { receipt });
  });

  // ── Undo receipt ──────────────────────────────────────

  router.post("/api/import/receipts/:id/undo", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);
    const result = await store.undoReceipt(id);
    if (!result.success) {
      const status = result.message.includes("not found") ? 404 : 409;
      return sendFail(res, status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT, result.message, status);
    }
    sendOk(res, { undo: result });
  });

  // ── Resolve receipt items (ADR-026a A4) ───────────────

  router.post("/api/import/receipts/:id/resolve", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);
    const { resolvedItems } = req.body;
    if (!Array.isArray(resolvedItems)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "resolvedItems must be an array", 400);
    }
    try {
      const updated = await store.resolveReceiptItems(id, resolvedItems);
      sendOk(res, { receipt: updated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return sendFail(res, ErrorCode.NOT_FOUND, msg, 404);
      }
      return sendFail(res, ErrorCode.INTERNAL_ERROR, msg, 500);
    }
  });

  return router;
}
