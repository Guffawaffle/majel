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
  SHEETS_NOT_CONFIGURED: "SHEETS_NOT_CONFIGURED",
  BUILTIN_IMMUTABLE: "BUILTIN_IMMUTABLE",
  // 500 — upstream failures
  GEMINI_ERROR: "GEMINI_ERROR",
  MEMORY_ERROR: "MEMORY_ERROR",
  SHEETS_ERROR: "SHEETS_ERROR",
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

// ─── Catch-all error handler (mount AFTER routes) ───────────────

export function errorHandler(err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction): void {
  const message = err.message || "Internal server error";
  const statusCode = err.status || err.statusCode || 500;
  log.boot.error({ err: message, requestId: res.locals._requestId }, "unhandled error");
  sendFail(res, ErrorCode.INTERNAL_ERROR, message, statusCode);
}
