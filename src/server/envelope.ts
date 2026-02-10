/**
 * envelope.ts — AX-First API response envelope (ADR-004).
 *
 * Consistent response shape for all API consumers:
 *   Success: { ok: true, data: T, meta: { requestId, timestamp, durationMs } }
 *   Error:   { ok: false, error: { code, message, detail? }, meta: ... }
 *
 * Usage in routes:
 *   import { sendOk, sendFail, ErrorCode } from "../envelope.js";
 *   sendOk(res, { ships, count: ships.length });
 *   sendFail(res, ErrorCode.MISSING_PARAM, "Missing id", 400);
 */

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { log } from "./logger.js";

// ─── Error Codes (stable, machine-readable) ─────────────────────

export const ErrorCode = {
  // 503 — subsystem not ready
  GEMINI_NOT_READY: "GEMINI_NOT_READY",
  MEMORY_NOT_AVAILABLE: "MEMORY_NOT_AVAILABLE",
  SETTINGS_NOT_AVAILABLE: "SETTINGS_NOT_AVAILABLE",
  FLEET_STORE_NOT_AVAILABLE: "FLEET_STORE_NOT_AVAILABLE",
  DOCK_STORE_NOT_AVAILABLE: "DOCK_STORE_NOT_AVAILABLE",
  SESSION_STORE_NOT_AVAILABLE: "SESSION_STORE_NOT_AVAILABLE",
  // 400 — client errors
  MISSING_PARAM: "MISSING_PARAM",
  INVALID_PARAM: "INVALID_PARAM",
  NOT_FOUND: "NOT_FOUND",
  UNKNOWN_CATEGORY: "UNKNOWN_CATEGORY",
  BUILTIN_IMMUTABLE: "BUILTIN_IMMUTABLE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  // 504 — timeout
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  // 500 — upstream failures
  GEMINI_ERROR: "GEMINI_ERROR",
  MEMORY_ERROR: "MEMORY_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Meta ───────────────────────────────────────────────────────

export interface ApiMeta {
  requestId: string;
  timestamp: string;
  durationMs: number;
}

// ─── Envelope types (exported for tests) ────────────────────────

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
  meta: ApiMeta;
}

export type ApiEnvelope<T = unknown> = ApiSuccess<T> | ApiErrorResponse;

// ─── Middleware: attach requestId + startTime ───────────────────

export function envelopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const startTime = Date.now();

  res.locals._requestId = requestId;
  res.locals._startTime = startTime;
  res.setHeader("X-Request-Id", requestId);

  next();
}

// ─── Helpers ────────────────────────────────────────────────────

function buildMeta(res: Response): ApiMeta {
  return {
    requestId: (res.locals._requestId as string) || "unknown",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - ((res.locals._startTime as number) || Date.now()),
  };
}

/** Send a success envelope. */
export function sendOk(res: Response, data: unknown, statusCode = 200): void {
  res.status(statusCode).json({
    ok: true,
    data,
    meta: buildMeta(res),
  });
}

/** Send an error envelope. */
export function sendFail(
  res: Response,
  code: string,
  message: string,
  statusCode = 400,
  detail?: unknown,
): void {
  res.status(statusCode).json({
    ok: false,
    error: { code, message, ...(detail !== undefined ? { detail } : {}) },
    meta: buildMeta(res),
  });
}

// ─── Timeout Middleware ─────────────────────────────────────────

/**
 * Create a timeout middleware for a specific route.
 * If the request takes longer than `timeoutMs`, returns 504 Gateway Timeout.
 */
export function createTimeoutMiddleware(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let timedOut = false;
    
    const timer = setTimeout(() => {
      if (!res.headersSent && !timedOut) {
        timedOut = true;
        log.http.warn({ 
          requestId: res.locals._requestId, 
          path: req.path, 
          timeoutMs 
        }, "request timeout");
        sendFail(res, ErrorCode.REQUEST_TIMEOUT, `Request timeout after ${timeoutMs}ms`, 504);
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    const cleanup = () => {
      clearTimeout(timer);
    };
    
    res.on("finish", cleanup);
    res.on("close", cleanup);

    next();
  };
}

// ─── Async Error Wrapper ────────────────────────────────────────

/**
 * Wrap async route handlers to catch errors and pass to error middleware.
 * Express doesn't automatically catch errors in async functions.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── Catch-all error handler (mount AFTER routes) ───────────────

export function errorHandler(err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction): void {
  // Don't send error if headers already sent (e.g., timeout already fired)
  if (res.headersSent) {
    return;
  }

  const message = err.message || "Internal server error";
  let statusCode = err.status || err.statusCode || 500;
  let code: ErrorCodeValue = ErrorCode.INTERNAL_ERROR;

  // Handle express.json payload too large error
  if (err.message && err.message.includes("entity too large")) {
    statusCode = 413;
    code = ErrorCode.PAYLOAD_TOO_LARGE;
  }

  log.http.error({ err: message, requestId: res.locals._requestId }, "unhandled error");
  sendFail(res, code, message, statusCode);
}
