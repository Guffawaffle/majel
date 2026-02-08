/**
 * debug.ts — Debug Logging for Majel Subsystems
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Toggle with MAJEL_DEBUG=true (or MAJEL_DEBUG=lex,sheets,gemini for selective).
 * Logs to stderr so it doesn't pollute API responses.
 *
 * Usage:
 *   import { debug } from "./debug.js";
 *   debug.lex("remember", { question: "...", frameId: "..." });
 *   debug.sheets("fetchTab", { tab: "Officers", rows: 42 });
 *   debug.gemini("chat", { messageLen: 120, responseLen: 450 });
 */

type Subsystem = "lex" | "sheets" | "gemini" | "settings" | "boot";

const DEBUG_ENV = process.env.MAJEL_DEBUG || "";
const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

/** Which subsystems are enabled */
function parseDebugEnv(env: string): Set<Subsystem> | "all" | "none" {
  if (IS_TEST) return "none";
  const val = env.trim().toLowerCase();
  if (val === "" || val === "false" || val === "0") return "none";
  if (val === "true" || val === "1" || val === "*") return "all";
  return new Set(val.split(",").map((s) => s.trim()) as Subsystem[]);
}

const enabled = parseDebugEnv(DEBUG_ENV);

function isEnabled(subsystem: Subsystem): boolean {
  if (enabled === "none") return false;
  if (enabled === "all") return true;
  return enabled.has(subsystem);
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(subsystem: Subsystem, operation: string, data?: Record<string, unknown>): void {
  if (!isEnabled(subsystem)) return;

  const prefix = `[DEBUG:${subsystem}]`;
  const ts = formatTimestamp();
  const detail = data ? " " + JSON.stringify(data) : "";
  console.error(`${ts} ${prefix} ${operation}${detail}`);
}

/** Structured debug loggers for each subsystem */
export const debug = {
  lex(operation: string, data?: Record<string, unknown>): void {
    log("lex", operation, data);
  },
  sheets(operation: string, data?: Record<string, unknown>): void {
    log("sheets", operation, data);
  },
  gemini(operation: string, data?: Record<string, unknown>): void {
    log("gemini", operation, data);
  },
  settings(operation: string, data?: Record<string, unknown>): void {
    log("settings", operation, data);
  },
  boot(operation: string, data?: Record<string, unknown>): void {
    log("boot", operation, data);
  },

  /** Check if any debug logging is active */
  get active(): boolean {
    return enabled !== "none";
  },

  /** Check if a specific subsystem is being traced */
  isEnabled,
};
