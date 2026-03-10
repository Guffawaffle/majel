/**
 * routes/chat.ts — Chat, history, and memory recall routes.
 */

import express, { type Router } from "express";
import { randomUUID } from "node:crypto";
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
import { createContextMiddleware } from "../context-middleware.js";
import { chatRateLimiter } from "../rate-limit.js";
import { attachScopedMemory } from "../services/memory-middleware.js";
import { MODEL_REGISTRY, getModelDef, DEFAULT_MODEL } from "../services/gemini/index.js";
import type { ImagePart } from "../services/gemini/index.js";

/** Allowed image MIME types for multimodal chat (ADR-008) */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Max base64 image data size: ~10MB base64 ≈ ~7.5MB raw image */
const MAX_IMAGE_DATA_LENGTH = 10 * 1024 * 1024;
const LOCKED_MODEL_ID = DEFAULT_MODEL;
const TAB_ID_RE = /^[a-zA-Z0-9_-]{2,120}$/;
const RUN_ID_RE = /^[a-zA-Z0-9._:-]{2,120}$/;
const RUN_WATCHDOG_MS = 15_000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_CLAIM_POLL_MS = 1000;
const RUN_STALE_REQUEUE_MS = 2 * RUN_TIMEOUT_MS;

interface RunRouting {
  runId: string;
  sessionId: string;
  tabId: string;
}

interface ExecuteChatInput extends RunRouting {
  message: string;
  imagePart?: ImagePart;
  userId?: string;
  requestId?: string;
  isAdmiral: boolean;
}

type RunFinalStatus = "cancelled" | "timed_out";

interface ExecuteChatOptions {
  isCancelled?: () => boolean;
  cancelledStatus?: () => RunFinalStatus;
  reason?: string;
}

interface ExecuteChatResult {
  answer: string;
  proposals?: Array<{ id: string; batchItems: Array<{ tool: string; preview: string }>; expiresAt: string }>;
  trace?: {
    timestamp: string;
    requestId: string | null;
    sessionId: string;
    userId: string | null;
    hasImage: boolean;
    answerChars: number;
    proposalCount: number;
    proposalIds: string[];
  };
}

async function buildChatMessage(appState: AppState, userId: string | undefined, message: string): Promise<string> {
  let chatMessage = message;
  if (!userId || !appState.userSettingsStore) return chatMessage;

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
    log.settings.warn({ err: err instanceof Error ? err.message : String(err), userId }, "failed to read per-user chat context");
  }

  return chatMessage;
}

