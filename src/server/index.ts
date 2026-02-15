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
import compression from "compression";
import cookieParser from "cookie-parser";
import { IncomingMessage } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { log, rootLogger } from "./logger.js";
import { createGeminiEngine } from "./services/gemini.js";
import { createMemoryService } from "./services/memory.js";
import { createFrameStoreFactory } from "./stores/postgres-frame-store.js";
import { createSettingsStore } from "./stores/settings.js";
import { createSessionStore } from "./sessions.js";
import { createDockStore } from "./stores/dock-store.js";
import { createLoadoutStore } from "./stores/loadout-store.js";
import { createBehaviorStore } from "./stores/behavior-store.js";
import { createReferenceStore } from "./stores/reference-store.js";
import { createOverlayStore } from "./stores/overlay-store.js";
import { createInviteStore } from "./stores/invite-store.js";
import { createUserStore } from "./stores/user-store.js";
import { createPool, ensureAppRole } from "./db.js";
// attachScopedMemory imported per-route in routes/chat.ts (ADR-021 D4)

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
import { envelopeMiddleware, errorHandler, createTimeoutMiddleware, sendFail, ErrorCode } from "./envelope.js";

// Route modules
import { createCoreRoutes } from "./routes/core.js";
import { createChatRoutes } from "./routes/chat.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDockRoutes } from "./routes/docks.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createDiagnosticQueryRoutes } from "./routes/diagnostic-query.js";
import { createLoadoutRoutes } from "./routes/loadouts.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdmiralRoutes } from "./routes/admiral.js";

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
  adminPool: null,
  pool: null,
  geminiEngine: null,
  memoryService: null,
  frameStoreFactory: null,
  settingsStore: null,
  sessionStore: null,
  dockStore: null,
  loadoutStore: null,
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

  // Trust exactly one proxy hop (Cloud Run's Google Frontend)
  // Using 1 instead of true avoids ERR_ERL_PERMISSIVE_TRUST_PROXY
  app.set("trust proxy", 1);
  
  // AX-First response envelope (ADR-004) — requestId + timing on every request
  // MUST come before body parser so request ID is available for all errors
  app.use(envelopeMiddleware);
  
  // Body parser with size limit (ADR-005 Phase 4)
  app.use(express.json({ limit: '100kb' }));

  // Cookie parser (ADR-018 Phase 2 — tenant cookies)
  app.use(cookieParser());

  // Response compression — 60-70% smaller JS/CSS/JSON responses (ADR-023)
  app.use(compression());

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

  // ─── Security headers (ADR-023 Phase 0) ───────────────────
  // Content-Security-Policy — locks down resource loading.
  // All inline style="" attrs were removed in Phases 2-3.
  // JS `.style.*` (CSSOM) is not affected by style-src.
  // img-src/connect-src 'self' blocks CSS-based data exfiltration vectors.
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    next();
  });

  // CSRF protection — require custom header on state-changing requests.
  // X-Requested-With cannot be set cross-origin without CORS preflight.
  // Combined with sameSite: strict cookies, this is defense-in-depth.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'majel-client') {
      return sendFail(res, ErrorCode.FORBIDDEN, 'Missing CSRF header', 403);
    }
    next();
  });

  // Static files (for /app/* — the authenticated SPA)
  // Cache headers: 1 day browser cache, etag for conditional revalidation (ADR-023)
  app.use("/app", express.static(clientDir, {
    maxAge: '1d',
    etag: true,
  }));

  // ─── Landing page routes (ADR-019 Phase 1) ────────────────
  const landingFile = path.join(clientDir, "landing.html");

  // Landing page static assets (landing.css, landing.js)
  app.get('/landing.css', (_req, res) => res.sendFile(path.join(clientDir, 'landing.css')));
  app.get('/landing.js', (_req, res) => res.sendFile(path.join(clientDir, 'landing.js')));

  // Public landing page routes → landing.html
  for (const route of ["/", "/login", "/signup", "/verify", "/reset-password"]) {
    app.get(route, (_req, res) => {
      res.sendFile(landingFile);
    });
  }

  // ─── Mount route modules ──────────────────────────────────
  // Per-request scoped memory (ADR-021 D4) is chained per-route in chat.ts,
  // AFTER auth middleware sets res.locals.userId. Not app-level — auth is route-level.
  app.use(createCoreRoutes(appState));
  app.use(createAuthRoutes(appState));
  app.use(createAdmiralRoutes(appState));
  app.use(createChatRoutes(appState));
  app.use(createSettingsRoutes(appState));
  app.use(createSessionRoutes(appState));
  app.use(createDockRoutes(appState));
  app.use(createCatalogRoutes(appState));
  app.use(createDiagnosticQueryRoutes(appState));
  app.use(createLoadoutRoutes(appState));

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

  // 0. Create PostgreSQL connection pools — dual-pool pattern (#39)
  // Admin pool (superuser) — DDL/schema only
  const adminPool = createPool(state.config.databaseAdminUrl);
  state.adminPool = adminPool;
  log.boot.info({ url: state.config.databaseAdminUrl.replace(/\/\/.*@/, "//<redacted>@") }, "admin pool created (DDL)");

  // Ensure non-superuser app role exists (idempotent)
  try {
    await ensureAppRole(adminPool);
    log.boot.info("majel_app role ready");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "ensureAppRole failed — RLS may not work");
  }

  // 1. Initialize settings store (admin pool for DDL, app pool after init)
  try {
    state.settingsStore = await createSettingsStore(adminPool);
    log.boot.info("settings store online");
    
    // Re-resolve config now that settings store is available
    state.config = await resolveConfig(state.settingsStore);
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "settings store init failed");
  }

  // 1b. Create app pool (non-superuser) — all runtime queries, RLS enforced
  const pool = createPool(state.config.databaseUrl);
  state.pool = pool;
  log.boot.info({ url: state.config.databaseUrl.replace(/\/\/.*@/, "//<redacted>@") }, "app pool created (RLS enforced)");

  // Re-grant privileges on any tables created by settings store init
  try {
    await adminPool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO majel_app",
    );
  } catch { /* ignore — role may not exist in test environments */ }

  // 2. Initialize Lex memory — ADR-021: prefer PostgreSQL + RLS when pool is available
  try {
    if (adminPool) {
      const factory = await createFrameStoreFactory(adminPool, pool);
      state.frameStoreFactory = factory;
      // Boot-time memory service uses a system-scoped store (for /api/health frame count)
      state.memoryService = createMemoryService(factory.forUser("system"));
      log.boot.info("lex memory service online (postgres + RLS)");
    } else {
      state.memoryService = createMemoryService();
      log.boot.info("lex memory service online (sqlite fallback)");
    }
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "lex memory init failed");
  }

  // 2b. Initialize session store
  try {
    state.sessionStore = await createSessionStore(adminPool, pool);
    log.boot.info({ sessions: await state.sessionStore.count() }, "session store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "session store init failed");
  }

  // 2d. Initialize dock store (shares tables with reference)
  try {
    state.dockStore = await createDockStore(adminPool, pool);
    const dockCounts = await state.dockStore.counts();
    log.boot.info({ intents: dockCounts.intents, docks: dockCounts.docks }, "dock store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "dock store init failed");
  }

  // 2d2. Initialize loadout store (ADR-022 Phase 2)
  try {
    state.loadoutStore = await createLoadoutStore(adminPool, pool);
    const loadoutCounts = await state.loadoutStore.counts();
    log.boot.info({
      intents: loadoutCounts.intents,
      loadouts: loadoutCounts.loadouts,
      planItems: loadoutCounts.planItems,
    }, "loadout store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "loadout store init failed");
  }

  // 2e. Initialize behavior store
  try {
    state.behaviorStore = await createBehaviorStore(adminPool, pool);
    const behaviorCounts = await state.behaviorStore.counts();
    log.boot.info({ rules: behaviorCounts.total, active: behaviorCounts.active }, "behavior store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "behavior store init failed");
  }

  // 2f. Initialize reference store
  try {
    state.referenceStore = await createReferenceStore(adminPool, pool);
    const refCounts = await state.referenceStore.counts();
    log.boot.info({ officers: refCounts.officers, ships: refCounts.ships }, "reference store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "reference store init failed");
  }

  // 2g. Initialize overlay store
  try {
    state.overlayStore = await createOverlayStore(adminPool, pool);
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
    state.inviteStore = await createInviteStore(adminPool, pool);
    const codes = await state.inviteStore.listCodes();
    log.boot.info({ codes: codes.length, authEnabled: state.config.authEnabled }, "invite store online");
  } catch (err) {
    log.boot.error({ err: err instanceof Error ? err.message : String(err) }, "invite store init failed");
  }

  // 2i. Initialize user store (ADR-019)
  try {
    state.userStore = await createUserStore(adminPool, pool);
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
    const modelName = state.settingsStore
      ? await state.settingsStore.get("model.name")
      : undefined;
    state.geminiEngine = createGeminiEngine(
      geminiApiKey,
      await readFleetConfig(state.settingsStore),
      await readDockBriefing(state.dockStore),
      runner,
      modelName,
      {
        referenceStore: state.referenceStore,
        overlayStore: state.overlayStore,
        loadoutStore: state.loadoutStore,
      },
    );
    log.boot.info({ model: state.geminiEngine.getModel(), microRunner: !!runner }, "gemini engine online");
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
  state.loadoutStore?.close();
  state.behaviorStore?.close();
  state.overlayStore?.close();
  state.inviteStore?.close();
  state.userStore?.close();
  state.referenceStore?.close();
  if (state.memoryService) {
    await state.memoryService.close();
  }
  // Drain connection pools
  if (state.pool) {
    await state.pool.end();
  }
  if (state.adminPool) {
    await state.adminPool.end();
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
