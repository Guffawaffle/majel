/**
 * routes/events.ts — ADR-037 realtime operation event streaming routes.
 */

import type { Router } from "express";
import { createSafeRouter } from "../safe-router.js";
import { sendFail, sendOk, ErrorCode } from "../envelope.js";
import { requireVisitor } from "../services/auth.js";
import type { AppState } from "../app-context.js";
import { createContextMiddleware } from "../context-middleware.js";
import { log } from "../logger.js";

const TOPIC_RE = /^[a-z0-9_]{2,40}$/i;
const OP_ID_RE = /^[a-zA-Z0-9._:-]{2,120}$/;
const ALLOWED_TOPICS = new Set(["chat_run", "runner_job"]);
const POLL_MS = 1000;
const KEEPALIVE_MS = 15000;
const SSE_EVENT_RE = /^[a-zA-Z0-9_.:-]{1,80}$/;

function parseTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!TOPIC_RE.test(trimmed)) return null;
  return ALLOWED_TOPICS.has(trimmed) ? trimmed : null;
}

function parseOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return OP_ID_RE.test(trimmed) ? trimmed : null;
}

function parseLastEventId(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return 0;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseReplayCursor(headerValue: unknown, queryValue: unknown): number {
  const fromHeader = parseLastEventId(headerValue);
  if (fromHeader > 0) return fromHeader;
  return parseLastEventId(queryValue);
}

export function createEventRoutes(appState: AppState): Router {
  const router = createSafeRouter();
  const visitor = requireVisitor(appState);
  router.use("/api/events", visitor);
  if (appState.pool) {
    router.use("/api/events", createContextMiddleware(appState.pool));
  }

  router.get("/api/events/snapshot", async (req, res) => {
    if (!appState.operationEventStoreFactory) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Event stream not available", 503, {
        hints: ["Retry in a few seconds"],
      });
    }

    const topic = parseTopic(req.query.topic);
    const operationId = parseOperationId(req.query.id);
    if (!topic || !operationId) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid topic or id", 400);
    }

    const userId = res.locals.userId as string | undefined;
    if (!userId) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const store = appState.operationEventStoreFactory.forUser(userId);
    const routing = await store.getRouting(topic, operationId);
    if (!routing) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Operation not found", 404);
    }

    const latest = await store.latest(topic, operationId);

    sendOk(res, {
      topic,
      id: operationId,
      sessionId: routing.sessionId,
      tabId: routing.tabId,
      latest,
    });
  });

  router.get("/api/events/stream", async (req, res) => {
    if (!appState.operationEventStoreFactory) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Event stream not available", 503, {
        hints: ["Retry in a few seconds"],
      });
    }

    const topic = parseTopic(req.query.topic);
    const operationId = parseOperationId(req.query.id);
    if (!topic || !operationId) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid topic or id", 400);
    }

    const userId = res.locals.ctx?.identity.userId ?? (res.locals.userId as string | undefined);
    if (!userId) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const store = appState.operationEventStoreFactory.forUser(userId);
    const routing = await store.getRouting(topic, operationId);
    if (!routing) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Operation not found", 404);
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let cursor = parseReplayCursor(req.header("Last-Event-ID"), req.query.lastEventId);
    let closed = false;
    let inFlight = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      try {
        res.end();
      } catch {
        // socket already closed
      }
    };

    const writeSse = (event: string, data: Record<string, unknown>, id?: number): void => {
      if (closed) return;
      const safeEvent = SSE_EVENT_RE.test(event) ? event : "run.message";
      try {
        if (id != null) res.write(`id: ${id}\n`);
        res.write(`event: ${safeEvent}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log.http.warn({ err: errMessage, topic, operationId, userId }, "event stream write failed");
        cleanup();
      }
    };

    const flushReplay = async (): Promise<void> => {
      const replay = await store.listSince(topic, operationId, cursor, 200);
      for (const evt of replay) {
        cursor = evt.seq;
        writeSse(evt.eventType, {
          topic: evt.topic,
          id: evt.operationId,
          sessionId: evt.sessionId,
          tabId: evt.tabId,
          status: evt.status,
          payload: evt.payloadJson,
          timestamp: evt.createdAt,
        }, evt.seq);
      }
    };

    await flushReplay();

    pollTimer = setInterval(async () => {
      if (closed || inFlight) return;
      inFlight = true;
      try {
        await flushReplay();
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log.http.warn({ err: errMessage, topic, operationId, userId }, "event stream poll failed");
      } finally {
        inFlight = false;
      }
    }, POLL_MS);

    keepaliveTimer = setInterval(() => {
      if (closed) return;
      // P4: keepalive carries only timestamp — no user-scoped routing metadata
      writeSse("keepalive", {
        timestamp: new Date().toISOString(),
      });
    }, KEEPALIVE_MS);

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  return router;
}
