/**
 * routes/chat.ts — Chat, history, and memory recall routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, sendFail, ErrorCode, createTimeoutMiddleware } from "../envelope.js";
import { requireAdmiral, requireVisitor } from "../auth.js";
import { attachScopedMemory } from "../memory-middleware.js";
import { MODEL_REGISTRY, getModelDef, resolveModelId } from "../gemini.js";

export function createChatRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Chat ───────────────────────────────────────────────────

  router.post("/api/chat", requireAdmiral(appState), attachScopedMemory(appState), createTimeoutMiddleware(30000), async (req, res) => {
    const { message } = req.body;
    const sessionId = (req.headers["x-session-id"] as string) || "default";

    if (!message || typeof message !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'message' in request body", 400, {
        hints: ["Send JSON body: { \"message\": \"your question\" }"],
      });
    }

    if (!appState.geminiEngine) {
      return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini not ready", 503, {
        detail: { reason: appState.startupComplete ? "no API key configured" : "initializing" },
        hints: ["Check /api/health for status", "If initializing, retry in 2-3 seconds"],
      });
    }

    try {
      const answer = await appState.geminiEngine.chat(message, sessionId);

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
        await appState.sessionStore.addMessage(sessionId, "user", message);
        await appState.sessionStore.addMessage(sessionId, "model", answer);
      }

      sendOk(res, { answer });
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
      result.session = appState.geminiEngine?.getHistory(sessionId) || [];
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
      const message = err instanceof Error ? err.message : String(err);
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
    const current = appState.geminiEngine?.getModel() ?? "unknown";

    sendOk(res, {
      current,
      defaultModel: MODEL_REGISTRY[0].id,
      currentDef: getModelDef(current),
      models: MODEL_REGISTRY.map((m) => ({
        ...m,
        active: m.id === current,
      })),
    });
  });

  /**
   * POST /api/models/select — Switch the active model (Admiral only).
   *
   * Body: { "model": "gemini-2.5-pro" }
   *
   * This hot-swaps the model without restarting the server.
   * All chat sessions are cleared (new model = fresh context).
   * The selection is persisted to settings so it survives restarts.
   */
  router.post("/api/models/select", requireAdmiral(appState), async (req, res) => {
    const { model: requestedModel } = req.body;

    if (!requestedModel || typeof requestedModel !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'model' in request body", 400, {
        hints: ["Send JSON body: { \"model\": \"<model-id>\" }", `Valid IDs: ${MODEL_REGISTRY.map(m => m.id).join(", ")}`],
      });
    }

    if (!appState.geminiEngine) {
      return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini not ready", 503, {
        hints: ["Check /api/health for status"],
      });
    }

    const modelDef = getModelDef(requestedModel);
    if (!modelDef) {
      return sendFail(res, ErrorCode.INVALID_PARAM, `Unknown model: ${requestedModel}`, 400, {
        detail: { validModels: MODEL_REGISTRY.map(m => m.id) },
        hints: [`Valid models: ${MODEL_REGISTRY.map(m => m.id).join(", ")}`, "Use GET /api/models for full metadata"],
      });
    }

    const previousModel = appState.geminiEngine.getModel();
    appState.geminiEngine.setModel(requestedModel);

    // Persist to settings store so it survives restarts
    if (appState.settingsStore) {
      try {
        await appState.settingsStore.set("model.name", requestedModel);
      } catch (err) {
        log.settings.warn({ err: err instanceof Error ? err.message : String(err) }, "failed to persist model selection");
      }
    }

    log.gemini.info({ previousModel, newModel: requestedModel, tier: modelDef.tier }, "model:select");

    sendOk(res, {
      previousModel,
      currentModel: requestedModel,
      modelDef,
      sessionsCleared: true,
      hints: modelDef.thinking
        ? ["Thinking model active — responses may take longer but will be more reasoned."]
        : ["Standard model active — fastest responses."],
    });
  });

  return router;
}
