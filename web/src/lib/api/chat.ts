/**
 * Chat API — send messages, load history, search recall.
 */

import type { ChatImage, ChatResponse, HistoryResponse, RecallResponse } from "../types.js";
import { apiFetch, apiPost, qs } from "./fetch.js";
import { runLockedMutation } from "./mutation.js";

/** Callback interface for run lifecycle events. */
export interface RunProgressCallbacks {
  onQueued?: () => void;
  onStarted?: (model?: string) => void;
  onProgress?: (elapsedMs: number) => void;
}

interface ChatSubmitResponse {
  runId: string;
  sessionId?: string;
  tabId?: string;
  status: "queued" | "running";
  submittedAt?: string;
  answer?: string;
  proposals?: ChatResponse["proposals"];
  trace?: ChatResponse["trace"];
}

interface StreamEventData {
  topic?: string;
  id?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

interface ChatRunStatusResponse {
  runId: string;
  sessionId?: string;
  tabId?: string;
  status: string;
  answer: string | null;
  proposals: ChatResponse["proposals"];
  trace: ChatResponse["trace"] | null;
}

function parseStreamData(raw: string): StreamEventData | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StreamEventData) : null;
  } catch {
    return null;
  }
}

async function readRunSnapshot(runId: string): Promise<ChatResponse> {
  const status = await apiFetch<ChatRunStatusResponse>(`/api/chat/runs/${encodeURIComponent(runId)}`);
  if (status.status === "failed") {
    throw new Error("AI request failed");
  }
  if (status.status === "cancelled") {
    throw new Error("Chat run was cancelled");
  }
  if (status.status === "timed_out") {
    throw new Error("Chat run timed out");
  }
  if (!status.answer) {
    throw new Error("Chat run did not return an answer");
  }
  return {
    runId: status.runId,
    sessionId: status.sessionId,
    tabId: status.tabId,
    answer: status.answer,
    proposals: status.proposals,
    trace: status.trace ?? undefined,
  };
}

function waitForRunCompletion(
  runId: string,
  sessionId?: string,
  tabId?: string,
  callbacks?: RunProgressCallbacks,
): Promise<ChatResponse> {
  if (typeof EventSource === "undefined") {
    return readRunSnapshot(runId);
  }

  const streamUrl = `/api/events/stream${qs({ topic: "chat_run", id: runId })}`;
  const timeoutMs = 120_000;

  return new Promise((resolve, reject) => {
    const source = new EventSource(streamUrl);
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      source.close();
      fn();
    };

    const resolveFromPayload = (payload: Record<string, unknown>): void => {
      const answer = typeof payload.answer === "string" ? payload.answer : null;
      if (!answer) {
        finish(() => reject(new Error("Chat run did not return an answer")));
        return;
      }
      finish(() => {
        resolve({
          runId,
          sessionId,
          tabId,
          answer,
          proposals: Array.isArray(payload.proposals) ? (payload.proposals as ChatResponse["proposals"]) : undefined,
          trace: (payload.trace as ChatResponse["trace"] | undefined) ?? undefined,
        });
      });
    };

    const timeoutId = window.setTimeout(() => {
      void readRunSnapshot(runId)
        .then((result) => finish(() => resolve(result)))
        .catch((err) => finish(() => reject(err instanceof Error ? err : new Error("Chat run timed out"))));
    }, timeoutMs);

    source.onerror = () => {
      // Single fallback attempt on SSE error — no unbounded polling
      void readRunSnapshot(runId)
        .then((result) => finish(() => resolve(result)))
        .catch((err) => finish(() => reject(err instanceof Error ? err : new Error("AI request failed"))));
    };

    // ── Progress events (ADR-043) ──

    source.addEventListener("run.queued", () => {
      if (!settled) callbacks?.onQueued?.();
    });

    source.addEventListener("run.started", (event) => {
      if (settled) return;
      const parsed = parseStreamData((event as MessageEvent).data);
      const model = parsed?.payload && typeof parsed.payload.model === "string"
        ? parsed.payload.model
        : undefined;
      callbacks?.onStarted?.(model);
    });

    source.addEventListener("run.progress", (event) => {
      if (settled) return;
      const parsed = parseStreamData((event as MessageEvent).data);
      const elapsedMs = parsed?.payload && typeof parsed.payload.elapsedMs === "number"
        ? parsed.payload.elapsedMs
        : undefined;
      if (elapsedMs !== undefined) callbacks?.onProgress?.(elapsedMs);
    });

    // ── Terminal events ──

    source.addEventListener("run.completed", (event) => {
      const parsed = parseStreamData((event as MessageEvent).data);
      const payload = parsed?.payload;
      if (!payload || typeof payload !== "object") {
        void readRunSnapshot(runId)
          .then((result) => finish(() => resolve(result)))
          .catch((err) => finish(() => reject(err instanceof Error ? err : new Error("AI request failed"))));
        return;
      }
      resolveFromPayload(payload);
    });

    source.addEventListener("run.failed", (event) => {
      const parsed = parseStreamData((event as MessageEvent).data);
      const msg = parsed?.payload && typeof parsed.payload.error === "string"
        ? parsed.payload.error
        : "AI request failed";
      finish(() => reject(new Error(msg)));
    });

    source.addEventListener("run.cancelled", () => {
      finish(() => reject(new Error("Chat run was cancelled")));
    });

    source.addEventListener("run.timed_out", () => {
      finish(() => reject(new Error("Chat run timed out")));
    });
  });
}

