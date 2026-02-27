/**
 * proposals.ts — ADR-026b Mutation Proposal API Routes (#93 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides proposal create, apply, decline, list, and detail endpoints.
 * Every mutating tool action is first stored as a dry-run proposal, then
 * explicitly confirmed before being applied.
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
import { executeFleetTool } from "../services/fleet-tools/index.js";

/** Phase 1: only these tools support the proposal flow. */
const SUPPORTED_TOOLS = new Set(["sync_overlay"]);

export function createProposalRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  router.use("/api/mutations", visitor);

  // ── List proposals ────────────────────────────────────────

  router.get("/api/mutations/proposals", async (req, res) => {
    const userId = res.locals.userId as string;
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
    const userId = res.locals.userId as string;
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

  // ── Create proposal ──────────────────────────────────────

  router.post("/api/mutations/proposals", async (req, res) => {
    const userId = res.locals.userId as string;
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
    if (!SUPPORTED_TOOLS.has(tool)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Tool '${tool}' is not supported for proposals`, 400);
    }

    // Build tool context for this user
    const toolContext = appState.toolContextFactory?.forUser(userId);
    if (!toolContext) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Tool context not available", 503);
    }

    // Hash the args for tamper detection
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");

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
    const userId = res.locals.userId as string;
    const proposalStore = appState.proposalStoreFactory?.forUser(userId);
    if (!proposalStore) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }

    const { id } = req.params;
    const proposal = await proposalStore.get(id);
    if (!proposal) {
      return sendFail(res, ErrorCode.NOT_FOUND, `Proposal ${id} not found`, 404);
    }

    // Tamper check: verify args hash matches
    const currentHash = createHash("sha256").update(JSON.stringify(proposal.argsJson)).digest("hex");
    if (currentHash !== proposal.argsHash) {
      return sendFail(res, ErrorCode.CONFLICT, "Proposal args have been tampered with", 409);
    }

    // Build tool context for this user
    const toolContext = appState.toolContextFactory?.forUser(userId);
    if (!toolContext) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Tool context not available", 503);
    }

    try {
      // Re-execute tool with dry_run: false to actually apply changes
      const result = await executeFleetTool(
        proposal.tool,
        { ...proposal.argsJson, dry_run: false },
        toolContext,
      ) as Record<string, unknown>;

      if (result.error) {
        return sendFail(res, ErrorCode.CONFLICT, String(result.error), 409);
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
    const userId = res.locals.userId as string;
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
