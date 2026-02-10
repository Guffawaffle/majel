/**
 * index.ts — Majel Express Server (thin shell)
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * This file is the minimal app factory + boot sequence.
 * Route handlers live in src/server/routes/*.ts (ADR-005 Phase 2).
 *
 * Endpoints:
 *   GET  /api/health       — Status check
 *   GET  /api/diagnostic   — Deep subsystem status
 *   GET  /api              — API discovery manifest
 *   GET  /api/roster       — Fetch/refresh roster from Sheets
 *   POST /api/chat         — Send message, get Gemini response
 *   GET  /api/history      — Conversation history from Lex
 *   GET  /api/recall       — Search Lex memory (query param: q)
 *   GET  /api/settings      — All settings with resolved values
 *   PATCH /api/settings     — Update one or more settings
 *   DELETE /api/settings/:key — Reset a setting to default
 *
 * Static files served from src/client/ (dev) or dist/client/ (prod).
 */

import express from "express";
import { IncomingMessage } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { log, rootLogger } from "./logger.js";
import { createGeminiEngine } from "./gemini.js";
import { createMemoryService } from "./memory.js";
import { createSettingsStore } from "./settings.js";
import { createSessionStore } from "./sessions.js";
import { createFleetStore } from "./fleet-store.js";
import { createDockStore } from "./dock-store.js";
import { createBehaviorStore } from "./behavior-store.js";
import { createReferenceStore } from "./reference-store.js";
import { createOverlayStore } from "./overlay-store.js";

// Shared types & config (avoids circular deps between index ↔ routes)
import {
  type AppState,
  readFleetConfig,
  readDockBriefing,
  buildMicroRunnerFromState,
} from "./app-context.js";

// Configuration (ADR-005 Phase 3)
import { bootstrapConfig, resolveConfig } from "./config.js";

// Envelope (ADR-004)
import { envelopeMiddleware, errorHandler, createTimeoutMiddleware } from "./envelope.js";

// Route modules
import { createCoreRoutes } from "./routes/core.js";
import { createChatRoutes } from "./routes/chat.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createFleetRoutes } from "./routes/fleet.js";
import { createDockRoutes } from "./routes/docks.js";

// Re-export for test compatibility
export type { AppState };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Static file path ───────────────────────────────────────────
const clientDir = path.resolve(
  __dirname,
  // Use bootstrap config for NODE_ENV check
  bootstrapConfig().nodeEnv === "production" ? "../../dist/client" : "../client",
);

// ─── Module-level state ─────────────────────────────────────────
const state: AppState = {
  geminiEngine: null,
  memoryService: null,
  settingsStore: null,
  sessionStore: null,
  fleetStore: null,
  dockStore: null,
  behaviorStore: null,
  referenceStore: null,
  overlayStore: null,
  startupComplete: false,
  config: bootstrapConfig(), // Initialize with bootstrap config
};