/**
 * Cancel an active chat run.
 */
export async function cancelRun(runId: string): Promise<void> {
  await apiPost(`/api/chat/runs/${encodeURIComponent(runId)}/cancel`, {});
}

/**
 * Send a chat message (optionally with an image attachment).
 * Throws ApiError on failure — callers display the error.
 *
 * @param onRunId  — Called with the runId once the run is submitted (before completion)
 * @param progress — Callbacks for run lifecycle events (queued/started/progress)
 */
export async function sendChat(
  sessionId: string,
  message: string,
  image?: ChatImage,
  tabId?: string,
  onRunId?: (runId: string) => void,
  progress?: RunProgressCallbacks,
): Promise<ChatResponse> {
  return runLockedMutation({
    label: "Send chat message",
    lockKey: `chat:${sessionId}`,
    mutate: async () => {
      const submit = await apiFetch<ChatSubmitResponse>("/api/chat", {
        method: "POST",
        headers: { "X-Session-Id": sessionId },
        body: JSON.stringify({ message, async: true, ...(tabId && { tabId }), ...(image && { image }) }),
      });

      if (typeof submit.runId !== "string" || !submit.runId) {
        return submit as unknown as ChatResponse;
      }

      onRunId?.(submit.runId);

      if (typeof submit.answer === "string") {
        return {
          runId: submit.runId,
          sessionId: submit.sessionId,
          tabId: submit.tabId,
          answer: submit.answer,
          proposals: submit.proposals,
          trace: submit.trace,
        } satisfies ChatResponse;
      }

      return waitForRunCompletion(submit.runId, submit.sessionId, submit.tabId, progress);
    },
  });
}

/**
 * Load recent Lex history entries for the chat sidebar.
 * Returns an empty object on failure.
 */
export async function loadHistory(): Promise<HistoryResponse> {
  try {
    return await apiFetch<HistoryResponse>(
      `/api/history${qs({ source: "lex", limit: 20 })}`,
    );
  } catch {
    return {};
  }
}

/**
 * Search Lex recall store.
 * Returns an empty object on failure.
 */
export async function searchRecall(query: string): Promise<RecallResponse> {
  try {
    return await apiFetch<RecallResponse>(
      `/api/recall${qs({ q: query })}`,
    );
  } catch {
    return { query, results: [] };
  }
}
