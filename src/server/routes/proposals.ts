/**
 * proposals.ts — ADR-026b Mutation Proposal API Routes (#93 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides proposal create, apply, decline, list, and detail endpoints.
 * Supports both single-tool proposals (sync_overlay dry-run flow) and
 * batched proposals (multiple mutations from a single chat turn).
 *
 * Pattern: factory function createProposalRoutes(appState) → Router
 */

import { createHash } from "node:crypto";
import type { Router } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { log } from "../logger.js";
import { requireVisitor } from "../services/auth.js";
import { createSafeRouter } from "../safe-router.js";
import { createContextMiddleware } from "../context-middleware.js";
import { executeFleetTool } from "../services/fleet-tools/index.js";
import { isMutationTool, getTrustLevel } from "../services/fleet-tools/trust.js";
import { canonicalStringify } from "../util/canonical-json.js";

/** Tools that support the dry-run proposal creation via API. */
const DRY_RUN_TOOLS = new Set(["sync_overlay", "sync_research"]);

export function createProposalRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  router.use("/api/mutations", visitor);
  if (appState.pool) {
    router.use("/api/mutations", createContextMiddleware(appState.pool));
  }

  // ── List proposals ────────────────────────────────────────

  router.get("/api/mutations/proposals", async (req, res) => {
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const status = req.query.status as string | undefined;
    if (status && !["proposed", "applied", "declined", "expired"].includes(status)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "status must be one of: proposed, applied, declined, expired", 400);
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "limit must be an integer between 1 and 200", 400);
    }

    const proposals = await proposalStore.list({
      status: status as "proposed" | "applied" | "declined" | "expired" | undefined,
      limit,
    });
    sendOk(res, { proposals, count: proposals.length });
  });

  // ── Get proposal detail ───────────────────────────────────

  router.get("/api/mutations/proposals/:id", async (req, res) => {
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const proposal = await proposalStore.get(req.params.id);
    if (!proposal) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Proposal ${req.params.id} not found`, 404);
    }
    sendOk(res, { proposal });
  });

  // ── Create proposal (dry-run tools only) ──────────────────

  router.post("/api/mutations/proposals", async (req, res) => {
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const { tool, args } = req.body;
    if (!tool || typeof tool !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "tool is required", 400);
    }
    if (!args || typeof args !== "object") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "args is required and must be an object", 400);
    }
    if (!DRY_RUN_TOOLS.has(tool)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Tool '${tool}' does not support dry-run proposal creation via API. Use chat for approval-gated mutations.`, 400);
    }

    // Build tool context for this user
    const toolContext = appState.toolContextFactory?.forUser(userId);
    if (!toolContext) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Tool context not available", 503);
    }

    // Hash the args for tamper detection
    const argsHash = createHash("sha256").update(canonicalStringify(args)).digest("hex");

    // Execute tool in dry_run mode to generate preview
    const preview = await executeFleetTool(tool, { ...args, dry_run: true }, toolContext) as Record<string, unknown>;
    if (preview.error) {
      return sendFail(res, ErrorCode.INVALID_PARAM, String(preview.error), 400, { detail: preview });
    }

    // Store the proposal with 15-minute expiry
    const proposal = await proposalStore.create({
      tool,
      argsJson: args,
      argsHash,
      proposalJson: preview,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    res.status(201);
    sendOk(res, {
      proposal: {
        id: proposal.id,
        tool: proposal.tool,
        status: proposal.status,
        batchItems: proposal.batchItems,
        changesPreview: (preview as Record<string, unknown>).changesPreview,
        summary: (preview as Record<string, unknown>).summary,
        risk: {
          bulkCount: Array.isArray((preview as Record<string, unknown>).warnings)
            ? ((preview as Record<string, unknown>).warnings as unknown[]).length
            : 0,
          warnings: (preview as Record<string, unknown>).warnings ?? [],
        },
        expiresAt: proposal.expiresAt,
      },
    });
  });

  // ── Apply proposal ────────────────────────────────────────

  router.post("/api/mutations/proposals/:id/apply", async (req, res) => {
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    const isAdmiral = res.locals.isAdmiral === true;
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const { id } = req.params;
    const proposal = await proposalStore.get(id);
    if (!proposal) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Proposal ${id} not found`, 404);
    }

    // Tamper check: verify args hash matches the executable payload
    const hashPayload = proposal.batchItems && proposal.batchItems.length > 0
      ? proposal.batchItems
      : proposal.argsJson;
    const currentHash = createHash("sha256").update(canonicalStringify(hashPayload)).digest("hex");
    if (currentHash !== proposal.argsHash) {
      return sendFail(res, ErrorCode.CONFLICT, "Proposal args have been tampered with", 409);
    }

    // Build tool context for this user
    const toolContext = appState.toolContextFactory?.forUser(userId);
    if (!toolContext) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Tool context not available", 503);
    }

    try {
      // Batch proposal: execute each item in sequence
      if (proposal.batchItems && proposal.batchItems.length > 0) {
        // Preflight trust + validity checks (fail closed before any mutation executes)
        for (const item of proposal.batchItems) {
          if (!isMutationTool(item.tool)) {
            return sendFail(res, ErrorCode.CONFLICT, `Unknown mutation tool: ${item.tool}`, 409);
          }

          const trustLevel = await getTrustLevel(
            item.tool,
            userId,
            toolContext.deps.userSettingsStore,
          );
          if (trustLevel === "block") {
            return sendFail(
              res,
              ErrorCode.CONFLICT,
              `Tool '${item.tool}' is currently blocked by fleet trust settings and cannot be applied.`,
              409,
            );
          }
        }

        const batchStartTime = Date.now();
        const results: Array<{ tool: string; success: boolean; result?: object; error?: string }> = [];

        for (const item of proposal.batchItems) {
          // Inject dry_run: false so mutation tools actually persist (same as single-tool path)
          const applyArgs = { ...item.args, dry_run: false };
          const result = await executeFleetTool(item.tool, applyArgs, toolContext) as Record<string, unknown>;
          if (result.error) {
            results.push({ tool: item.tool, success: false, error: String(result.error) });
            // Continue with remaining items — partial application is acceptable
            // since each mutation is independent (bridge core, loadout, dock)
          } else if (result.dryRun === true) {
            // Tool ran in dry-run mode despite dry_run: false — treat as failure
            results.push({ tool: item.tool, success: false, error: "Tool executed in dry-run mode; data was not persisted." });
          } else {
            results.push({ tool: item.tool, success: true, result });
          }
        }

        const successCount = results.filter((r) => r.success).length;

        const batchTrace = isAdmiral ? {
          timestamp: new Date().toISOString(),
          proposalId: id,
          userId,
          type: "batch" as const,
          tools: proposal.batchItems.map((b) => b.tool),
          durationMs: Date.now() - batchStartTime,
          results: results.map(({ tool, success, error }) => ({ tool, success, ...(error ? { error } : {}) })),
          successCount,
          totalCount: proposal.batchItems.length,
        } : undefined;

        // If nothing succeeded, decline the proposal and report the failure
        if (successCount === 0) {
          const errors = results.map((r) => `${r.tool}: ${r.error}`).join("; ");
          try {
            await proposalStore.decline(id, `apply_failed:${errors}`);
          } catch {
            // Best-effort; preserve primary error response
          }
          log.fleet.warn({ proposalId: id, results }, "proposal batch apply: all items failed");
          return sendFail(res, ErrorCode.CONFLICT, `All mutations failed: ${errors}`, 409, { detail: { trace: batchTrace } });
        }

        const applied = await proposalStore.apply(id, 0);
        sendOk(res, {
          applied: true,
          proposal_id: applied.id,
          batch_results: results,
          summary: `${successCount}/${proposal.batchItems.length} mutations applied successfully.`,
          trace: batchTrace,
        });
        return;
      }

      if (isMutationTool(proposal.tool)) {
        const trustLevel = await getTrustLevel(
          proposal.tool,
          userId,
          toolContext.deps.userSettingsStore,
        );
        if (trustLevel === "block") {
          return sendFail(
            res,
            ErrorCode.CONFLICT,
            `Tool '${proposal.tool}' is currently blocked by fleet trust settings and cannot be applied.`,
            409,
          );
        }
      }

      // Single-tool proposal: re-execute with dry_run: false
      const singleStartTime = Date.now();
      const result = await executeFleetTool(
        proposal.tool,
        { ...proposal.argsJson, dry_run: false },
        toolContext,
      ) as Record<string, unknown>;

      const applyError = result.error
        ? String(result.error)
        : result.dryRun === true
          ? "Tool executed in dry-run mode; data was not persisted."
          : null;

      const singleTrace = isAdmiral ? {
        timestamp: new Date().toISOString(),
        proposalId: id,
        userId,
        type: "single" as const,
        tool: proposal.tool,
        durationMs: Date.now() - singleStartTime,
        success: !applyError,
        ...(applyError ? { error: applyError } : {}),
        ...(result.dryRun != null ? { dryRun: result.dryRun } : {}),
      } : undefined;

      if (applyError) {
        try {
          await proposalStore.decline(id, `apply_failed:${applyError}`);
        } catch {
          // Best-effort lock; preserve primary error response
        }
        return sendFail(res, ErrorCode.CONFLICT, applyError, 409, { detail: { trace: singleTrace } });
      }

      // Extract receipt ID from tool result
      const receipt = result.receipt as { id?: number } | undefined;
      const receiptId = receipt?.id ?? 0;

      // Mark proposal as applied
      const applied = await proposalStore.apply(id, receiptId);
      sendOk(res, {
        applied: true,
        proposal_id: applied.id,
        receipt_id: receiptId,
        trace: singleTrace,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return sendFail(res, ErrorCode.NOT_FOUND, msg, 404);
      }
      if (msg.includes("expired") || msg.includes("Cannot apply") || msg.includes("Cannot decline")) {
        return sendFail(res, ErrorCode.CONFLICT, msg, 409);
      }
      log.fleet.error({ err: msg }, "proposal apply failed");
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Failed to apply proposal", 500);
    }
  });

  // ── Decline proposal ──────────────────────────────────────

  router.post("/api/mutations/proposals/:id/decline", async (req, res) => {
    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string);
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const { id } = req.params;
    const proposal = await proposalStore.get(id);
    if (!proposal) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Proposal ${id} not found`, 404);
    }

    try {
      await proposalStore.decline(id, req.body.reason);
      sendOk(res, { declined: true, proposal_id: id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return sendFail(res, ErrorCode.NOT_FOUND, msg, 404);
      }
      return sendFail(res, ErrorCode.CONFLICT, msg, 409);
    }
  });

  return router;
}
