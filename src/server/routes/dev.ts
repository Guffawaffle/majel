/**
 * routes/dev.ts — Dev-only endpoints (ADR-050)
 *
 * Registered only when capabilities.devEndpoints === true.
 * The module is dynamically imported — not loaded in cloud_prod.
 *
 * Safety model:
 *   1. Profile validation prevents devEndpoints in cloud_prod
 *   2. Dynamic import keeps module out of production bundle
 *   3. Defense-in-depth: middleware checks capability at request time
 */

import type { Router, Request, Response } from "express";
import type { AppState } from "../app-context.js";
import { sendOk, sendFail, ErrorCode } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { log } from "../logger.js";
import {
  getCdnVersion,
  syncCdnShips,
  syncCdnOfficers,
  syncCdnResearch,
  syncCdnBuildings,
  syncCdnHostiles,
  syncCdnConsumables,
  syncCdnSystems,
} from "../services/gamedata-ingest.js";

export function createDevRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // Defense-in-depth: verify capabilities at request time
  router.use("/api/dev", (_req: Request, res: Response, next) => {
    if (!appState.config.contract.capabilities.devEndpoints) {
      return sendFail(res, ErrorCode.FORBIDDEN, "Dev endpoints not available in this profile", 403);
    }
    next();
  });

  // ─── Inspection ─────────────────────────────────────────────

  /**
   * GET /api/dev/state — AppState summary (store counts, profile, capabilities)
   */
  router.get("/api/dev/state", async (_req: Request, res: Response) => {
    const safeCounts = async (store: { counts(): Promise<unknown> } | null): Promise<unknown> => {
      if (!store) return null;
      try { return await store.counts(); }
      catch (err) { log.http.warn({ err }, "store.counts() failed"); return "error"; }
    };

    sendOk(res, {
      profile: appState.config.profile,
      capabilities: appState.config.contract.capabilities,
      startupComplete: appState.startupComplete,
      stores: {
        reference: await safeCounts(appState.referenceStore as { counts(): Promise<unknown> } | null),
        overlay: await safeCounts(appState.overlayStore as { counts(): Promise<unknown> } | null),
        crew: await safeCounts(appState.crewStore as { counts(): Promise<unknown> } | null),
        receipt: await safeCounts(appState.receiptStore as { counts(): Promise<unknown> } | null),
        target: await safeCounts(appState.targetStore as { counts(): Promise<unknown> } | null),
        research: await safeCounts(appState.researchStore as { counts(): Promise<unknown> } | null),
        inventory: await safeCounts(appState.inventoryStore as { counts(): Promise<unknown> } | null),
        proposal: await safeCounts(appState.proposalStore as { counts(): Promise<unknown> } | null),
        effect: await safeCounts(appState.effectStore as { counts(): Promise<unknown> } | null),
      },
      engine: appState.geminiEngine ? {
        model: appState.geminiEngine.getModel(),
      } : null,
    });
  });

  /**
   * GET /api/dev/overlay/:userId — Dump all overlay rows for a user
   */
  router.get("/api/dev/overlay/:userId", async (req: Request, res: Response) => {
    const { userId } = req.params;
    if (!appState.overlayStoreFactory) {
      return sendFail(res, ErrorCode.OVERLAY_STORE_NOT_AVAILABLE, "Overlay store not available", 503);
    }
    const store = appState.overlayStoreFactory.forUser(String(userId));
    const counts = await store.counts();
    sendOk(res, { userId, counts });
  });

  /**
   * GET /api/dev/proposals/:userId — List all proposals for a user
   */
  router.get("/api/dev/proposals/:userId", async (req: Request, res: Response) => {
    const { userId } = req.params;
    if (!appState.proposalStoreFactory) {
      return sendFail(res, ErrorCode.PROPOSAL_STORE_NOT_AVAILABLE, "Proposal store not available", 503);
    }
    const store = appState.proposalStoreFactory.forUser(String(userId));
    const proposals = await store.list();
    sendOk(res, { userId, proposals });
  });

  // ─── Seed & Reset ───────────────────────────────────────────

  /**
   * POST /api/dev/seed — Seed reference catalog (idempotent)
   *
   * Version-gated CDN sync. Uses ?force=true to bypass version check.
   * Safe to call multiple times — all syncs use ON CONFLICT upserts.
   */
  router.post("/api/dev/seed", async (req: Request, res: Response) => {
    if (!appState.config.contract.capabilities.devSeed) {
      return sendFail(res, ErrorCode.FORBIDDEN, "Dev seed not available in this profile", 403);
    }
    if (!appState.referenceStore) {
      return sendFail(res, ErrorCode.REFERENCE_STORE_NOT_AVAILABLE, "Reference store not available", 503);
    }
    if (!appState.settingsStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Settings store not available", 503);
    }

    const force = req.query.force === "true";
    const cdnVersion = await getCdnVersion();
    if (!cdnVersion) {
      return sendOk(res, { seeded: false, message: "No CDN snapshot found" });
    }

    const lastSynced = await appState.settingsStore.get("system.cdnSyncVersion");
    if (!force && lastSynced === cdnVersion) {
      return sendOk(res, { seeded: false, message: "CDN version unchanged", version: cdnVersion });
    }

    log.boot.info({ cdnVersion, lastSynced: lastSynced || null, force }, "dev:seed — running CDN sync");
    const syncResults = await Promise.allSettled([
      syncCdnOfficers(appState.referenceStore),
      syncCdnShips(appState.referenceStore),
      syncCdnResearch(appState.referenceStore),
      syncCdnBuildings(appState.referenceStore),
      syncCdnHostiles(appState.referenceStore),
      syncCdnConsumables(appState.referenceStore),
      syncCdnSystems(appState.referenceStore),
    ]);
    const failed = syncResults.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      for (const f of failed) {
        log.boot.error({ err: (f as PromiseRejectedResult).reason }, "dev:seed CDN sync failed");
      }
    } else {
      await appState.settingsStore.set("system.cdnSyncVersion", cdnVersion);
    }
    const counts = await appState.referenceStore.counts();
    sendOk(res, {
      seeded: true,
      version: cdnVersion,
      failures: failed.length,
      counts,
    });
  });

  /**
   * POST /api/dev/reset — Truncate user-scoped tables
   *
   * Preserves reference catalog. Resets overlays, proposals, receipts,
   * targets, crews, events, research, inventory.
   */
  router.post("/api/dev/reset", async (_req: Request, res: Response) => {
    if (!appState.config.contract.capabilities.devSeed) {
      return sendFail(res, ErrorCode.FORBIDDEN, "Dev reset not available in this profile", 403);
    }
    if (!appState.pool) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Database pool not available", 503);
    }

    const tables = [
      "ship_overlay", "officer_overlay", "targets", "bridge_compositions",
      "bridge_core_members", "import_receipts", "proposals", "operation_events",
      "research_nodes", "inventory_items",
    ];

    const truncated: string[] = [];
    for (const table of tables) {
      try {
        await appState.pool.query(`TRUNCATE TABLE "${table}" CASCADE`);
        truncated.push(table);
      } catch (err: unknown) {
        // Skip tables that don't exist (42P01)
        if (err && typeof err === "object" && "code" in err && err.code === "42P01") continue;
        throw err;
      }
    }

    log.boot.info({ truncated }, "dev:reset — user-scoped tables truncated");
    sendOk(res, { reset: true, truncated });
  });

  return router;
}
