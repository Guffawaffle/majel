/**
 * ip-allowlist.ts — IP Allowlist Middleware
 *
 * Majel — STFC Fleet Intelligence System
 *
 * When MAJEL_ALLOWED_IPS is set (comma-separated), only requests
 * from those IPs reach the application. All others get 403.
 *
 * When empty or unset: middleware is a no-op (local dev mode).
 *
 * Reads req.ip which respects `trust proxy` (Cloud Run frontend).
 * Supports both IPv4 and IPv6 addresses. CIDR not supported — use
 * Cloud Armor WAF rules for subnet-level filtering.
 */

import type { Request, Response, NextFunction } from "express";
import { sendFail, ErrorCode } from "./envelope.js";
import { log } from "./logger.js";

/**
 * Create an IP allowlist middleware from a resolved list.
 * Returns a passthrough when the list is empty.
 */
export function createIpAllowlist(allowedIps: string[]) {
  // No restriction — passthrough
  if (allowedIps.length === 0) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  // Build a Set for O(1) lookup
  const allowSet = new Set(allowedIps);

  log.http.info({ allowedIps }, "IP allowlist active — %d address(es)", allowedIps.length);

  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || "";

    if (allowSet.has(clientIp)) {
      return next();
    }

    // IPv4-mapped IPv6 check: Cloud Run may report ::ffff:1.2.3.4
    if (clientIp.startsWith("::ffff:")) {
      const v4 = clientIp.slice(7); // strip "::ffff:"
      if (allowSet.has(v4)) {
        return next();
      }
    }

    // Also check the reverse: allowlist has ::ffff: but req.ip is plain v4
    if (!clientIp.includes(":")) {
      if (allowSet.has(`::ffff:${clientIp}`)) {
        return next();
      }
    }

    log.http.warn({ clientIp, path: req.path }, "Blocked by IP allowlist");
    return sendFail(res, ErrorCode.FORBIDDEN, "Access denied", 403);
  };
}
