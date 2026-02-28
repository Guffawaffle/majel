/**
 * routes/chat.ts — Chat, history, and memory recall routes.
 */

import express, { type Router } from "express";
import type { AppState } from "../app-context.js";
import {
  readFleetConfigForUser,
  formatFleetConfigBlock,
  readIntentConfigForUser,
  formatIntentConfigBlock,
} from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, sendFail, ErrorCode, createTimeoutMiddleware } from "../envelope.js";
import { createSafeRouter } from "../safe-router.js";
import { requireAdmiral, requireVisitor } from "../services/auth.js";
import { chatRateLimiter } from "../rate-limit.js";
import { attachScopedMemory } from "../services/memory-middleware.js";
import { MODEL_REGISTRY, getModelDef, DEFAULT_MODEL } from "../services/gemini/index.js";
import type { ImagePart } from "../services/gemini/index.js";

/** Allowed image MIME types for multimodal chat (ADR-008) */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Max base64 image data size: ~10MB base64 ≈ ~7.5MB raw image */
const MAX_IMAGE_DATA_LENGTH = 10 * 1024 * 1024;
const LOCKED_MODEL_ID = DEFAULT_MODEL;

export function createChatRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  // ─── Chat ───────────────────────────────────────────────────

  // Route-specific body limit: 10MB to accommodate base64 image payloads (ADR-008)
  const chatBodyParser = express.json({ limit: '10mb' });

  router.post("/api/chat", chatBodyParser, requireVisitor(appState), chatRateLimiter, attachScopedMemory(appState), createTimeoutMiddleware(60_000), async (req, res) => {
    const { message, image: rawImage } = req.body;
    const sessionId = (req.headers["x-session-id"] as string) || "default";

    if (sessionId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid session ID", 400);
    }

    if (!message || typeof message !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'message' in request body", 400, {
        hints: ["Send JSON body: { \"message\": \"your question\" }"],
      });
    }
    if (message.length > 10000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Message must be 10,000 characters or fewer", 400);
    }

    // ── Image validation (ADR-008 Phase A) ────────────────
    let imagePart: ImagePart | undefined;
    if (rawImage) {
      if (typeof rawImage !== "object" || !rawImage.data || !rawImage.mimeType) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Image must have 'data' (base64) and 'mimeType' fields", 400);
      }
      if (!ALLOWED_IMAGE_TYPES.has(rawImage.mimeType)) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Unsupported image type: ${rawImage.mimeType}. Allowed: ${[...ALLOWED_IMAGE_TYPES].join(", ")}`, 400);
      }
      if (typeof rawImage.data !== "string" || rawImage.data.length > MAX_IMAGE_DATA_LENGTH) {
        return sendFail(res, ErrorCode.INVALID_PARAM, `Image data must be a base64 string under ${Math.round(MAX_IMAGE_DATA_LENGTH / 1024 / 1024)}MB`, 400);
      }
      imagePart = { inlineData: { data: rawImage.data, mimeType: rawImage.mimeType } };
    }

    if (!appState.geminiEngine) {
      return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini not ready", 503, {
        detail: { reason: appState.startupComplete ? "no API key configured" : "initializing" },
        hints: ["Check /api/health for status", "If initializing, retry in 2-3 seconds"],
      });
    }

    try {
      const userId = res.locals.userId as string | undefined;

      // #85 H3: Inject per-user fleet config as a context block prepended to the message.
      // This replaces the static fleet config that was baked into the system prompt at boot.
      let chatMessage = message;
      if (userId && appState.userSettingsStore) {
        try {
          const [fleetConfig, intentConfig] = await Promise.all([
            readFleetConfigForUser(appState.userSettingsStore, userId),
            readIntentConfigForUser(appState.userSettingsStore, userId),
          ]);

          const contextBlocks: string[] = [];
          if (intentConfig) contextBlocks.push(formatIntentConfigBlock(intentConfig));
          if (fleetConfig) contextBlocks.push(formatFleetConfigBlock(fleetConfig));
          if (contextBlocks.length > 0) {
            chatMessage = `${contextBlocks.join("\n\n")}\n\n${message}`;
          }
        } catch (err) {
          // Non-fatal: proceed without per-user context rather than blocking the chat
          log.settings.warn({ err: err instanceof Error ? err.message : String(err), userId }, "failed to read per-user chat context");
        }
      }

      const result = await appState.geminiEngine.chat(chatMessage, sessionId, imagePart, userId);
      const answer = typeof result === "string" ? result : result.text;
      const proposals = typeof result === "string" ? undefined : result.proposals;

      // Persist to Lex memory — user-scoped via RLS (ADR-021 D4)
      // Falls back to appState.memoryService if middleware didn't attach
      const memory = res.locals.memory ?? appState.memoryService;
      if (memory) {
        memory
          .remember({ question: message, answer })
          .catch((err) => {
            // M6: Log at error level with context — silent data loss is tracked
            log.lex.error({ err: err instanceof Error ? err.message : String(err), sessionId }, "memory save failed — conversation not persisted to Lex");
          });
      }

      // Persist both messages to session store
      if (appState.sessionStore) {
        const userId = res.locals.userId as string | undefined;
        await appState.sessionStore.addMessage(sessionId, "user", message, userId);
        await appState.sessionStore.addMessage(sessionId, "model", answer);
      }

      sendOk(res, {
        answer,
        proposals: proposals && proposals.length > 0 ? proposals : undefined,
      });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ err: errMessage }, "chat request failed");
      sendFail(res, ErrorCode.GEMINI_ERROR, "AI request failed", 500, {
        hints: ["Try again in a few seconds", "If the problem persists, check /api/health"],
      });
    }
  });

  // ─── History ────────────────────────────────────────────────

  router.get("/api/history", requireVisitor(appState), attachScopedMemory(appState), async (req, res) => {
    const source = (req.query.source as string) || "both";
    // I4: Clamp limit to 1-100 to prevent excessive memory queries
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10) || 20, 1), 100);

    const result: {
      session?: Array<{ role: string; text: string }>;
      lex?: Array<{ id: string; timestamp: string; summary: string }>;
    } = {};

    if (source === "session" || source === "both") {
      const sessionId = (req.query.sessionId as string) || "default";
      if (sessionId.length > 200) {
        return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid session ID", 400);
      }
      // #85 H2: Namespace session key by userId (engine stores under userId:sessionId)
      const userId = res.locals.userId as string | undefined;
      const sessionKey = userId ? `${userId}:${sessionId}` : sessionId;
      result.session = appState.geminiEngine?.getHistory(sessionKey) || [];
    }

    const memory = res.locals.memory ?? appState.memoryService;
    if (
      (source === "lex" || source === "both") &&
      memory
    ) {
      try {
        const frames = await memory.timeline(limit);
        result.lex = frames.map((f) => ({
          id: f.id,
          timestamp: f.timestamp,
          summary: f.summary_caption,
        }));
      } catch (err) {
        log.lex.warn({ err: err instanceof Error ? err.message : String(err) }, "timeline error");
        result.lex = [];
      }
    }

    sendOk(res, result);
  });

  // ─── Recall ─────────────────────────────────────────────────

  router.get("/api/recall", requireVisitor(appState), attachScopedMemory(appState), async (req, res) => {
    const query = req.query.q as string;

    if (!query) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing query parameter 'q'", 400, {
        hints: ["Example: GET /api/recall?q=warp+drive&limit=10"],
      });
    }
    if (query.length > 1000) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Query must be 1000 characters or fewer", 400);
    }

    const memory = res.locals.memory ?? appState.memoryService;
    if (!memory) {
      return sendFail(res, ErrorCode.MEMORY_NOT_AVAILABLE, "Memory service not available", 503, {
        hints: ["Lex memory is not configured", "Check /api/health for subsystem status"],
      });
    }

    try {
      const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "10", 10) || 10, 1), 100);
      const frames = await memory.recall(query, limit);
      sendOk(res, {
        query,
        results: frames.map((f) => ({
          id: f.id,
          timestamp: f.timestamp,
          summary: f.summary_caption,
          reference: f.reference_point,
          keywords: f.keywords,
        })),
      });
    } catch (err: unknown) {
      const _message = err instanceof Error ? err.message : String(err);
      sendFail(res, ErrorCode.MEMORY_ERROR, "Memory recall failed", 500, {
        hints: ["Try again or check /api/health for subsystem status"],
      });
    }
  });

  // ─── Model Selector ────────────────────────────────────────

  /**
   * GET /api/models — List available models with metadata.
   * Returns the full registry + which model is currently active.
   */
  router.get("/api/models", requireAdmiral(appState), async (_req, res) => {
    const current = LOCKED_MODEL_ID;
    const lockedDef = getModelDef(LOCKED_MODEL_ID);

    sendOk(res, {
      current,
      defaultModel: LOCKED_MODEL_ID,
      currentDef: lockedDef,
      locked: true,
      models: MODEL_REGISTRY
        .filter((m) => m.id === LOCKED_MODEL_ID)
        .map((m) => ({
          ...m,
          active: true,
        })),
    });
  });

  /**
   * POST /api/models/select — disabled while model is pinned.
   */
  router.post("/api/models/select", requireAdmiral(appState), async (_req, res) => {
    return sendFail(res, ErrorCode.INSUFFICIENT_RANK, `Model selection is disabled. Locked model: ${LOCKED_MODEL_ID}`, 403, {
      detail: { requiredRole: "admiral", lockedModel: LOCKED_MODEL_ID },
      hints: ["Model is pinned for reliability and consistency"],
    });
  });

  return router;
}
