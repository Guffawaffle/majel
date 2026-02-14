/**
 * memory-middleware.ts — Per-Request Scoped Memory Middleware (ADR-021 D4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Creates a per-request MemoryService scoped to the authenticated user.
 * Auth middleware must run first to set res.locals.userId.
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
    const userId = res.locals.userId as string | undefined;

    if (userId && appState.frameStoreFactory) {
      // Create a per-user scoped MemoryService backed by PostgresFrameStore + RLS
      res.locals.memory = createMemoryService(
        appState.frameStoreFactory.forUser(userId),
      );
    } else if (appState.memoryService) {
      // Fallback: shared (unscoped) memory service (SQLite or system-scoped PG)
      res.locals.memory = appState.memoryService;
    }
    // If neither is available, res.locals.memory stays undefined

    next();
  };
}
