/**
 * rate-limit.ts — Rate Limiting (ADR-019)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * - authRateLimiter: 10 req/min per IP on /api/auth/* routes
 * - chatRateLimiter: 20 req/min per IP on /api/chat (Gemini API is paid)
 * - globalRateLimiter: 120 req/min per IP baseline on all /api/* routes
 */

import rateLimit from "express-rate-limit";
import { sendFail } from "./envelope.js";
import { log } from "./logger.js";

const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function importLimiterKey(req: { ip?: string }, userId: unknown): string {
  if (typeof userId === "string" && userId.trim().length > 0) return `user:${userId}`;
  return `ip:${req.ip ?? "unknown"}`;
}

function shouldSkipImportLimiter(): boolean {
  return IS_TEST && process.env.MAJEL_TEST_ENABLE_RATE_LIMIT !== "true";
}

const IMPORT_WINDOW_MS = 60 * 1000;

/**
 * Rate limiter for auth endpoints (sign-up, sign-in, password reset).
 * 10 requests per minute per IP address.
 */
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,               // 10 requests per window
  standardHeaders: true,  // RateLimit-* headers
  legacyHeaders: false,   // No X-RateLimit-* headers

  // Trust proxy is set on the Express app (index.ts) so req.ip
  // reflects the real client IP behind Cloud Run's load balancer.
  // Disable header validation since trust proxy handles it.
  validate: { xForwardedForHeader: false },

  // Custom error response using Majel's envelope format
  handler: (req, res) => {
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "auth" }, "rate limit exceeded");
    sendFail(
      res,
      "RATE_LIMITED",
      "Too many requests. Please try again in a minute.",
      429,
    );
  },

  // Skip rate limiting in test mode
  skip: () => IS_TEST,
});

/**
 * Rate limiter for chat endpoint (Gemini API calls are metered/paid).
 * 20 requests per minute per IP address.
 */
export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "chat" }, "rate limit exceeded");
    sendFail(res, "RATE_LIMITED", "Chat rate limit reached. Please wait before sending more messages.", 429);
  },
  skip: () => IS_TEST,
});

/**
 * Global per-IP rate limiter for all API endpoints.
 * 120 requests per minute — catches abuse patterns that individual
 * limiters miss (e.g., flooding read endpoints for DoS).
 */
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "global" }, "rate limit exceeded");
    sendFail(res, "RATE_LIMITED", "Too many requests. Please slow down.", 429);
  },
  skip: () => IS_TEST,
});

export const importAnalyzeRateLimiter = rateLimit({
  windowMs: IMPORT_WINDOW_MS,
  max: () => parsePositiveInt(process.env.MAJEL_IMPORT_ANALYZE_RPM, 6),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req, res) => importLimiterKey(req, res.locals.userId),
  handler: (req, res) => {
    const limiterKey = importLimiterKey(req, res.locals.userId);
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "import_analyze", limiterKey }, "import analyze rate limit exceeded");
    res.setHeader("Retry-After", String(Math.ceil(IMPORT_WINDOW_MS / 1000)));
    sendFail(res, "RATE_LIMITED", "Import analyze rate limit reached. Please retry shortly.", 429, {
      hints: ["Retry after 60 seconds", "Reduce repeated analyze requests for the same file"],
    });
  },
  skip: () => shouldSkipImportLimiter(),
});

export const importParseRateLimiter = rateLimit({
  windowMs: IMPORT_WINDOW_MS,
  max: () => parsePositiveInt(process.env.MAJEL_IMPORT_PARSE_RPM, 20),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req, res) => importLimiterKey(req, res.locals.userId),
  handler: (req, res) => {
    const limiterKey = importLimiterKey(req, res.locals.userId);
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "import_parse", limiterKey }, "import parse rate limit exceeded");
    res.setHeader("Retry-After", String(Math.ceil(IMPORT_WINDOW_MS / 1000)));
    sendFail(res, "RATE_LIMITED", "Import parse rate limit reached. Please retry shortly.", 429, {
      hints: ["Retry after 60 seconds", "Batch parse calls where possible"],
    });
  },
  skip: () => shouldSkipImportLimiter(),
});

/**
 * Tight rate limiter for email-sending endpoints (resend-verification, forgot-password).
 * 3 requests per 15 minutes per IP — protects sender reputation and prevents spam.
 */
export const emailRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "email" }, "email rate limit exceeded");
    sendFail(res, "RATE_LIMITED", "Too many requests. Please wait before requesting another email.", 429);
  },
  skip: () => IS_TEST,
});

/**
 * Rate limiter for diagnostic query endpoint (#196).
 * 10 queries per minute per user — blocks automated data scraping.
 */
export const diagnosticRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req, res) => importLimiterKey(req, res.locals.userId),
  handler: (req, res) => {
    const limiterKey = importLimiterKey(req, res.locals.userId);
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "diagnostic", limiterKey }, "diagnostic query rate limit exceeded");
    sendFail(res, "RATE_LIMITED", "Diagnostic query rate limit reached. Please wait before running more queries.", 429);
  },
  skip: () => IS_TEST,
});
