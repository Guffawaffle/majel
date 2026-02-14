/**
 * express-locals.d.ts — Type-safe res.locals for Majel routes.
 *
 * Augments Express.Locals so auth middleware and memory-middleware
 * properties are statically typed instead of `any`.
 *
 * See: src/server/auth.ts (requireRole sets user fields)
 *      src/server/memory-middleware.ts (attachScopedMemory sets memory)
 *      src/server/envelope.ts (envelopeMiddleware sets _requestId, _startTime)
 */

import type { MemoryService } from "../services/memory.js";

declare global {
  namespace Express {
    interface Locals {
      // ── Envelope middleware (always set) ──
      _requestId: string;
      _startTime: number;

      // ── Auth middleware (set by requireRole) ──
      userId?: string;
      userRole?: string;
      userEmail?: string;
      userDisplayName?: string;
      isAdmiral?: boolean;
      /** Tenant isolation key — currently same as userId. */
      tenantId?: string;

      // ── Memory middleware (set by attachScopedMemory) ──
      memory?: MemoryService;
    }
  }
}

export {};  // Ensure this is treated as a module
