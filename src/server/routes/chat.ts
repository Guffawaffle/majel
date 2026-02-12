/**
 * routes/chat.ts — Chat, history, and memory recall routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";
import { sendOk, sendFail, ErrorCode, createTimeoutMiddleware } from "../envelope.js";
import { requireAdmiral, requireVisitor } from "../auth.js";

export function createChatRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Chat ───────────────────────────────────────────────────

  router.post("/api/chat", requireAdmiral(appState), createTimeoutMiddleware(30000), async (req, res) => {
    const { message } = req.body;
    const sessionId = (req.headers["x-session-id"] as string) || "default";

    if (!message || typeof message !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'message' in request body");
    }

    if (!appState.geminiEngine) {
      return sendFail(res, ErrorCode.GEMINI_NOT_READY, "Gemini not ready. Check /api/health for status.", 503);
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
            log.lex.warn({ err: err instanceof Error ? err.message : String(err) }, "memory save failed");
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
      sendFail(res, ErrorCode.GEMINI_ERROR, errMessage, 500);
    }
  });

  // ─── History ────────────────────────────────────────────────

  router.get("/api/history", requireVisitor(appState), async (req, res) => {
    const source = (req.query.source as string) || "both";
    const limit = parseInt((req.query.limit as string) || "20", 10);

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

  router.get("/api/recall", requireVisitor(appState), async (req, res) => {
    const query = req.query.q as string;

    if (!query) {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing query parameter 'q'");
    }

    const memory = res.locals.memory ?? appState.memoryService;
    if (!memory) {
      return sendFail(res, ErrorCode.MEMORY_NOT_AVAILABLE, "Memory service not available", 503);
    }

    try {
      const limit = parseInt((req.query.limit as string) || "10", 10);
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
      sendFail(res, ErrorCode.MEMORY_ERROR, message, 500);
    }
  });

  return router;
}
