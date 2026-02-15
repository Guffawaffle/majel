/**
 * config.ts — Unified Configuration Resolution (ADR-005 Phase 3)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Single source of truth for all configuration. Priority chain:
 *   1. User setting (settings store)  ← highest
 *   2. Environment variable
 *   3. Schema default                 ← lowest
 *
 * Rules:
 * - All configuration resolves through `resolveConfig()`
 * - Settings store is source of truth, env vars are fallback
 * - No `process.env` reads outside this file (except logger bootstrap)
 * - Config object is fully typed
 */

import type { SettingsStore } from "./stores/settings.js";

// ─── Configuration Interface ────────────────────────────────────

/**
 * Complete application configuration.
 * All config values are typed and resolved through a single function.
 */
export interface AppConfig {
  // ── System ──────────────────────────────────────────────────
  /** Server port (default: 3000) */
  port: number;
  /** Node environment (production, development, test) */
  nodeEnv: string;
  /** Whether running in test mode */
  isTest: boolean;
  /** Whether running in development mode */
  isDev: boolean;

  // ── Gemini API ──────────────────────────────────────────────
  /** Gemini API key for LLM access */
  geminiApiKey: string;

  // ── Lex Memory ──────────────────────────────────────────────
  /** Lex workspace root directory */
  lexWorkspaceRoot: string;

  // ── Database (ADR-018 Phase 3, #39) ──────────────────────────
  /** PostgreSQL connection URL for application queries (non-superuser, RLS enforced) */
  databaseUrl: string;
  /** PostgreSQL connection URL for schema migrations (superuser, DDL only) */
  databaseAdminUrl: string;

  // ── Auth (ADR-018 Phase 2) ──────────────────────────────────
  /** Admin bearer token — if empty, auth is disabled (local/demo mode) */
  adminToken: string;
  /** Secret used for invite code HMAC generation */
  inviteSecret: string;
  /** Whether auth is enforced (true when adminToken is set) */
  authEnabled: boolean;

  // ── Logging ─────────────────────────────────────────────────
  /** Log level (silent, debug, info, warn, error) */
  logLevel: string;
  /** Whether to use pretty-printed logs */
  logPretty: boolean;
}

// ─── Resolution Helpers ─────────────────────────────────────────

/**
 * Resolve log level from environment.
 * This is separate from settings store because logger initializes at module scope.
 */
function resolveLogLevel(isTest: boolean, isDev: boolean): string {
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
  if (isTest) return "silent";
  if (isDev) return "debug";
  return "info";
}

/**
 * Resolve whether to pretty-print logs.
 */
function resolveLogPretty(isTest: boolean, isDev: boolean): boolean {
  if (isTest) return false;
  return (
    process.env.MAJEL_LOG_PRETTY === "true" ||
    (process.env.MAJEL_LOG_PRETTY !== "false" && isDev)
  );
}

// ─── Main Resolution Function ───────────────────────────────────

/**
 * Resolve complete application configuration.
 *
 * This is the single source of truth for all config values.
 * Call this during app bootstrap and any time settings change.
 *
 * @param settingsStore - User settings store (null during early bootstrap)
 * @returns Fully resolved configuration object
 */
export async function resolveConfig(settingsStore: SettingsStore | null): Promise<AppConfig> {
  // Environment detection (always from process.env — not configurable)
  const nodeEnv = process.env.NODE_ENV || "development";
  const isTest = nodeEnv === "test" || process.env.VITEST === "true";
  const isDev = nodeEnv !== "production" && !isTest;

  // Resolve all settings
  const port = settingsStore
    ? parseInt(await settingsStore.get("system.port"), 10)
    : parseInt(process.env.MAJEL_PORT || process.env.PORT || "3000", 10);

  const geminiApiKey = settingsStore
    ? await settingsStore.get("model.apiKey")
    : process.env.GEMINI_API_KEY || "";

  // Lex workspace (special: used by Lex library, needs env var fallback)
  const lexWorkspaceRoot = process.env.LEX_WORKSPACE_ROOT || process.cwd();

  // Logging config (special: needed at module scope before settings exist)
  const logLevel = resolveLogLevel(isTest, isDev);
  const logPretty = resolveLogPretty(isTest, isDev);

  // Auth config (env-only — not user-configurable)
  const adminToken = process.env.MAJEL_ADMIN_TOKEN || "";
  const inviteSecret = process.env.MAJEL_INVITE_SECRET || "";

  // Database URLs (env-only) — dual-pool pattern (#39)
  // App pool: non-superuser (RLS enforced). Admin pool: superuser (DDL/schema only).
  const databaseAdminUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || "postgres://majel:majel@localhost:5432/majel";
  const databaseUrl = process.env.DATABASE_URL || "postgres://majel_app:majel_app@localhost:5432/majel";

  return {
    port,
    nodeEnv,
    isTest,
    isDev,
    geminiApiKey,
    lexWorkspaceRoot,
    databaseUrl,
    databaseAdminUrl,
    adminToken,
    inviteSecret,
    authEnabled: adminToken.length > 0,
    logLevel,
    logPretty,
  };
}

/**
 * Get a minimal bootstrap config before settings store is available.
 * Used during early initialization.
 */
export async function bootstrapConfig(): Promise<AppConfig> {
  return resolveConfig(null);
}

/**
 * Synchronous bootstrap config for early init (no settings store).
 * Uses only env vars and defaults — no async needed.
 */
export function bootstrapConfigSync(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || "development";
  const isTest = nodeEnv === "test" || process.env.VITEST === "true";
  const isDev = nodeEnv !== "production" && !isTest;
  const logLevel = resolveLogLevel(isTest, isDev);
  const logPretty = resolveLogPretty(isTest, isDev);
  const adminToken = process.env.MAJEL_ADMIN_TOKEN || "";
  const inviteSecret = process.env.MAJEL_INVITE_SECRET || "";
  return {
    port: parseInt(process.env.MAJEL_PORT || process.env.PORT || "3000", 10),
    nodeEnv,
    isTest,
    isDev,
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    lexWorkspaceRoot: process.env.LEX_WORKSPACE_ROOT || process.cwd(),
    databaseUrl: process.env.DATABASE_URL || "postgres://majel_app:majel_app@localhost:5432/majel",
    databaseAdminUrl: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || "postgres://majel:majel@localhost:5432/majel",
    adminToken,
    inviteSecret,
    authEnabled: adminToken.length > 0,
    logLevel,
    logPretty,
  };
}
