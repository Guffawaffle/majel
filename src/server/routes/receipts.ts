/**
 * receipts.ts — ADR-026 Import Receipt API Routes
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides receipt listing, detail, undo, and resolve endpoints.
 *
 * Pattern: factory function createReceiptRoutes(appState) → Router
 */

import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { requireVisitor, requireAdmiral } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import { withUserScope } from "../db.js";

export function createReceiptRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  const admiral = requireAdmiral(appState);
  router.use("/api/import", visitor);

  /** Guard: return receipt store or 503 */
  function getStore(res: import("express").Response) {
    const userId = (res.locals.userId as string) || "local";
    return appState.receiptStoreFactory?.forUser(userId) ?? appState.receiptStore;
  }

  // ── List receipts ─────────────────────────────────────

  router.get("/api/import/receipts", async (req, res) => {
    const store = getStore(res);
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "limit must be an integer between 1 and 200", 400);
    }
    const layer = req.query.layer as string | undefined;
    if (layer && !["reference", "ownership", "composition"].includes(layer)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, 'layer must be one of: reference, ownership, composition', 400);
    }
    const receipts = await store.listReceipts(limit, layer as "reference" | "ownership" | "composition" | undefined);
    sendOk(res, { receipts, count: receipts.length });
  });

  // ── Get receipt ───────────────────────────────────────

  router.get("/api/import/receipts/:id", async (req, res) => {
    const store = getStore(res);
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);
    const receipt = await store.getReceipt(id);
    if (!receipt) return sendFail(res, ErrorCode.NOT_FOUND, `Receipt ${id} not found`, 404);
    sendOk(res, { receipt });
  });

  // ── Undo receipt ──────────────────────────────────────

  router.post("/api/import/receipts/:id/undo", admiral, async (req, res) => {
    const store = getStore(res);
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);

    const receipt = await store.getReceipt(id);
    if (!receipt) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Receipt ${id} not found`, 404);
    }

    if (receipt.layer === "composition") {
      const userId = (res.locals.userId as string) || "local";
      if (!appState.pool) {
        return sendFail(res, ErrorCode.CREW_STORE_NOT_AVAILABLE, "Database pool not available", 503);
      }

      const inverseRemoved = Array.isArray(receipt.inverse?.removed)
        ? (receipt.inverse.removed as Array<Record<string, unknown>>)
        : [];

      await withUserScope(appState.pool, userId, async (client) => {
        const loadoutIds = inverseRemoved
          .filter((item) => item.entityType === "loadout" && Number.isInteger(item.id))
          .map((item) => Number(item.id));
        const policyIds = inverseRemoved
          .filter((item) => item.entityType === "below_deck_policy" && Number.isInteger(item.id))
          .map((item) => Number(item.id));
        const bridgeCoreIds = inverseRemoved
          .filter((item) => item.entityType === "bridge_core" && Number.isInteger(item.id))
          .map((item) => Number(item.id));

        if (loadoutIds.length > 0) {
          await client.query(`DELETE FROM loadouts WHERE id = ANY($1::int[])`, [loadoutIds]);
        }
        if (policyIds.length > 0) {
          await client.query(`DELETE FROM below_deck_policies WHERE id = ANY($1::int[])`, [policyIds]);
        }
        if (bridgeCoreIds.length > 0) {
          await client.query(`DELETE FROM bridge_cores WHERE id = ANY($1::int[])`, [bridgeCoreIds]);
        }
      });

      return sendOk(res, {
        undo: {
          success: true,
          message: `Undo applied for receipt ${id} (composition)`,
          inverse: receipt.inverse,
        },
      });
    }

    const result = await store.undoReceipt(id);
    if (!result.success) {
      const status = result.message.includes("not found") ? 404 : 409;
      return sendFail(res, status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.CONFLICT, result.message, status);
    }
    sendOk(res, { undo: result });
  });

  // ── Resolve receipt items (ADR-026a A4) ───────────────

  router.post("/api/import/receipts/:id/resolve", admiral, async (req, res) => {
    const store = getStore(res);
    if (!store) return sendFail(res, ErrorCode.RECEIPT_STORE_NOT_AVAILABLE, "Receipt store not available", 503);
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid receipt ID", 400);
    const { resolvedItems } = req.body;
    if (!Array.isArray(resolvedItems)) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "resolvedItems must be an array", 400);
    }
    if (resolvedItems.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "resolvedItems must have 500 or fewer entries", 400);
    }
    for (const item of resolvedItems) {
      if (!item || typeof item !== "object") {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Each resolvedItem must be an object", 400);
      }
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
