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
 *   POST /api/chat         — Send message, get Gemini response
 *   GET  /api/history      — Conversation history from Lex
 *   GET  /api/recall       — Search Lex memory (query param: q)
 *   GET  /api/settings      — All settings with resolved values
 *   PATCH /api/settings     — Update one or more settings
 *   DELETE /api/settings/:key — Reset a setting to default
 *
 * Static files: Svelte SPA from dist/web/, landing page from src/landing/.
 */

import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { IncomingMessage, Server as HttpServer } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { log, rootLogger } from "./logger.js";
import { createGeminiEngine, DEFAULT_MODEL } from "./services/gemini/index.js";
import { createClaudeEngine } from "./services/claude/index.js";
import { createEngineManager } from "./services/engine-manager.js";
import { createMemoryService } from "./services/memory.js";
import { createFrameStoreFactory } from "./stores/postgres-frame-store.js";
import { createSettingsStore } from "./stores/settings.js";
import { createSessionStore } from "./sessions.js";
import { createCrewStoreFactory } from "./stores/crew-store.js";
import { createReceiptStoreFactory } from "./stores/receipt-store.js";
import { createBehaviorStore } from "./stores/behavior-store.js";
import { createReferenceStore } from "./stores/reference-store.js";
import {
  syncCdnShips,
  syncCdnOfficers,
  syncCdnResearch,
  syncCdnBuildings,
  syncCdnHostiles,
  syncCdnConsumables,
  syncCdnSystems,
} from "./services/gamedata-ingest.js";
import { createOverlayStoreFactory } from "./stores/overlay-store.js";
import { createInviteStore } from "./stores/invite-store.js";
import { createUserStore } from "./stores/user-store.js";
import { createAuditStore } from "./stores/audit-store.js";
import { createUserSettingsStore } from "./stores/user-settings-store.js";
import { createTargetStoreFactory } from "./stores/target-store.js";
import { createResearchStoreFactory } from "./stores/research-store.js";
import { createInventoryStoreFactory } from "./stores/inventory-store.js";
import { createProposalStoreFactory } from "./stores/proposal-store.js";
import { createOperationEventStoreFactory } from "./stores/operation-event-store.js";
import { createChatRunStore } from "./stores/chat-run-store.js";
import { createEffectStore } from "./stores/effect-store.js";
import { loadEffectSeedData } from "./services/effect-seed-loader.js";
import { loadResourceDefs, type ResourceDef } from "./services/resource-defs.js";
import { createPool, ensureAppRole } from "./db.js";
// attachScopedMemory imported per-route in routes/chat.ts (ADR-021 D4)

// Shared types & config (avoids circular deps between index ↔ routes)
import {
  type AppState,
  buildMicroRunnerFromState,
} from "./app-context.js";

// Boot runner (ADR-047)
import { runStage } from "./boot-runner.js";

// Configuration (ADR-005 Phase 3)
import { bootstrapConfigSync, resolveConfig } from "./config.js";

// Envelope (ADR-004)
import { envelopeMiddleware, errorHandler, sendFail, ErrorCode } from "./envelope.js";

// Rate limiting
import { globalRateLimiter } from "./rate-limit.js";

// IP allowlist
import { createIpAllowlist } from "./ip-allowlist.js";

// Route modules
import { createCoreRoutes } from "./routes/core.js";
import { createChatRoutes } from "./routes/chat.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createUserSettingsRoutes } from "./routes/user-settings.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createCatalogRoutes } from "./routes/catalog.js";
import { createDiagnosticQueryRoutes } from "./routes/diagnostic-query.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createAdmiralRoutes } from "./routes/admiral.js";
import { createTargetRoutes } from "./routes/targets.js";
import { createCrewRoutes } from "./routes/crews.js";
import { createReceiptRoutes } from "./routes/receipts.js";
import { createImportRoutes } from "./routes/imports.js";
import { createProposalRoutes } from "./routes/proposals.js";
import { createEventRoutes } from "./routes/events.js";
import { createTranslatorRoutes } from "./routes/translator.js";
import { createEffectsRoutes } from "./routes/effects.js";
import { createScanRoutes } from "./routes/scan.js";

