/**
 * context-middleware.ts — Express Middleware for RequestContext (ADR-039, D1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Creates a RequestContext from res.locals (populated by envelopeMiddleware
 * and requireRole) and stores it in both res.locals and AsyncLocalStorage.
 *
 * Must be mounted AFTER envelopeMiddleware and requireRole so that
 * _requestId, _startTime, userId, userRole, and tenantId are available.
 *
 * Usage in app setup:
 *   app.use(envelopeMiddleware);        // sets _requestId, _startTime
 *   app.use(requireRole("ensign"));     // sets userId, userRole, tenantId
 *   app.use(createContextMiddleware(pool));
 */

import type { Request, Response, NextFunction } from "express";
import type { Pool } from "./db.js";
import { RequestContext, type RequestIdentity } from "./request-context.js";
import { runWithContext } from "./context-store.js";
import { rootLogger } from "./logger.js";

/**
 * Map userRole string to roles array.
 * Role hierarchy is flat — each user has one role, stored as a single-element array
 * for forward-compatibility with multi-role RBAC (ADR-039 D1).
 */
function resolveRoles(userRole?: string): readonly string[] {
  if (!userRole) return ["ensign"];
  return [userRole];
}

/**
 * Create Express middleware that builds a RequestContext from res.locals.
 *
 * @param pool — The app-level Pool for DB scoping (not owned by the context).
 */
export function createContextMiddleware(pool: Pool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = res.locals._requestId as string;
    const userId = res.locals.userId as string | undefined;

    // If no userId yet (unauthenticated route), skip context creation.
    // Routes that need RequestContext run after auth middleware.
    if (!userId) {
      next();
      return;
    }

    const identity: RequestIdentity = {
      requestId,
      userId,
      tenantId: (res.locals.tenantId as string) ?? userId,
      roles: resolveRoles(res.locals.userRole as string | undefined),
    };

    const log = rootLogger.child({
      requestId,
      userId,
      subsystem: "request",
    });

    const ctx = new RequestContext({
      identity,
      log,
      pool,
      startedAtMs: res.locals._startTime as number | undefined,
    });

    // Attach to res.locals for use by route handlers
    res.locals.ctx = ctx;

    // Run the rest of the request inside ALS scope for logging correlation
    runWithContext(ctx, () => next());
  };
}
