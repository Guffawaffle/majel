/**
 * routes/chat.ts — Chat, history, and memory recall routes.
 */

import { Router } from "express";
import type { AppState } from "../app-context.js";
import { log } from "../logger.js";

export function createChatRoutes(appState: AppState): Router {
  const router = Router();

  // ─── Chat ───────────────────────────────────────────────────

  router.post("/api/chat", async (req, res) => {
    const { message } = req.body;
    const sessionId = (req.headers["x-session-id"] as string) || "default";

    if (!message || typeof message !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'message' in request body" });
    }

    if (!appState.geminiEngine) {
      return res.status(503).json({
        error: "Gemini not ready. Check /api/health for status.",
      });
    }

    try {
      const answer = await appState.geminiEngine.chat(message, sessionId);

      // Persist to Lex memory (fire-and-forget, don't block the response)
      if (appState.memoryService) {
        appState.memoryService
          .remember({ question: message, answer })
          .catch((err) => {
            log.lex.warn({ err: err instanceof Error ? err.message : String(err) }, "memory save failed");
          });
      }

      // Persist both messages to session store
      if (appState.sessionStore) {
        appState.sessionStore.addMessage(sessionId, "user", message);
        appState.sessionStore.addMessage(sessionId, "model", answer);
      }

      res.json({ answer });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ err: errMessage }, "chat request failed");
      res.status(500).json({ error: errMessage });
    }
  });

  // ─── History ────────────────────────────────────────────────

  router.get("/api/history", async (req, res) => {
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

    if (
      (source === "lex" || source === "both") &&
      appState.memoryService
    ) {
      try {
        const frames = await appState.memoryService.timeline(limit);
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

    res.json(result);
  });

  // ─── Recall ─────────────────────────────────────────────────

  router.get("/api/recall", async (req, res) => {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }

    if (!appState.memoryService) {
      return res.status(503).json({ error: "Memory service not available" });
    }

    try {
      const limit = parseInt((req.query.limit as string) || "10", 10);
      const frames = await appState.memoryService.recall(query, limit);
      res.json({
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
      res.status(500).json({ error: message });
    }
  });

  return router;
}