// Re-export for test compatibility
export type { AppState };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Static file paths ──────────────────────────────────────────
// Landing page (landing.html/css/js) — unauthenticated users see this.
const landingDir = path.resolve(
  __dirname,
  bootstrapConfigSync().nodeEnv === "production" ? "../../dist/landing" : "../../src/landing",
);

// Authenticated SPA served at /app — always Svelte (ADR-031 Phase 8 cutover).
// Dev: run `npm run dev:web` (Vite at :5173) for hot-reload, or use the prod build.
const appDir = path.resolve(__dirname, "../../dist/web");

// ─── Module-level state ─────────────────────────────────────────
const state: AppState = {
  adminPool: null,
  pool: null,
  geminiEngine: null,
  memoryService: null,
  frameStoreFactory: null,
  settingsStore: null,
  sessionStore: null,
  crewStore: null,
  crewStoreFactory: null,
  receiptStore: null,
  receiptStoreFactory: null,
  behaviorStore: null,
  referenceStore: null,
  overlayStore: null,
  overlayStoreFactory: null,
  inviteStore: null,
  userStore: null,
  targetStore: null,
  targetStoreFactory: null,
  auditStore: null,
  userSettingsStore: null,
  researchStore: null,
  researchStoreFactory: null,
  inventoryStore: null,
  inventoryStoreFactory: null,
  proposalStore: null,
  proposalStoreFactory: null,
  operationEventStore: null,
  operationEventStoreFactory: null,
  chatRunStore: null,
  toolContextFactory: null,
  effectStore: null,
  startupComplete: false,
  config: bootstrapConfigSync(), // Initialize with bootstrap config
};

let httpServer: HttpServer | null = null;
let sessionGcTimer: ReturnType<typeof setInterval> | null = null;

