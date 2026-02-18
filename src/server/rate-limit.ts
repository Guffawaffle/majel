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

/**
 * Rate limiter for catalog/sync endpoint (heavy DB operation).
 * 2 requests per minute — prevents hammering the datamine ingest.
 */
export const syncRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req, res) => {
    log.http.warn({ ip: req.ip, path: req.path, event: "rate_limit.hit", limiter: "sync" }, "rate limit exceeded");
    sendFail(res, "RATE_LIMITED", "Sync rate limit reached. Please wait before syncing again.", 429);
  },
  skip: () => IS_TEST,
});
