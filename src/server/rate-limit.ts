/**
 * rate-limit.ts — Auth Endpoint Rate Limiting (ADR-019 Phase 1)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Per-IP rate limiting for authentication endpoints to prevent
 * credential stuffing and brute-force attacks.
 *
 * Config: 10 requests per minute per IP on /api/auth/* routes.
 */

import rateLimit from "express-rate-limit";
import { sendFail } from "./envelope.js";

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
  handler: (_req, res) => {
    sendFail(
      res,
      "RATE_LIMITED",
      "Too many requests. Please try again in a minute.",
      429,
    );
  },

  // Skip rate limiting in test mode
  skip: () => process.env.NODE_ENV === "test" || process.env.VITEST === "true",
});