// ─── App Factory ────────────────────────────────────────────────
export function createApp(appState: AppState): express.Express {
  const app = express();

  // Trust exactly one proxy hop (Cloud Run's Google Frontend).
  // W16: For multi-proxy deployments (e.g., Cloud Armor + LB + Cloud Run),
  // increase this to the number of trusted hops so req.ip returns the real client IP.
  // Using 1 instead of true avoids ERR_ERL_PERMISSIVE_TRUST_PROXY.
  app.set("trust proxy", 1);
  
  // AX-First response envelope (ADR-004) — requestId + timing on every request
  // MUST come before body parser so request ID is available for all errors
  app.use(envelopeMiddleware);

  // IP allowlist — blocks non-allowlisted IPs before any processing.
  // Empty list (no MAJEL_ALLOWED_IPS) = no restriction (local dev).
  app.use(createIpAllowlist(appState.config.allowedIps));

  // Body parser with size limit (ADR-005 Phase 4)
  // Skip /api/chat — it has its own 10MB parser for base64 image payloads (ADR-008)
  app.use((req, res, next) => {
    if (req.path === "/api/chat") return next();
    express.json({ limit: "100kb" })(req, res, next);
  });

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
            url.startsWith("/app/assets") ||
            url.startsWith("/favicon")
          );
        },
      },
    }),
  );

  // ─── Security headers (ADR-023 Phase 0) ───────────────────
  // Content-Security-Policy — locks down resource loading.
  // One inline <style> in index.html powers the pre-boot splash (keyframes + body bg).
  // JS `.style.*` (CSSOM) is not affected by style-src.
  // img-src/connect-src 'self' blocks CSS-based data exfiltration vectors.
  // Svelte/Vite produces external bundles only — no inline scripts needed.
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'sha256-0s9Rz4xVEaqtQ5PaZpBVT4QtAHAh+NgR3Pet+fGZCvA='",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join('; '));
    // Defense-in-depth headers (no Helmet — we set them explicitly)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS: 1 year, include subdomains. Cloud Run terminates TLS, but HSTS
    // ensures browsers always upgrade to HTTPS on return visits.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // CSRF protection — require custom header on state-changing requests.
  // X-Requested-With cannot be set cross-origin without CORS preflight.
  // Combined with sameSite: strict cookies, this is defense-in-depth.
  app.use('/api', globalRateLimiter);
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers['x-requested-with'] !== 'majel-client') {
      return sendFail(res, ErrorCode.FORBIDDEN, 'Missing CSRF header', 403);
    }
    next();
  });

  // Static files (for /app/* — the authenticated Svelte SPA)
  // Always serves from dist/web/ (ADR-031 Phase 8 cutover).
  // Dev: use `npm run dev:web` (Vite at :5173) for hot-reload.
  // Cache headers: 1 day browser cache, etag for conditional revalidation (ADR-023)
  app.use("/app", express.static(appDir, {
    maxAge: '1d',
    etag: true,
  }));

  // Favicon pack (served from project root /favicon/)
  const faviconDir = path.resolve(__dirname, "../../favicon");
  app.use(express.static(faviconDir, {
    maxAge: '7d',
    etag: true,
  }));

  // ─── Landing page routes (ADR-019 Phase 1) ────────────────
  const landingFile = path.join(landingDir, "landing.html");

  // Landing page static assets (landing.css, landing.js)
  app.get('/landing.css', (_req, res) => res.sendFile(path.join(landingDir, 'landing.css')));
  app.get('/landing.js', (_req, res) => res.sendFile(path.join(landingDir, 'landing.js')));

  // Public landing page routes → landing.html
  // If the user already has a session cookie, skip the landing page entirely (no auth flash).
  for (const route of ["/", "/login", "/signup", "/verify", "/reset-password"]) {
    app.get(route, (req, res) => {
      if (req.cookies?.majel_session) {
        return res.redirect(302, "/app/");
      }
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
  app.use(createUserSettingsRoutes(appState));
  app.use(createSessionRoutes(appState));
  app.use(createCatalogRoutes(appState));
  app.use(createEffectsRoutes(appState));
  app.use(createDiagnosticQueryRoutes(appState));
  app.use(createTargetRoutes(appState));
  app.use(createCrewRoutes(appState));
  app.use(createReceiptRoutes(appState));
  app.use(createImportRoutes(appState));
  app.use(createProposalRoutes(appState));
  app.use(createEventRoutes(appState));
  app.use(createTranslatorRoutes(appState));
  app.use(createScanRoutes(appState));

  // ─── SPA Fallback (authenticated app) ─────────────────────
  app.get("/app/{*splat}", (_req, res) => {
    res.sendFile(path.join(appDir, "index.html"));
  });

  // ─── Error handler (ADR-004 — catch-all → envelope) ──────
  app.use(errorHandler);

  return app;
}

// ─── Startup ────────────────────────────────────────────────────
async function boot(): Promise<void> {
  const bootStart = Date.now();
  log.boot.info("Majel initializing");

  // ─── Stage 0: Foundation (serial) ─────────────────────────
  // Must be serial — each step requires the previous result.
  // adminPool and pool are captured as locals and closed over by later stages.
  let adminPool: ReturnType<typeof createPool>;
  let pool: ReturnType<typeof createPool>;

  await runStage("foundation", [
    {
      name: "admin-pool",
      fn: async () => {
        adminPool = createPool(state.config.databaseAdminUrl);
        state.adminPool = adminPool;
        log.boot.info({ url: state.config.databaseAdminUrl.replace(/\/\/.*@/, "//<redacted>@") }, "admin pool created (DDL)");
      },
    },
    {
      name: "ensure-role",
      fn: async () => {
        await ensureAppRole(adminPool);
        log.boot.info("majel_app role ready");
      },
    },
    {
      name: "settings-store",
      fn: async () => {
        state.settingsStore = await createSettingsStore(adminPool);
        log.boot.info("settings store online");
      },
    },
    {
      name: "resolve-config",
      fn: async () => {
        state.config = await resolveConfig(state.settingsStore!);
      },
    },
    {
      name: "app-pool",
      fn: async () => {
        pool = createPool(state.config.databaseUrl);
        state.pool = pool;
        log.boot.info({ url: state.config.databaseUrl.replace(/\/\/.*@/, "//<redacted>@") }, "app pool created (RLS enforced)");
      },
    },
    {
      name: "grants",
      fn: async () => {
        try {
          await adminPool.query(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO majel_app",
          );
        } catch { /* ignore — role may not exist in test environments */ }
      },
    },
    {
      name: "settings-rebind",
      fn: async () => {
        if (state.settingsStore) {
          state.settingsStore = await createSettingsStore(adminPool, pool);
          log.boot.debug("settings store re-bound to app pool");
        }
      },
    },
  ], log.boot, { concurrency: 1 });

  // ─── Stage 1: Reference + Independent Services (concurrency: 4) ──
  // ADR-047 D2: Stage 1 members have no FK deps on game-domain stores.
  // reference-store + cdn-sync chained as single task (local dependency).
  let resourceDefs: Map<number, ResourceDef>;

  // ADR-047 Phase C: reference-store + cdn-sync chained (local dependency),
  // remaining tasks run in parallel with bounded concurrency.
  await runStage("reference", [
    {
      name: "reference-store+cdn-sync",
      fn: async () => {
        state.referenceStore = await createReferenceStore(adminPool, pool);
        const purged = await state.referenceStore.purgeLegacyEntries();
        const refCounts = await state.referenceStore.counts();
        log.boot.info({
          officers: refCounts.officers, ships: refCounts.ships,
          research: refCounts.research, buildings: refCounts.buildings,
          hostiles: refCounts.hostiles, consumables: refCounts.consumables,
          systems: refCounts.systems,
          purgedShips: purged.ships, purgedOfficers: purged.officers,
        }, "reference store online");

        // CDN sync (chained — depends on referenceStore being ready)
        const needsSync = refCounts.officers === 0 || refCounts.ships === 0 ||
          refCounts.research === 0 || refCounts.buildings === 0 ||
          refCounts.hostiles === 0 || refCounts.consumables === 0 ||
          refCounts.systems === 0;
        if (!needsSync) return;
        log.boot.info("empty reference tables detected — running CDN snapshot sync");
        const syncResults = await Promise.allSettled([
          refCounts.officers === 0 ? syncCdnOfficers(state.referenceStore) : null,
          refCounts.ships === 0 ? syncCdnShips(state.referenceStore) : null,
          refCounts.research === 0 ? syncCdnResearch(state.referenceStore) : null,
          refCounts.buildings === 0 ? syncCdnBuildings(state.referenceStore) : null,
          refCounts.hostiles === 0 ? syncCdnHostiles(state.referenceStore) : null,
          refCounts.consumables === 0 ? syncCdnConsumables(state.referenceStore) : null,
          refCounts.systems === 0 ? syncCdnSystems(state.referenceStore) : null,
        ].filter(Boolean) as Promise<unknown>[]);
        const failed = syncResults.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          for (const f of failed) {
            log.boot.error({ err: (f as PromiseRejectedResult).reason }, "CDN sync failed for one entity type");
          }
        }
        const postSyncCounts = await state.referenceStore.counts();
        log.boot.info(postSyncCounts, "CDN snapshot sync complete");
      },
    },
    {
      name: "frame-store-factory",
      fn: async () => {
        if (adminPool) {
          const factory = await createFrameStoreFactory(adminPool, pool);
          state.frameStoreFactory = factory;
          state.memoryService = createMemoryService(factory.forUser("system"));
          log.boot.info("lex memory service online (postgres + RLS)");
        } else {
          state.memoryService = createMemoryService();
          log.boot.info("lex memory service online (sqlite fallback)");
        }
      },
    },
    {
      name: "session-store",
      fn: async () => {
        state.sessionStore = await createSessionStore(adminPool, pool);
        log.boot.info({ sessions: await state.sessionStore.count() }, "session store online");
      },
    },
    {
      name: "resource-defs",
      fn: async () => {
        const snapshotDir = path.join(__dirname, "../../data/.stfc-snapshot");
        resourceDefs = loadResourceDefs(snapshotDir);
        log.boot.info({ count: resourceDefs.size }, "resource definitions loaded");
      },
    },
  ], log.boot, { concurrency: 4 });

  // ─── Stage 2: Game-Domain + Platform Stores ────────────────────────────
  // ADR-047 Phase C: bounded concurrency (4). effect-store + effect-seed
  // chained as single task (local dependency).
  await runStage("stores", [
    // Gameplay/Reference-adjacent domain
    {
      name: "crew-store-factory",
      fn: async () => {
        state.crewStoreFactory = await createCrewStoreFactory(adminPool, pool);
        state.crewStore = state.crewStoreFactory.forUser("local");
        log.boot.info("crew store online (ADR-025, user-scoped)");
      },
    },
    {
      name: "receipt-store-factory",
      fn: async () => {
        state.receiptStoreFactory = await createReceiptStoreFactory(adminPool, pool);
        state.receiptStore = state.receiptStoreFactory.forUser("local");
        const receiptCounts = await state.receiptStore.counts();
        log.boot.info({ receipts: receiptCounts.total }, "receipt store online (ADR-026, user-scoped)");
      },
    },
    {
      name: "behavior-store",
      fn: async () => {
        state.behaviorStore = await createBehaviorStore(adminPool, pool);
        const behaviorCounts = await state.behaviorStore.counts();
        log.boot.info({ rules: behaviorCounts.total, active: behaviorCounts.active }, "behavior store online");
      },
    },
    {
      name: "overlay-store-factory",
      fn: async () => {
        const overlayFactory = await createOverlayStoreFactory(adminPool, pool);
        state.overlayStoreFactory = overlayFactory;
        state.overlayStore = overlayFactory.forUser("local");
        const overlayCounts = await state.overlayStore.counts();
        log.boot.info({
          officerOverlays: overlayCounts.officers.total,
          shipOverlays: overlayCounts.ships.total,
        }, "overlay store online (RLS-scoped)");
      },
    },
    {
      name: "target-store-factory",
      fn: async () => {
        const targetFactory = await createTargetStoreFactory(adminPool, pool);
        state.targetStoreFactory = targetFactory;
        state.targetStore = targetFactory.forUser("local");
        const targetCounts = await state.targetStore.counts();
        log.boot.info({ targets: targetCounts.total, active: targetCounts.active }, "target store online (RLS-scoped)");
      },
    },
    {
      name: "research-store-factory",
      fn: async () => {
        const researchFactory = await createResearchStoreFactory(adminPool, pool);
        state.researchStoreFactory = researchFactory;
        state.researchStore = researchFactory.forUser("local");
        const researchCounts = await state.researchStore.counts();
        log.boot.info({ nodes: researchCounts.nodes, trees: researchCounts.trees }, "research store online (RLS-scoped)");
      },
    },
    {
      name: "inventory-store-factory",
      fn: async () => {
        const inventoryFactory = await createInventoryStoreFactory(adminPool, pool);
        state.inventoryStoreFactory = inventoryFactory;
        state.inventoryStore = inventoryFactory.forUser("local");
        const inventoryCounts = await state.inventoryStore.counts();
        log.boot.info({ items: inventoryCounts.items, categories: inventoryCounts.categories }, "inventory store online (RLS-scoped)");
      },
    },
    {
      name: "proposal-store-factory",
      fn: async () => {
        const proposalFactory = await createProposalStoreFactory(adminPool, pool);
        state.proposalStoreFactory = proposalFactory;
        state.proposalStore = proposalFactory.forUser("local");
        const proposalCounts = await state.proposalStore.counts();
        log.boot.info({ proposals: proposalCounts.total }, "proposal store online (ADR-026b, user-scoped)");
      },
    },
    {
      name: "operation-event-store",
      fn: async () => {
        const eventFactory = await createOperationEventStoreFactory(adminPool, pool);
        state.operationEventStoreFactory = eventFactory;
        state.operationEventStore = eventFactory.forUser("local");
        log.boot.info("operation event store online (ADR-037, user-scoped)");
      },
    },
    // Effect store + seed chained (local dependency: seed awaits store)
    {
      name: "effect-store+seed",
      fn: async () => {
        state.effectStore = await createEffectStore(adminPool, pool);
        log.boot.info("effect store schema online (ADR-034)");
        await loadEffectSeedData(state.effectStore);
        const effectCounts = await state.effectStore.counts();
        log.boot.info({ effects: effectCounts.taxonomyEffectKeys, abilities: effectCounts.catalogAbilities, intents: effectCounts.intentDefs }, "effect seed data loaded (ADR-034)");
      },
    },
    // Auth/Platform domain
    {
      name: "invite-store",
      fn: async () => {
        state.inviteStore = await createInviteStore(adminPool, pool);
        const codes = await state.inviteStore.listCodes();
        log.boot.info({ codes: codes.length, authEnabled: state.config.authEnabled }, "invite store online");
      },
    },
    {
      name: "user-store",
      fn: async () => {
        state.userStore = await createUserStore(adminPool, pool);
        const userCount = await state.userStore.countUsers();
        log.boot.info({ users: userCount }, "user store online");
      },
    },
    {
      name: "audit-store",
      fn: async () => {
        state.auditStore = await createAuditStore(adminPool, pool);
        log.boot.info("audit store online");
      },
    },
    {
      name: "user-settings-store",
      fn: async () => {
        if (state.settingsStore) {
          state.userSettingsStore = await createUserSettingsStore(adminPool, pool, state.settingsStore);
          log.boot.info("user settings store online");
        }
      },
    },
    {
      name: "chat-run-store",
      fn: async () => {
        state.chatRunStore = await createChatRunStore(adminPool, pool);
        log.boot.info("chat run store online (ADR-036, durable queue)");
      },
    },
  ], log.boot, { concurrency: 4 });

  // ─── Stage 3: Engines (serial) ────────────────────────────
  // Engine construction references multiple stores via tool context factory.
  const { geminiApiKey, vertexProjectId, vertexRegion } = state.config;

  await runStage("engines", [
    {
      name: "engine-setup",
      fn: async () => {
        if (!geminiApiKey) {
          log.boot.warn("GEMINI_API_KEY not set — chat disabled");
          return;
        }

        const runner = await buildMicroRunnerFromState(state);
        const modelName = DEFAULT_MODEL;

        const toolContextFactory = (state.referenceStore || state.overlayStoreFactory || state.crewStoreFactory || state.targetStoreFactory || state.researchStoreFactory || state.inventoryStoreFactory || state.userSettingsStore) ? {
          forUser(userId: string) {
            return {
              userId,
              deps: {
                referenceStore: state.referenceStore,
                overlayStore: state.overlayStoreFactory?.forUser(userId) ?? null,
                crewStore: state.crewStoreFactory?.forUser(userId) ?? null,
                targetStore: state.targetStoreFactory?.forUser(userId) ?? null,
                receiptStore: state.receiptStoreFactory?.forUser(userId) ?? null,
                researchStore: state.researchStoreFactory?.forUser(userId) ?? null,
                inventoryStore: state.inventoryStoreFactory?.forUser(userId) ?? null,
                userSettingsStore: state.userSettingsStore,
                resourceDefs: resourceDefs!.size > 0 ? resourceDefs! : null,
              },
            };
          },
        } : null;

        state.toolContextFactory = toolContextFactory;

        const geminiEngine = createGeminiEngine(
          geminiApiKey,
          null,
          null,
          runner,
          modelName,
          toolContextFactory,
          state.proposalStoreFactory,
          state.userSettingsStore,
        );
        log.boot.info({ model: geminiEngine.getModel(), microRunner: !!runner }, "gemini engine online");

        let claudeEngine = null;
        if (vertexProjectId) {
          try {
            claudeEngine = createClaudeEngine(
              vertexProjectId,
              vertexRegion,
              null,
              null,
              runner,
              null,
              toolContextFactory,
              state.proposalStoreFactory,
              state.userSettingsStore,
            );
            log.boot.info({ projectId: vertexProjectId, region: vertexRegion }, "claude engine online");
          } catch (err) {
            log.boot.warn({ err: (err as Error).message }, "claude engine failed to initialize — Claude models unavailable");
          }
        }

        state.geminiEngine = createEngineManager({ geminiEngine, claudeEngine });
        log.boot.info({ model: state.geminiEngine.getModel(), claudeAvailable: !!claudeEngine }, "engine manager online");
      },
    },
  ], log.boot, { concurrency: 1 });

  // ─── Stage 4: Finalize ────────────────────────────────────
  state.startupComplete = true;

  if (!state.config.authEnabled) {
    log.boot.warn(
      "⚠️  AUTH DISABLED — all requests run as admiral. Set MAJEL_ADMIN_TOKEN to enable authentication.",
    );
  }

  if (state.adminPool) {
    await state.adminPool.end();
    log.boot.info("admin pool closed (DDL complete)");
    state.adminPool = null as unknown as typeof state.adminPool;
  }

  const app = createApp(state);
  httpServer = app.listen(state.config.port, () => {
    log.boot.info({ port: state.config.port, url: `http://localhost:${state.config.port}` }, "Majel online");
  });

  httpServer.on("error", (err) => {
    log.boot.fatal({ err: err.message }, "HTTP server error");
    process.exit(1);
  });

  // boot.total
  log.boot.info({ durationMs: Date.now() - bootStart }, "boot.total");

  // 5. Periodic session cleanup (every hour)
  // Removes expired auth sessions and stale tenant sessions from PostgreSQL.
  // These SQL queries already existed but were never called — wiring them now.
  const SESSION_GC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  sessionGcTimer = setInterval(async () => {
    try {
      let cleaned = 0;
      if (state.userStore) {
        cleaned += await state.userStore.cleanupExpiredSessions();
      }
      if (state.inviteStore) {
        cleaned += await state.inviteStore.cleanupExpiredSessions("30 days");
      }
      if (cleaned > 0) {
        log.boot.info({ cleaned }, "session:gc");
        state.auditStore?.logEvent({
          event: "auth.session.expired_cleanup",
          detail: { cleaned },
        });
      }
      // Purge unverified users older than 7 days
      if (state.userStore) {
        const purged = await state.userStore.cleanupUnverifiedUsers("7 days");
        if (purged.length > 0) {
          log.boot.info({ count: purged.length }, "unverified:gc");
          state.auditStore?.logEvent({
            event: "auth.unverified_cleanup",
            detail: { count: purged.length },
          });
        }
      }
      // Purge audit log entries older than 90 days (GDPR retention limit)
      if (state.auditStore) {
        const purged = await state.auditStore.purgeOlderThan("90 days");
        if (purged > 0) {
          log.boot.info({ purged }, "audit:gc");
        }
      }
      // Purge completed chat_runs older than 30 days
      if (state.adminPool) {
        try {
          const chatRes = await state.adminPool.query(
            `DELETE FROM public.chat_runs
             WHERE status IN ('succeeded','failed','cancelled','timed_out')
               AND finished_at < NOW() - INTERVAL '30 days'`,
          );
          if ((chatRes.rowCount ?? 0) > 0) {
            log.boot.info({ purged: chatRes.rowCount }, "chat_runs:gc");
          }
        } catch (err) {
          log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "chat_runs:gc:error");
        }
      }
      // Purge operation_events older than 30 days
      if (state.adminPool) {
        try {
          const opRes = await state.adminPool.query(
            `DELETE FROM operation_events WHERE created_at < NOW() - INTERVAL '30 days'`,
          );
          if ((opRes.rowCount ?? 0) > 0) {
            log.boot.info({ purged: opRes.rowCount }, "operation_events:gc");
          }
          const streamRes = await state.adminPool.query(
            `DELETE FROM operation_streams WHERE created_at < NOW() - INTERVAL '30 days'`,
          );
          if ((streamRes.rowCount ?? 0) > 0) {
            log.boot.info({ purged: streamRes.rowCount }, "operation_streams:gc");
          }
        } catch (err) {
          log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "operation_events:gc:error");
        }
      }
    } catch (err) {
      log.boot.warn({ err: err instanceof Error ? err.message : String(err) }, "session:gc:error");
    }
  }, SESSION_GC_INTERVAL_MS);
  sessionGcTimer.unref(); // Don't keep process alive for GC
}

