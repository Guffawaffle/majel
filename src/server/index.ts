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
import cookieParser from "cookie-parser";
import { IncomingMessage } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { log, rootLogger } from "./logger.js";
import { createGeminiEngine } from "./gemini.js";
import { createMemoryService } from "./memory.js";
import { createSettingsStore } from "./settings.js";
import { createSessionStore } from "./sessions.js";
import { createDockStore } from "./dock-store.js";
import { createBehaviorStore } from "./behavior-store.js";
import { createReferenceStore } from "./reference-store.js";
import { createOverlayStore } from "./overlay-store.js";
import { createInviteStore } from "./invite-store.js";
import { createUserStore } from "./user-store.js";
import { createPool } from "./db.js";

// Shared types & config (avoids circular deps between index ↔ routes)
import {
  type AppState,
  readFleetConfig,
  readDockBriefing,
  buildMicroRunnerFromState,
} from "./app-context.js";

// Configuration (ADR-005 Phase 3)
import { bootstrapConfigSync, resolveConfig } from "./config.js";

// Envelope (ADR-004)
import { envelopeMiddleware, errorHandler, createTimeoutMiddleware } from "./envelope.js";

// Route modules
import { createCoreRoutes } from "./routes/core.js";
import { createChatRoutes } from "./routes/chat.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDockRoutes } from "./routes/docks.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createDiagnosticQueryRoutes } from "./routes/diagnostic-query.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdminRoutes } from "./routes/admin.js";

// Re-export for test compatibility
export type { AppState };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Static file path ───────────────────────────────────────────
const clientDir = path.resolve(
  __dirname,
  // Use bootstrap config for NODE_ENV check
  bootstrapConfigSync().nodeEnv === "production" ? "../../dist/client" : "../client",
);

// ─── Module-level state ─────────────────────────────────────────
const state: AppState = {
  pool: null,
  geminiEngine: null,
  memoryService: null,
  settingsStore: null,
  sessionStore: null,
  dockStore: null,
  behaviorStore: null,
  referenceStore: null,
  overlayStore: null,
  inviteStore: null,
  userStore: null,
  startupComplete: false,
  config: bootstrapConfigSync(), // Initialize with bootstrap config
};

// ─── App Factory ────────────────────────────────────────────────
export function createApp(appState: AppState): express.Express {
  const app = express();

  // Trust Cloud Run's load balancer so req.ip is the real client IP
  // Required for rate limiting and logging behind GFE / Cloud Run proxy
  app.set("trust proxy", true);
  
  // AX-First response envelope (ADR-004) — requestId + timing on every request
  // MUST come before body parser so request ID is available for all errors
  app.use(envelopeMiddleware);
  
  // Body parser with size limit (ADR-005 Phase 4)
  app.use(express.json({ limit: '100kb' }));

  // Cookie parser (ADR-018 Phase 2 — tenant cookies)
  app.use(cookieParser());

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

  // Static files (for /app/* — the authenticated SPA)
  app.use("/app", express.static(clientDir));

  // ─── Landing page routes (ADR-019 Phase 1) ────────────────
  const landingFile = path.join(clientDir, "landing.html");

  // Public landing page routes → landing.html
  for (const route of ["/", "/login", "/signup", "/verify", "/reset-password"]) {
    app.get(route, (_req, res) => {
      res.sendFile(landingFile);
    });
  }

  // ─── Mount route modules ──────────────────────────────────
  app.use(createCoreRoutes(appState));
  app.use(createAuthRoutes(appState));
  app.use(createAdminRoutes(appState));
  app.use(createChatRoutes(appState));
  app.use(createSettingsRoutes(appState));
  app.use(createSessionRoutes(appState));
  app.use(createDockRoutes(appState));
  app.use(createCatalogRoutes(appState));
  app.use(createDiagnosticQueryRoutes(appState));

  // ─── SPA Fallback (authenticated app) ─────────────────────
  app.get("/app/*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  // ─── Error handler (ADR-004 — catch-all → envelope) ──────
  app.use(errorHandler);

  return app;
}

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  log.boot.info("Majel initializing");

  // 0. Create PostgreSQL connection pool
  const pool = createPool(state.config.databaseUrl);
  state.pool = pool;
  log.boot.info({ url: state.config.databaseUrl.replace(/\/\/.*@/, "//<redacted>@") }, "database pool created");

  // 1. Initialize settings store
  try {
    state.settingsStore = await createSettingsStore(pool);
    log.boot.info("settings store online");
    
    // Re-resolve config now that settings store is available
    state.config = await resolveConfig(state.settingsStore);
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

  // 2b. Initialize session store
  try {
    state.sessionStore = await createSessionStore(pool);
    log.boot.info({ sessions: await state.sessionStore.count() }, "session store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "session store init failed");
  }

  // 2d. Initialize dock store (shares tables with reference)
  try {
    state.dockStore = await createDockStore(pool);
    const dockCounts = await state.dockStore.counts();
    log.boot.info({ intents: dockCounts.intents, docks: dockCounts.docks }, "dock store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "dock store init failed");
  }

  // 2e. Initialize behavior store
  try {
    state.behaviorStore = await createBehaviorStore(pool);
    const behaviorCounts = await state.behaviorStore.counts();
    log.boot.info({ rules: behaviorCounts.total, active: behaviorCounts.active }, "behavior store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "behavior store init failed");
  }

  // 2f. Initialize reference store
  try {
    state.referenceStore = await createReferenceStore(pool);
    const refCounts = await state.referenceStore.counts();
    log.boot.info({ officers: refCounts.officers, ships: refCounts.ships }, "reference store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "reference store init failed");
  }

  // 2g. Initialize overlay store
  try {
    state.overlayStore = await createOverlayStore(pool);
    const overlayCounts = await state.overlayStore.counts();
    log.boot.info({
      officerOverlays: overlayCounts.officers.total,
      shipOverlays: overlayCounts.ships.total,
    }, "overlay store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "overlay store init failed");
  }

  // 2h. Initialize invite store
  try {
    state.inviteStore = await createInviteStore(pool);
    const codes = await state.inviteStore.listCodes();
    log.boot.info({ codes: codes.length, authEnabled: state.config.authEnabled }, "invite store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "invite store init failed");
  }

  // 2i. Initialize user store (ADR-019)
  try {
    state.userStore = await createUserStore(pool);
    const userCount = await state.userStore.countUsers();
    log.boot.info({ users: userCount }, "user store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "user store init failed");
  }

  // Resolve config from settings store
  const { geminiApiKey } = state.config;

  // 3. Initialize Gemini engine
  if (geminiApiKey) {
    const runner = await buildMicroRunnerFromState(state);
    state.geminiEngine = createGeminiEngine(
      geminiApiKey,
      await readFleetConfig(state.settingsStore),
      await readDockBriefing(state.dockStore),
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
  // Close all store handles (no-ops since pool is shared)
  state.settingsStore?.close();
  state.sessionStore?.close();
  state.dockStore?.close();
  state.behaviorStore?.close();
  state.overlayStore?.close();
  state.inviteStore?.close();
  state.userStore?.close();
  state.referenceStore?.close();
  if (state.memoryService) {
    await state.memoryService.close();
  }
  // Drain the connection pool
  if (state.pool) {
    await state.pool.end();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Launch (guarded for test imports) ──────────────────────────
if (!bootstrapConfigSync().isTest) {
  boot().catch((err) => {
    log.boot.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal startup error");
    process.exit(1);
  });
}
