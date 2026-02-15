/**
 * routes/targets.ts — Target/goal tracking API routes (#17)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * CRUD for structured acquisition and progression targets.
 * All routes require visitor authentication.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { VALID_TARGET_TYPES, VALID_TARGET_STATUSES, type TargetType, type TargetStatus } from "../stores/target-store.js";
import { requireVisitor, requireAdmiral } from "../services/auth.js";
import { detectTargetConflicts } from "../services/target-conflicts.js";

export function createTargetRoutes(appState: AppState): Router {
  const router = Router();
  const visitor = requireVisitor(appState);
  const admiral = requireAdmiral(appState);
  router.use("/api/targets", visitor);

  /** Guard: return the store or 503 */
  function getStore() {
    return appState.targetStore;
  }

  // ─── List targets ─────────────────────────────────────────

  router.get("/api/targets", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const targetType = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    const priority = req.query.priority ? Number(req.query.priority) : undefined;
    const refId = req.query.ref_id as string | undefined;

    // Validate filters
    if (targetType && !VALID_TARGET_TYPES.includes(targetType as TargetType)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid target type: ${targetType}`, 400, {
        hints: [`Valid types: ${VALID_TARGET_TYPES.join(", ")}`],
      });
    }
    if (status && !VALID_TARGET_STATUSES.includes(status as TargetStatus)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid status: ${status}`, 400, {
        hints: [`Valid statuses: ${VALID_TARGET_STATUSES.join(", ")}`],
      });
    }
    if (priority !== undefined && (priority < 1 || priority > 3 || !Number.isInteger(priority))) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Priority must be 1, 2, or 3", 400);
    }
    if (refId && refId.length > 200) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "ref_id must be 200 characters or fewer", 400);
    }

    const filters: Record<string, unknown> = {};
    if (targetType) filters.targetType = targetType;
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (refId) filters.refId = refId;

    const targets = await store.list(Object.keys(filters).length > 0 ? filters as never : undefined);
    sendOk(res, { targets, count: targets.length });
  });

  // ─── Counts (must precede /:id to avoid param match) ─────

  router.get("/api/targets/counts", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);
    const counts = await store.counts();
    sendOk(res, counts);
  });

  // ─── Conflicts (#18, must precede /:id) ───────────────────

  router.get("/api/targets/conflicts", async (_req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);
    if (!appState.crewStore) return sendFail(res, ErrorCode.LOADOUT_STORE_NOT_AVAILABLE, "Crew store not available", 503);
    const conflicts = await detectTargetConflicts(store, appState.crewStore);
    sendOk(res, { conflicts, total: conflicts.length });
  });

  // ─── Get target ───────────────────────────────────────────

  router.get("/api/targets/:id", async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const id = Number(req.params.id);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid target ID", 400);

    const target = await store.get(id);
    if (!target) return sendFail(res, ErrorCode.NOT_FOUND, `Target not found: ${id}`, 404);
    sendOk(res, target);
  });

  // ─── Create target ───────────────────────────────────────

  router.post("/api/targets", admiral, async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const { targetType, refId, loadoutId, targetTier, targetRank, targetLevel, reason, priority, autoSuggested } = req.body;

    if (!targetType) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing required field: targetType", 400);
    }
    if (!VALID_TARGET_TYPES.includes(targetType)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid target type: ${targetType}`, 400, {
        hints: [`Valid types: ${VALID_TARGET_TYPES.join(", ")}`],
      });
    }

    // Officer and ship targets require refId
    if ((targetType === "officer" || targetType === "ship") && !refId) {
      return sendFail(res, ErrorCode.MISSING_PARAM, `${targetType} targets require refId`, 400);
    }
    if (refId && (typeof refId !== "string" || refId.length > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "refId must be a string of 200 characters or fewer", 400);
    }
    // Crew targets require loadoutId
    if (targetType === "crew" && !loadoutId) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Crew targets require loadoutId", 400);
    }
    if (loadoutId && (typeof loadoutId !== "string" || loadoutId.length > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "loadoutId must be a string of 200 characters or fewer", 400);
    }

    if (priority !== undefined && (priority < 1 || priority > 3)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Priority must be 1, 2, or 3", 400);
    }

    if (reason && typeof reason === "string" && reason.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Reason must be 500 characters or fewer", 400);
    }

    // Validate targetTier (integer 1–10)
    if (targetTier !== undefined && targetTier !== null) {
      if (typeof targetTier !== "number" || !Number.isInteger(targetTier) || targetTier < 1 || targetTier > 10) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetTier must be an integer between 1 and 10", 400);
      }
    }
    // Validate targetRank (string, max 50 chars)
    if (targetRank !== undefined && targetRank !== null) {
      if (typeof targetRank !== "string" || targetRank.length > 50) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetRank must be a string of 50 characters or fewer", 400);
      }
    }
    // Validate targetLevel (integer 1–200)
    if (targetLevel !== undefined && targetLevel !== null) {
      if (typeof targetLevel !== "number" || !Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetLevel must be an integer between 1 and 200", 400);
      }
    }

    try {
      const target = await store.create({
        targetType,
        refId: refId ?? null,
        loadoutId: loadoutId ?? null,
        targetTier: targetTier ?? null,
        targetRank: targetRank ?? null,
        targetLevel: targetLevel ?? null,
        reason: reason ?? null,
        priority: priority ?? 2,
        autoSuggested: autoSuggested ?? false,
      });
      sendOk(res, target, 201);
    } catch (err) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR,
        `Failed to create target: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  });

  // ─── Update target ───────────────────────────────────────

  router.patch("/api/targets/:id", admiral, async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const id = Number(req.params.id);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid target ID", 400);

    const { targetTier, targetRank, targetLevel, reason, priority, status } = req.body;

    if (priority !== undefined && (priority < 1 || priority > 3)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Priority must be 1, 2, or 3", 400);
    }
    if (status && !VALID_TARGET_STATUSES.includes(status)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Invalid status: ${status}`, 400, {
        hints: [`Valid statuses: ${VALID_TARGET_STATUSES.join(", ")}`],
      });
    }
    if (reason && typeof reason === "string" && reason.length > 500) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Reason must be 500 characters or fewer", 400);
    }
    // Validate targetTier (integer 1–10)
    if (targetTier !== undefined && targetTier !== null) {
      if (typeof targetTier !== "number" || !Number.isInteger(targetTier) || targetTier < 1 || targetTier > 10) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetTier must be an integer between 1 and 10", 400);
      }
    }
    // Validate targetRank (string, max 50 chars)
    if (targetRank !== undefined && targetRank !== null) {
      if (typeof targetRank !== "string" || targetRank.length > 50) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetRank must be a string of 50 characters or fewer", 400);
      }
    }
    // Validate targetLevel (integer 1–200)
    if (targetLevel !== undefined && targetLevel !== null) {
      if (typeof targetLevel !== "number" || !Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "targetLevel must be an integer between 1 and 200", 400);
      }
    }

    const target = await store.update(id, { targetTier, targetRank, targetLevel, reason, priority, status });
    if (!target) return sendFail(res, ErrorCode.NOT_FOUND, `Target not found: ${id}`, 404);
    sendOk(res, target);
  });

  // ─── Delete target ───────────────────────────────────────

  router.delete("/api/targets/:id", admiral, async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const id = Number(req.params.id);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid target ID", 400);

    const deleted = await store.delete(id);
    if (!deleted) return sendFail(res, ErrorCode.NOT_FOUND, `Target not found: ${id}`, 404);
    sendOk(res, { id, deleted: true });
  });

  // ─── Mark achieved ───────────────────────────────────────

  router.post("/api/targets/:id/achieve", admiral, async (req, res) => {
    const store = getStore();
    if (!store) return sendFail(res, ErrorCode.TARGET_STORE_NOT_AVAILABLE, "Target store not available", 503);

    const id = Number(req.params.id);
    if (isNaN(id)) return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid target ID", 400);

    const target = await store.markAchieved(id);
    if (!target) return sendFail(res, ErrorCode.NOT_FOUND, `Target not found: ${id}`, 404);
    sendOk(res, target);
  });

  return router;
}
