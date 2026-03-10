/**
 * memory-middleware.ts — Per-Request Scoped Memory Middleware (ADR-021 D4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Creates a per-request MemoryService scoped to the authenticated user.
 * Prefers RequestContext (ctx) when available; falls back to res.locals.userId.
 *
 * Route handlers use `res.locals.memory` — no userId parameter to forget.
 * RLS enforces isolation at the database level (fail-closed).
 *
 * @see docs/ADR-021-postgres-frame-store.md (D3, D4)
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AppState } from "../app-context.js";
import { createMemoryService, type MemoryService } from "./memory.js";

// Augment Express locals type for IDE support
declare module "express-serve-static-core" {
  interface Locals {
    /** Per-request memory service, RLS-scoped to the authenticated user. */
    memory?: MemoryService;
  }
}

/**
 * Middleware that attaches a user-scoped MemoryService to `res.locals.memory`.
 *
 * Requires auth middleware to have set `res.locals.userId` first.
 * If no FrameStoreFactory is available (SQLite fallback or boot failure),
 * falls back to the shared `appState.memoryService`.
 *
 * Usage in route handlers:
 *   const memory = res.locals.memory;
 *   if (memory) await memory.recall("some query");
 */
export function attachScopedMemory(appState: AppState): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = res.locals.ctx;
    const userId = ctx?.identity.userId ?? (res.locals.userId as string | undefined);

    if (userId && appState.frameStoreFactory) {
      // Prefer ctx-backed store when RequestContext is available
      const store = ctx
        ? appState.frameStoreFactory.forContext(ctx)
        : appState.frameStoreFactory.forUser(userId);
      res.locals.memory = createMemoryService(store);
    } else if (appState.memoryService) {
      // Fallback: shared (unscoped) memory service (SQLite or system-scoped PG)
      res.locals.memory = appState.memoryService;
    }
    // If neither is available, res.locals.memory stays undefined

    next();
  };
}