// ─── App Factory ────────────────────────────────────────────────
export function createApp(appState: AppState): express.Express {
  const app = express();
  
  // AX-First response envelope (ADR-004) — requestId + timing on every request
  // MUST come before body parser so request ID is available for all errors
  app.use(envelopeMiddleware);
  
  // Body parser with size limit (ADR-005 Phase 4)
  app.use(express.json({ limit: '100kb' }));

  // Structured HTTP request logging
  app.use(
    pinoHttp({
      logger: rootLogger,
      autoLogging: {
        ignore: (req: IncomingMessage) => {
          const url = req.url || "";
          return (
            url.startsWith("/styles") ||
            url.startsWith("/app.js") ||
            url.startsWith("/favicon")
          );
        },
      },
    }),
  );

  // Static files
  app.use(express.static(clientDir));

  // ─── Mount route modules ──────────────────────────────────
  app.use(createCoreRoutes(appState));
  app.use(createChatRoutes(appState));
  app.use(createSettingsRoutes(appState));
  app.use(createSessionRoutes(appState));
  app.use(createFleetRoutes(appState));
  app.use(createDockRoutes(appState));

  // ─── SPA Fallback ─────────────────────────────────────────
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  // ─── Error handler (ADR-004 — catch-all → envelope) ──────
  app.use(errorHandler);

  return app;
}

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  log.boot.info("Majel initializing");

  // 1. Initialize settings store (always — it's local SQLite)
  try {
    state.settingsStore = createSettingsStore();
    log.boot.info("settings store online");
    
    // Re-resolve config now that settings store is available
    state.config = resolveConfig(state.settingsStore);
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "settings store init failed");
  }

  // 2. Initialize Lex memory (always — it's local)
  try {
    state.memoryService = createMemoryService();
    log.boot.info("lex memory service online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "lex memory init failed");
  }

  // 2b. Initialize session store (always — it's local SQLite)
  try {
    state.sessionStore = createSessionStore();
    log.boot.info({ sessions: state.sessionStore.count() }, "session store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "session store init failed");
  }

  // 2c. Initialize fleet store (always — it's local SQLite)
  try {
    state.fleetStore = createFleetStore();
    const counts = state.fleetStore.counts();
    log.boot.info({ ships: counts.ships, officers: counts.officers }, "fleet store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "fleet store init failed");
  }

  // 2d. Initialize dock store (always — shares fleet.db)
  try {
    state.dockStore = createDockStore();
    const dockCounts = state.dockStore.counts();
    log.boot.info({ intents: dockCounts.intents, docks: dockCounts.docks }, "dock store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "dock store init failed");
  }

  // 2e. Initialize behavior store (ADR-014 Phase 2 — behavioral rules)
  try {
    state.behaviorStore = createBehaviorStore();
    const behaviorCounts = state.behaviorStore.counts();
    log.boot.info({ rules: behaviorCounts.total, active: behaviorCounts.active }, "behavior store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "behavior store init failed");
  }

  // 2f. Initialize reference store (ADR-015/016 — canonical reference catalog)
  try {
    state.referenceStore = createReferenceStore();
    const refCounts = state.referenceStore.counts();
    log.boot.info({ officers: refCounts.officers, ships: refCounts.ships }, "reference store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "reference store init failed");
  }

  // 2g. Initialize overlay store (ADR-016 — user ownership + targeting)
  try {
    state.overlayStore = createOverlayStore();
    const overlayCounts = state.overlayStore.counts();
    log.boot.info({
      officerOverlays: overlayCounts.officers.total,
      shipOverlays: overlayCounts.ships.total,
    }, "overlay store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "overlay store init failed");
  }

  // Resolve config from settings store
  const { geminiApiKey } = state.config;

  // 3. Initialize Gemini engine
  if (geminiApiKey) {
    const runner = buildMicroRunnerFromState(state);
    state.geminiEngine = createGeminiEngine(
      geminiApiKey,
      readFleetConfig(state.settingsStore),
      readDockBriefing(state.dockStore),
      runner,
    );
    log.boot.info({ model: "gemini-2.5-flash-lite", microRunner: !!runner }, "gemini engine online");
  } else {
    log.boot.warn("GEMINI_API_KEY not set — chat disabled");
  }

  state.startupComplete = true;

  // 4. Start HTTP server
  const app = createApp(state);
  app.listen(state.config.port, () => {
    log.boot.info({ port: state.config.port, url: `http://localhost:${state.config.port}` }, "Majel online");
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────
async function shutdown(): Promise<void> {
  log.boot.info("Majel offline. Live long and prosper.");
  if (state.settingsStore) {
    state.settingsStore.close();
  }
  if (state.sessionStore) {
    state.sessionStore.close();
  }
  if (state.fleetStore) {
    state.fleetStore.close();
  }
  if (state.dockStore) {
    state.dockStore.close();
  }
  if (state.behaviorStore) {
    state.behaviorStore.close();
  }
  if (state.overlayStore) {
    state.overlayStore.close();
  }
  if (state.referenceStore) {
    state.referenceStore.close();
  }
  if (state.memoryService) {
    await state.memoryService.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Launch (guarded for test imports) ──────────────────────────
if (!state.config.isTest) {
  boot().catch((err) => {
    log.boot.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal startup error");
    process.exit(1);
  });
}
