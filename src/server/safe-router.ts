/**
 * safe-router.ts — Canonical async-safe Express router (ADR-005)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Express 4 does NOT catch rejected promises from async route handlers.
 * A bare `router.get("/x", async (req, res) => { throw … })` will
 * crash the process or hang the request with no response.
 *
 * SafeRouter wraps every handler automatically — if it returns a promise,
 * rejections are caught and forwarded to `next(err)`, which flows to
 * the catch-all errorHandler (envelope.ts). There is nothing to forget.
 *
 * Global error hooks fire before the error reaches Express, enabling
 * metrics/alerting without coupling to the error middleware.
 *
 * Usage:
 *   import { createSafeRouter } from "../safe-router.js";
 *   const router = createSafeRouter();
 *   router.get("/api/foo", async (req, res) => { … }); // always safe
 *
 * Replaces manual asyncHandler() wrapping — safety by construction.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";

// ─── Global Error Hooks ─────────────────────────────────────

export interface RouteErrorContext {
  method: string;
  path: string;
  requestId?: string;
}

type RouteErrorHook = (err: Error, context: RouteErrorContext) => void;

const errorHooks: RouteErrorHook[] = [];

/**
 * Register a global observer for route errors.
 * Hooks are called before the error reaches Express error middleware.
 * Returns an unsubscribe function.
 *
 * Example:
 *   const unsub = onRouteError((err, ctx) => {
 *     metrics.increment("route.error", { route: ctx.path });
 *   });
 */
export function onRouteError(hook: RouteErrorHook): () => void {
  errorHooks.push(hook);
  return () => {
    const idx = errorHooks.indexOf(hook);
    if (idx >= 0) errorHooks.splice(idx, 1);
  };
}

/** Reset all hooks (for testing). */
export function _resetHooks(): void {
  errorHooks.length = 0;
}

// ─── Safe Router ────────────────────────────────────────────

const HTTP_METHODS = [
  "get", "post", "put", "patch", "delete",
  "all", "head", "options",
] as const;

/**
 * Create an Express Router that auto-wraps all handlers.
 *
 * Every function argument to `.get()`, `.post()`, etc. is wrapped so that
 * if it returns a promise, rejections are caught and passed to `next(err)`.
 * Sync handlers that throw are also caught. The wrapping is transparent —
 * the returned Router is a standard Express Router in every way.
 *
 * Error-handling middleware (4-arg functions) is wrapped correctly;
 * Express still detects them by parameter count.
 */
export function createSafeRouter(): Router {
  const router = Router();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = router as any;

  for (const method of HTTP_METHODS) {
    const original = r[method].bind(router);

    r[method] = (...args: unknown[]) => {
      // Wrap every arg that's a function (or array of functions).
      // Non-functions (path strings, RegExp) pass through unchanged.
      const safe = args.map((arg) =>
        Array.isArray(arg) ? arg.map(wrapIfHandler) : wrapIfHandler(arg),
      );
      return original(...safe);
    };
  }

  return router;
}

// ─── Internal ───────────────────────────────────────────────

/**
 * Wrap a single handler if it's a function.
 * Non-functions (strings, RegExp, etc.) pass through unchanged.
 */
function wrapIfHandler(handler: unknown): unknown {
  if (typeof handler !== "function") return handler;

  // Error-handling middleware: (err, req, res, next) — 4 args.
  // Express keys on Function.length to detect these, so the wrapper
  // must also have exactly 4 named params.
  if (handler.length === 4) {
    return function safeErrorHandler(
      err: Error,
      req: Request,
      res: Response,
      next: NextFunction,
    ): void {
      try {
        const result = (handler as (...a: unknown[]) => unknown)(err, req, res, next);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((e: Error) => {
            fireHooks(e, req);
            next(e);
          });
        }
      } catch (syncErr) {
        fireHooks(syncErr instanceof Error ? syncErr : new Error(String(syncErr)), req);
        next(syncErr);
      }
    };
  }

  // Regular middleware/handler: (req, res, next) or (req, res)
  return function safeHandler(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    try {
      const result = (handler as (...a: unknown[]) => unknown)(req, res, next);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((e: Error) => {
          fireHooks(e, req);
          next(e);
        });
      }
    } catch (syncErr) {
      fireHooks(syncErr instanceof Error ? syncErr : new Error(String(syncErr)), req);
      next(syncErr);
    }
  };
}

function fireHooks(err: Error, req: Request): void {
  for (const hook of errorHooks) {
    try {
      hook(err, {
        method: req.method,
        path: req.originalUrl || req.path,
        requestId: req.res?.locals?._requestId as string | undefined,
      });
    } catch {
      // Observer must never break error flow
    }
  }
}