async function executeChatRun(
  appState: AppState,
  input: ExecuteChatInput,
  options?: ExecuteChatOptions,
): Promise<ExecuteChatResult | null> {
  const { runId, sessionId, tabId, message, imagePart, userId, requestId, isAdmiral } = input;
  const eventStore = userId && appState.operationEventStoreFactory
    ? appState.operationEventStoreFactory.forUser(userId)
    : null;

  if (!appState.geminiEngine) {
    throw new Error("Gemini not ready");
  }

  const traceId = requestId ?? runId;

  if (eventStore) {
    await eventStore.emit({
      topic: "chat_run",
      operationId: runId,
      routing: { sessionId, tabId },
      eventType: "run.started",
      status: "running",
      payloadJson: {
        phase: "chat.request_received",
        hasImage: !!imagePart,
        traceId,
      },
    });
  }

  try {
    const chatMessage = await buildChatMessage(appState, userId, message);
    const result = await appState.geminiEngine.chat(chatMessage, sessionId, imagePart, userId, requestId);
    const answer = typeof result === "string" ? result : result.text;
    const proposals = typeof result === "string" ? undefined : result.proposals;
    const proposalIds = proposals?.map((p) => p.id) ?? [];

    const trace = isAdmiral
      ? {
          timestamp: new Date().toISOString(),
          requestId: requestId ?? null,
          sessionId,
          userId: userId ?? null,
          hasImage: !!imagePart,
          answerChars: answer.length,
          proposalCount: proposalIds.length,
          proposalIds,
        }
      : undefined;

    const cancelled = options?.isCancelled?.() ?? false;
    if (cancelled) {
      const status = options?.cancelledStatus?.() ?? "cancelled";
      const reason = options?.reason ?? (status === "timed_out" ? "watchdog_timeout" : "cancel_requested");
      if (eventStore) {
        await eventStore.emit({
          topic: "chat_run",
          operationId: runId,
          routing: { sessionId, tabId },
          eventType: status === "timed_out" ? "run.timed_out" : "run.cancelled",
          status,
          payloadJson: {
            phase: status === "timed_out" ? "chat.timed_out" : "chat.cancelled",
            reason,
            traceId,
          },
        });
      }
      log.gemini.info({ event: "chat_run.terminated", runId, traceId, status, reason, userId, sessionId, tabId }, "chat run terminated before completion");
      return null;
    }

    if (eventStore) {
      await eventStore.emit({
        topic: "chat_run",
        operationId: runId,
        routing: { sessionId, tabId },
        eventType: "run.completed",
        status: "succeeded",
        payloadJson: {
          phase: "chat.completed",
          answer,
          proposals,
          trace,
          answerChars: answer.length,
          proposalCount: proposalIds.length,
          traceId,
        },
      });
    }

    if (!answer) {
      log.gemini.warn({ requestId, sessionId, userId, hasImage: !!imagePart }, "chat:empty-answer");
    }

    const memory = appState.memoryService;
    if (memory) {
      memory
        .remember({ question: message, answer })
        .catch((err) => {
          log.lex.error({ err: err instanceof Error ? err.message : String(err), sessionId }, "memory save failed — conversation not persisted to Lex");
        });
    }

    if (appState.sessionStore) {
      await appState.sessionStore.addMessage(sessionId, "user", message, userId);
      await appState.sessionStore.addMessage(sessionId, "model", answer, undefined, proposalIds);
    }

    return {
      answer,
      proposals: proposals && proposals.length > 0 ? proposals : undefined,
      trace,
    };
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (eventStore) {
      await eventStore.emit({
        topic: "chat_run",
        operationId: runId,
        routing: { sessionId, tabId },
        eventType: "run.failed",
        status: "failed",
        payloadJson: {
          phase: "chat.failed",
          errorCode: "GEMINI_ERROR",
          errorMessage: errMessage,
          requestId: requestId ?? null,
          traceId,
        },
      });
    }
    log.gemini.error({ event: "chat_run.failed", runId, traceId, userId, sessionId, tabId, err: errMessage }, "chat run failed during execution");
    throw err;
  }
}

