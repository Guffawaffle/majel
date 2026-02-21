/**
 * logger.ts — Structured Logging for Majel
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Built on pino — the Node.js structured logging standard.
 *
 * Configuration:
 *   MAJEL_LOG_LEVEL  — Minimum log level (default: "info", dev: "debug")
 *   MAJEL_LOG_PRETTY — Force pretty-print (auto-detected from NODE_ENV)
 *   MAJEL_DEBUG      — Legacy compat: "true" sets level to "debug"
 *
 * Usage:
 *   import { log } from "./logger.js";
 *   log.boot.info("server starting");
 *   log.gemini.debug({ messageLen: 120 }, "chat:send");
 *   log.gemini.error({ err }, "api call failed");
 *
 * Subsystem loggers:
 *   log.boot, log.gemini, log.lex, log.sheets, log.settings, log.fleet, log.http
 *
 * See ADR-009 for design decisions.
 */

import pino from "pino";
import type { Logger } from "pino";

// ─── Configuration ──────────────────────────────────────────────

const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
const IS_DEV = process.env.NODE_ENV !== "production" && !IS_TEST;

/** Resolve log level from environment */
function resolveLevel(): string {
  // Explicit level takes priority
  if (process.env.MAJEL_LOG_LEVEL) {
    return process.env.MAJEL_LOG_LEVEL;
  }
  // Legacy MAJEL_DEBUG compat
  const debugEnv = (process.env.MAJEL_DEBUG || "").trim().toLowerCase();
  if (debugEnv && debugEnv !== "false" && debugEnv !== "0") {
    return "debug";
  }
  // Silent in tests, debug in dev, info in prod
  if (IS_TEST) return "silent";
  if (IS_DEV) return "debug";
  return "info";
}

/** Build pino transport configuration */
function resolveTransport(): pino.TransportSingleOptions | undefined {
  // No transport in test mode (silent anyway)
  if (IS_TEST) return undefined;

  const wantPretty =
    process.env.MAJEL_LOG_PRETTY === "true" ||
    (process.env.MAJEL_LOG_PRETTY !== "false" && IS_DEV);

  if (wantPretty) {
    return {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    };
  }

  return undefined;
}

// ─── Root Logger ────────────────────────────────────────────────

const level = resolveLevel();
const transport = resolveTransport();

/**
 * Map pino numeric levels to GCP Cloud Logging severity strings.
 * @see https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
const PINO_TO_GCP_SEVERITY: Record<number, string> = {
  10: "DEBUG",    // trace
  20: "DEBUG",    // debug
  30: "INFO",     // info
  40: "WARNING",  // warn
  50: "ERROR",    // error
  60: "CRITICAL", // fatal
};

/** Whether to emit GCP-compatible JSON (production = no pino-pretty). */
const GCP_FORMAT = !IS_TEST && !transport;

export const rootLogger: Logger = pino({
  level,
  ...(transport ? { transport } : {}),
  // Use "message" key for GCP Cloud Logging compatibility (default: "msg")
  ...(GCP_FORMAT ? { messageKey: "message" } : {}),
  // Base fields on every log line
  base: { service: "majel" },
  // ISO timestamps for JSON output
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // In production, emit "severity": "INFO" instead of "level": 30
    // so Cloud Logging maps log levels automatically.
    ...(GCP_FORMAT
      ? {
          level(label: string, number: number) {
            return { severity: PINO_TO_GCP_SEVERITY[number] || label.toUpperCase(), level: number };
          },
        }
      : {}),
  },
  // Redact sensitive fields from all log output.
  // W12 fix: deeper paths — covers req.headers.authorization, nested token fields, etc.
  redact: {
    paths: [
      "token", "*.token", "**.token",
      "password", "*.password", "**.password",
      "sessionToken", "*.sessionToken", "**.sessionToken",
      "secret", "*.secret", "**.secret",
      "authorization", "*.authorization", "**.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});

// ─── Subsystem Child Loggers ────────────────────────────────────

/**
 * Subsystem loggers — each adds a `subsystem` field to every log line.
 *
 * Usage: log.gemini.info("engine online")
 *   → { level: 30, subsystem: "gemini", msg: "engine online", ... }
 */
export const log = {
  /** Boot/startup sequence */
  boot: rootLogger.child({ subsystem: "boot" }),
  /** Gemini API interactions */
  gemini: rootLogger.child({ subsystem: "gemini" }),
  /** Lex memory operations */
  lex: rootLogger.child({ subsystem: "lex" }),
  /** Google Sheets API */
  sheets: rootLogger.child({ subsystem: "sheets" }),
  /** Settings store */
  settings: rootLogger.child({ subsystem: "settings" }),
  /** Data stores (reference, overlay, dock, gamedata-ingest) */
  fleet: rootLogger.child({ subsystem: "fleet" }),
  /** HTTP/API layer */
  http: rootLogger.child({ subsystem: "http" }),
  /** Authentication & authorization events */
  auth: rootLogger.child({ subsystem: "auth" }),
  /** Root logger (for one-off use) */
  root: rootLogger,
};

export type { Logger };