// ─── Graceful Shutdown ──────────────────────────────────────────
async function shutdown(): Promise<void> {
  log.boot.info("Majel offline. Live long and prosper.");
  // Stop accepting new connections first
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  // Stop periodic GC
  if (sessionGcTimer) {
    clearInterval(sessionGcTimer);
    sessionGcTimer = null;
  }
  // Close Gemini engine (stops cleanup timer, frees session Maps)
  state.geminiEngine?.close();
  // Close all store handles (no-ops since pool is shared)
  state.settingsStore?.close();
  state.sessionStore?.close();
  state.crewStore?.close();
  state.receiptStore?.close();
  state.behaviorStore?.close();
  state.overlayStore?.close();
  state.inviteStore?.close();
  state.userStore?.close();
  state.targetStore?.close();
  state.referenceStore?.close();
  state.effectStore?.close();
  state.chatRunStore?.close();
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

process.on("unhandledRejection", (reason) => {
  log.boot.fatal({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandled rejection");
  shutdown();
});

// ─── Launch (guarded for test imports) ──────────────────────────
if (!bootstrapConfigSync().isTest) {
  boot().catch((err) => {
    log.boot.fatal({ err: err instanceof Error ? err.message : String(err) }, "fatal startup error");
    process.exit(1);
  });
}
