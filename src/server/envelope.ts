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
 *   sendFail(res, ErrorCode.GEMINI_ERROR, "AI failed", 500, { hints: ["Try again"] });
 */

import { randomUUID, createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { log } from "./logger.js";

// ─── Error Codes (stable, machine-readable) ─────────────────────

export const ErrorCode = {
  // 503 — subsystem not ready
  GEMINI_NOT_READY: "GEMINI_NOT_READY",
  MEMORY_NOT_AVAILABLE: "MEMORY_NOT_AVAILABLE",
  SETTINGS_NOT_AVAILABLE: "SETTINGS_NOT_AVAILABLE",
  DOCK_STORE_NOT_AVAILABLE: "DOCK_STORE_NOT_AVAILABLE",
  LOADOUT_STORE_NOT_AVAILABLE: "LOADOUT_STORE_NOT_AVAILABLE",
  REFERENCE_STORE_NOT_AVAILABLE: "REFERENCE_STORE_NOT_AVAILABLE",
  OVERLAY_STORE_NOT_AVAILABLE: "OVERLAY_STORE_NOT_AVAILABLE",
  SESSION_STORE_NOT_AVAILABLE: "SESSION_STORE_NOT_AVAILABLE",
  TARGET_STORE_NOT_AVAILABLE: "TARGET_STORE_NOT_AVAILABLE",
  CREW_STORE_NOT_AVAILABLE: "CREW_STORE_NOT_AVAILABLE",
  RECEIPT_STORE_NOT_AVAILABLE: "RECEIPT_STORE_NOT_AVAILABLE",
  PROPOSAL_STORE_NOT_AVAILABLE: "PROPOSAL_STORE_NOT_AVAILABLE",
  // 401/403 — auth errors
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  INSUFFICIENT_RANK: "INSUFFICIENT_RANK",
  RATE_LIMITED: "RATE_LIMITED",
  // 400 — client errors
  MISSING_PARAM: "MISSING_PARAM",
  INVALID_PARAM: "INVALID_PARAM",
  NOT_FOUND: "NOT_FOUND",
  UNKNOWN_CATEGORY: "UNKNOWN_CATEGORY",
  BUILTIN_IMMUTABLE: "BUILTIN_IMMUTABLE",
  CONFLICT: "CONFLICT",
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
    hints?: string[];
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
  const envelope = { ok: true, data, meta: buildMeta(res) };

  // ETag conditional revalidation for GET requests (ADR-032 Phase 4).
  // Hash only the data portion — meta.timestamp/durationMs change every request.
  if (res.req?.method === "GET" && statusCode === 200) {
    const dataJson = JSON.stringify(data);
    const hash = createHash("md5").update(dataJson).digest("base64url").slice(0, 16);
    const etag = `W/"${hash}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache");

    const ifNoneMatch = res.req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
  }

  res.status(statusCode).json(envelope);
}

/** Options for extended error details passed to sendFail. */
export interface FailOptions {
  detail?: unknown;
  hints?: string[];
}

/** Send an error envelope. */
export function sendFail(
  res: Response,
  code: string,
  message: string,
  statusCode = 400,
  options?: FailOptions,
): void {
  const detail = options?.detail;
  const hints = options?.hints;
  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
      ...(hints?.length ? { hints } : {}),
    },
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
        sendFail(res, ErrorCode.REQUEST_TIMEOUT, `Request timed out after ${Math.round(timeoutMs / 1000)}s — Aria may still be working through a multi-tool chain`, 504, {
          hints: ["Try a simpler request", "Break complex commands into smaller steps"],
        });
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

  let statusCode = err.status || err.statusCode || 500;
  let code: ErrorCodeValue = ErrorCode.INTERNAL_ERROR;

  // Handle express.json payload too large error
  if (err.message && err.message.includes("entity too large")) {
    statusCode = 413;
    code = ErrorCode.PAYLOAD_TOO_LARGE;
  }

  // Log the real error for debugging, but sanitize 5xx responses.
  // Client code never sees internal error details (DB strings, file paths, etc.).
  const internalMessage = err.message || "Internal server error";
  log.http.error({ err: internalMessage, requestId: res.locals._requestId }, "unhandled error");
  const clientMessage = statusCode >= 500 ? "Internal server error" : internalMessage;
  sendFail(res, code, clientMessage, statusCode);
}