export function createChatRoutes(appState: AppState): Router {
  const router = createSafeRouter();

  const runningRuns = new Map<string, { cancelled: boolean; cancelledStatus: RunFinalStatus; lockToken: string }>();
  let claimInFlight = false;

  const processClaimedRun = async (
    claimed: { runId: string; sessionId: string; tabId: string; userId: string; message: string; imagePart?: ImagePart; requestId?: string; isAdmiral: boolean },
    lockToken: string,
  ): Promise<void> => {
    const runningState = { cancelled: false, cancelledStatus: "cancelled" as RunFinalStatus, lockToken };
    runningRuns.set(claimed.runId, runningState);
    const traceId = claimed.requestId ?? claimed.runId;

    const startedAtMs = Date.now();
    const watchdogStore = appState.operationEventStoreFactory?.forUser(claimed.userId);
    const watchdogTimer = setInterval(() => {
      if (!appState.chatRunStore || runningState.cancelled) return;
      void appState.chatRunStore.heartbeat(claimed.runId, lockToken).catch(() => {
        // best-effort heartbeat
      });
      void appState.chatRunStore.get(claimed.runId).then((run) => {
        if (run?.cancelRequested) {
          runningState.cancelled = true;
          runningState.cancelledStatus = "cancelled";
        }
      }).catch(() => {
        // best-effort cancellation check
      });
      if (!watchdogStore) return;
      void watchdogStore.emit({
        topic: "chat_run",
        operationId: claimed.runId,
        routing: { sessionId: claimed.sessionId, tabId: claimed.tabId },
        eventType: "run.progress",
        status: "running",
        payloadJson: {
          phase: "chat.running",
          elapsedMs: Date.now() - startedAtMs,
          traceId,
        },
      }).catch(() => {
        // best-effort heartbeat event
      });
    }, RUN_WATCHDOG_MS);
    watchdogTimer.unref?.();

    const timeoutTimer = setTimeout(() => {
      runningState.cancelled = true;
      runningState.cancelledStatus = "timed_out";
    }, RUN_TIMEOUT_MS);
    timeoutTimer.unref?.();

    try {
      const result = await executeChatRun(appState, {
        runId: claimed.runId,
        sessionId: claimed.sessionId,
        tabId: claimed.tabId,
        message: claimed.message,
        imagePart: claimed.imagePart,
        userId: claimed.userId,
        requestId: claimed.requestId,
        isAdmiral: claimed.isAdmiral,
      }, {
        isCancelled: () => runningState.cancelled,
        cancelledStatus: () => runningState.cancelledStatus,
        reason: runningState.cancelledStatus === "timed_out" ? "watchdog_timeout" : "cancel_requested",
      });

      if (!appState.chatRunStore) return;
      if (runningState.cancelled) {
        await appState.chatRunStore.finish(claimed.runId, lockToken, runningState.cancelledStatus);
      } else if (result) {
        await appState.chatRunStore.finish(claimed.runId, lockToken, "succeeded");
        log.gemini.info({ event: "chat_run.succeeded", runId: claimed.runId, traceId, userId: claimed.userId, sessionId: claimed.sessionId, tabId: claimed.tabId, durationMs: Date.now() - startedAtMs }, "chat run succeeded");
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ event: "chat_run.worker.failed", err: errMessage, runId: claimed.runId, traceId, sessionId: claimed.sessionId, userId: claimed.userId, tabId: claimed.tabId }, "async chat run failed");
      if (appState.chatRunStore) {
        await appState.chatRunStore.finish(claimed.runId, lockToken, "failed");
      }
    } finally {
      clearInterval(watchdogTimer);
      clearTimeout(timeoutTimer);
      runningRuns.delete(claimed.runId);
    }
  };

  const claimAndProcessOne = async (): Promise<void> => {
    if (!appState.chatRunStore || claimInFlight) return;
    claimInFlight = true;
    try {
      const requeued = await appState.chatRunStore.requeueStaleRunning(RUN_STALE_REQUEUE_MS);
      if (requeued > 0) {
        log.gemini.warn({ event: "chat_run.recover_stale", recovered: requeued, staleAfterMs: RUN_STALE_REQUEUE_MS }, "recovered stale running chat runs");
      }
      const lockToken = `lock_${randomUUID()}`;
      const claimed = await appState.chatRunStore.claimNext(lockToken);
      if (!claimed) return;

      const createdAtMs = new Date(claimed.run.createdAt).getTime();
      const claimLatencyMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null;
      log.gemini.info({ event: "chat_run.claimed", runId: claimed.run.id, userId: claimed.run.userId, sessionId: claimed.run.sessionId, tabId: claimed.run.tabId, claimLatencyMs }, "claimed queued chat run");

      const req = claimed.run.requestJson;
      const message = typeof req.message === "string" ? req.message : "";
      if (!message) {
        log.gemini.error({ event: "chat_run.invalid_payload", runId: claimed.run.id, userId: claimed.run.userId }, "chat run payload missing message");
        await appState.chatRunStore.finish(claimed.run.id, lockToken, "failed");
        return;
      }

      const imagePart = req.imagePart && typeof req.imagePart === "object"
        ? (req.imagePart as ImagePart)
        : undefined;

      await processClaimedRun({
        runId: claimed.run.id,
        userId: claimed.run.userId,
        sessionId: claimed.run.sessionId,
        tabId: claimed.run.tabId,
        message,
        imagePart,
        requestId: typeof req.requestId === "string" ? req.requestId : undefined,
        isAdmiral: req.isAdmiral === true,
      }, lockToken);
    } finally {
      claimInFlight = false;
    }
  };

  const claimTimer = setInterval(() => {
    void claimAndProcessOne().catch((err) => {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ event: "chat_run.claim_loop.error", err: errMessage }, "chat run claim loop error");
    });
  }, RUN_CLAIM_POLL_MS);
  claimTimer.unref?.();

  // ADR-039: per-handler RequestContext (chat.ts uses per-handler middleware chains)
  const ctxMw = appState.pool ? createContextMiddleware(appState.pool) : undefined;

  // ─── Chat ───────────────────────────────────────────────────

  // Route-specific body limit: 10MB to accommodate base64 image payloads (ADR-008)
  const chatBodyParser = express.json({ limit: '10mb' });

  router.post("/api/chat", chatBodyParser, requireVisitor(appState), ...(ctxMw ? [ctxMw] : []), chatRateLimiter, attachScopedMemory(appState), createTimeoutMiddleware(60_000), async (req, res) => {
    const { message, image: rawImage, tabId: rawTabId } = req.body;
    const asyncRequested = req.body?.async === true;
    const sessionId = (req.headers["x-session-id"] as string) || "default";
    const tabId = typeof rawTabId === "string" && rawTabId.trim() ? rawTabId.trim() : "default_tab";
    const runId = `crun_${randomUUID()}`;

    if (sessionId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid session ID", 400);
    }
    if (rawTabId != null && typeof rawTabId !== "string") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "tabId must be a string", 400);
    }
    if (!TAB_ID_RE.test(tabId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid tabId", 400);
    }

    if (!message || typeof message !== "string") {
      return sendFail(res, ErrorCode.MISSING_PARAM, "Missing 'message' in request body", 400, {
        hints: ["Send JSON body: { \"message\": \"your question\" }"],
      });
    }
    if (req.body?.async != null && typeof req.body.async !== "boolean") {
      return sendFail(res, ErrorCode.INVALID_PARAM, "async must be a boolean", 400);
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

    const ctx = res.locals.ctx;
    const userId = ctx?.identity.userId ?? (res.locals.userId as string | undefined);
    const requestId = ctx?.identity.requestId ?? (res.locals._requestId as string | undefined);
    const isAdmiral = !!res.locals.isAdmiral;

    try {
      if (userId && appState.operationEventStoreFactory) {
        const eventStore = appState.operationEventStoreFactory.forUser(userId);
        await eventStore.register("chat_run", runId, { sessionId, tabId });
        await eventStore.emit({
          topic: "chat_run",
          operationId: runId,
          routing: { sessionId, tabId },
          eventType: "run.queued",
          status: "queued",
          payloadJson: {
            phase: "chat.queued",
            hasImage: !!imagePart,
            requestId: requestId ?? null,
            traceId: requestId ?? runId,
          },
        });
      }

      if (asyncRequested) {
        if (!appState.chatRunStore || !userId) {
          return sendFail(res, ErrorCode.INTERNAL_ERROR, "Async chat queue not available", 503, {
            hints: ["Retry in a few seconds"],
          });
        }
        await appState.chatRunStore.enqueue({
          id: runId,
          userId,
          sessionId,
          tabId,
          requestJson: {
            message,
            imagePart,
            requestId,
            isAdmiral,
          },
        });
        void claimAndProcessOne();

        if (res.headersSent) return;
        return sendOk(res, {
          runId,
          sessionId,
          tabId,
          status: "queued",
          traceId: requestId ?? runId,
          submittedAt: new Date().toISOString(),
        }, 202);
      }

      const result = await executeChatRun(appState, {
        runId,
        sessionId,
        tabId,
        message,
        imagePart,
        userId,
        requestId,
        isAdmiral,
      });

      if (!result) {
        return sendFail(res, ErrorCode.INTERNAL_ERROR, "Chat run ended without a response", 500, {
          hints: ["Retry the request"],
        });
      }

      if (res.headersSent) return;
      sendOk(res, {
        runId,
        sessionId,
        tabId,
        traceId: requestId ?? runId,
        answer: result.answer,
        proposals: result.proposals,
        trace: result.trace,
      });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.gemini.error({ err: errMessage }, "chat request failed");
      if (res.headersSent) return;
      sendFail(res, ErrorCode.GEMINI_ERROR, "AI request failed", 500, {
        ...(isAdmiral
          ? {
              trace: {
                timestamp: new Date().toISOString(),
                requestId: requestId ?? null,
                sessionId,
                userId: userId ?? null,
                hasImage: !!rawImage,
                error: errMessage,
              },
            }
          : {}),
        hints: ["Try again in a few seconds", "If the problem persists, check /api/health"],
      });
    }
  });

  router.get("/api/chat/runs/:runId", requireVisitor(appState), ...(ctxMw ? [ctxMw] : []), async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    if (!RUN_ID_RE.test(runId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid runId", 400);
    }
    if (!appState.operationEventStoreFactory) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Event stream not available", 503, {
        hints: ["Retry in a few seconds"],
      });
    }

    const ctx = res.locals.ctx;
    const userId = ctx?.identity.userId ?? (res.locals.userId as string | undefined);
    if (!userId) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const store = appState.operationEventStoreFactory.forUser(userId);
    const routing = await store.getRouting("chat_run", runId);
    if (!routing) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Run not found", 404);
    }

    const durableRun = appState.chatRunStore
      ? await appState.chatRunStore.getForUser(runId, userId)
      : null;
    const latest = await store.latest("chat_run", runId);
    const payload = (latest?.payloadJson ?? {}) as Record<string, unknown>;
    const status = durableRun?.status ?? latest?.status ?? "queued";
    const inferredPhase =
      status === "queued" ? "chat.queued"
        : status === "running" ? "chat.running"
          : status === "succeeded" ? "chat.completed"
            : status === "failed" ? "chat.failed"
              : status === "cancelled" ? "chat.cancelled"
                : status === "timed_out" ? "chat.timed_out"
                  : null;
    const inferredCancelReason =
      status === "timed_out" ? "watchdog_timeout"
        : status === "cancelled" && durableRun?.cancelRequested ? "cancel_requested"
          : null;

    sendOk(res, {
      runId,
      sessionId: routing.sessionId,
      tabId: routing.tabId,
      status,
      phase: typeof payload.phase === "string" ? payload.phase : inferredPhase,
      traceId: typeof payload.traceId === "string" ? payload.traceId : null,
      requestId: typeof payload.requestId === "string" ? payload.requestId : null,
      errorCode: typeof payload.errorCode === "string" ? payload.errorCode : null,
      errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : null,
      cancelReason: typeof payload.reason === "string" ? payload.reason : inferredCancelReason,
      answer: typeof payload.answer === "string" ? payload.answer : null,
      proposals: Array.isArray(payload.proposals) ? payload.proposals : [],
      trace: payload.trace ?? null,
      updatedAt: durableRun?.updatedAt ?? latest?.createdAt ?? null,
    });
  });

  router.post("/api/chat/runs/:runId/cancel", requireVisitor(appState), ...(ctxMw ? [ctxMw] : []), async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    if (!RUN_ID_RE.test(runId)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Invalid runId", 400);
    }
    if (!appState.operationEventStoreFactory) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Event stream not available", 503, {
        hints: ["Retry in a few seconds"],
      });
    }

    const ctx = res.locals.ctx;
    const userId = ctx?.identity.userId ?? (res.locals.userId as string | undefined);
    if (!userId) {
      return sendFail(res, ErrorCode.UNAUTHORIZED, "Authentication required", 401);
    }

    const store = appState.operationEventStoreFactory.forUser(userId);
    const routing = await store.getRouting("chat_run", runId);
    if (!routing) {
      return sendFail(res, ErrorCode.NOT_FOUND, "Run not found", 404);
    }

    const latest = await store.latest("chat_run", runId);
    const durableRun = appState.chatRunStore
      ? await appState.chatRunStore.getForUser(runId, userId)
      : null;
    const status = durableRun?.status ?? latest?.status ?? "queued";
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
      return sendFail(res, ErrorCode.INVALID_PARAM, "Run is already in a terminal state", 409);
    }

    if (!appState.chatRunStore) {
      return sendFail(res, ErrorCode.INTERNAL_ERROR, "Async chat queue not available", 503, {
        hints: ["Retry in a few seconds"],
      });
    }

    const cancelled = await appState.chatRunStore.requestCancel(runId, userId);
    if (cancelled === "not_found") return sendFail(res, ErrorCode.NOT_FOUND, "Run not found", 404);
    if (cancelled === "terminal") return sendFail(res, ErrorCode.INVALID_PARAM, "Run is already in a terminal state", 409);

    if (cancelled === "queued") {
      await store.emit({
        topic: "chat_run",
        operationId: runId,
        routing,
        eventType: "run.cancelled",
        status: "cancelled",
        payloadJson: {
          phase: "chat.cancelled",
          reason: "cancel_requested",
          traceId: runId,
        },
      });
      log.gemini.info({ event: "chat_run.cancelled", runId, userId, sessionId: routing.sessionId, tabId: routing.tabId, source: "queued" }, "cancelled queued chat run");
    } else {
      const running = runningRuns.get(runId);
      if (running) {
        running.cancelled = true;
        running.cancelledStatus = "cancelled";
      }
      log.gemini.info({ event: "chat_run.cancel_requested", runId, userId, sessionId: routing.sessionId, tabId: routing.tabId, source: "running" }, "requested cancellation for running chat run");
    }

    sendOk(res, {
      runId,
      status: cancelled === "queued" ? "cancelled" : "cancelling",
      cancelledAt: new Date().toISOString(),
    }, 202);
  });

  // ─── History ────────────────────────────────────────────────

  router.get("/api/history", requireVisitor(appState), ...(ctxMw ? [ctxMw] : []), attachScopedMemory(appState), async (req, res) => {
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
      const ctx = res.locals.ctx;
      const userId = ctx?.identity.userId ?? (res.locals.userId as string | undefined);
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

  router.get("/api/recall", requireVisitor(appState), ...(ctxMw ? [ctxMw] : []), attachScopedMemory(appState), async (req, res) => {
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
