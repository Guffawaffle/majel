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

// W15 fix: Validate IP address syntax (IPv4 or IPv6)
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const IPV4_MAPPED_V6_RE = /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isValidIp(ip: string): boolean {
  if (IPV4_RE.test(ip)) {
    return ip.split(".").every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }
  if (IPV4_MAPPED_V6_RE.test(ip)) return true;
  return IPV6_RE.test(ip) && ip.includes(":");
}

/**
 * Parse and validate IP addresses from the allowlist.
 * W15 fix: logs and rejects invalid entries instead of silently ignoring them.
 */
export function parseAllowedIps(raw: string[]): string[] {
  const valid: string[] = [];
  for (const ip of raw) {
    const trimmed = ip.trim();
    if (!trimmed) continue;
    if (isValidIp(trimmed)) {
      valid.push(trimmed);
    } else {
      log.http.warn({ ip: trimmed }, "Invalid IP in allowlist — skipped");
    }
  }
  return valid;
}

/**
 * Create an IP allowlist middleware from a resolved list.
 * Returns a passthrough when the list is empty.
 */
export function createIpAllowlist(allowedIps: string[]) {
  const validated = parseAllowedIps(allowedIps);
  // No restriction — passthrough
  if (validated.length === 0) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  // Build a Set for O(1) lookup
  const allowSet = new Set(validated);

  log.http.info({ allowedIps: validated }, "IP allowlist active — %d address(es)", validated.length);

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
