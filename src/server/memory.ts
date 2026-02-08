/**
 * memory.ts — Lex Integration for Conversation History
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Uses @smartergpt/lex to persist conversation turns as memory frames.
 * Each Q&A turn becomes a searchable, timestamped frame.
 *
 * Workspace isolation: LEX_WORKSPACE_ROOT=/srv/majel ensures
 * Majel's DB is at /srv/majel/.smartergpt/lex/memory.db
 * (never touches the global ~/.smartergpt/lex/memory.db)
 */

import { createFrameStore } from "@smartergpt/lex/store";
import { createFrame } from "@smartergpt/lex/types";
import type { Frame } from "@smartergpt/lex/types";

// Re-export Frame type for consumers
export type { Frame };

export interface ConversationTurn {
  question: string;
  answer: string;
}

export interface MemoryService {
  /** Store a conversation turn as a Lex frame. */
  remember(turn: ConversationTurn): Promise<Frame>;

  /** Search past conversations by free-text query. */
  recall(query: string, limit?: number): Promise<Frame[]>;

  /** Get recent conversation timeline. */
  timeline(limit?: number): Promise<Frame[]>;

  /** Clean shutdown. */
  close(): Promise<void>;
}

/**
 * Create the memory service backed by Lex's FrameStore.
 *
 * @param dbPath - Optional explicit path to SQLite DB.
 *   If omitted, Lex resolves via LEX_WORKSPACE_ROOT or defaults.
 */
export function createMemoryService(dbPath?: string): MemoryService {
  const store = createFrameStore(dbPath);

  return {
    async remember(turn: ConversationTurn): Promise<Frame> {
      // Extract a reference point from the question (first ~60 chars)
      const refPoint = turn.question.length > 60
        ? turn.question.slice(0, 57) + "..."
        : turn.question;

      // Extract keywords from the question
      const keywords = extractKeywords(turn.question);

      const frame = createFrame({
        branch: "majel-chat",
        module_scope: ["majel/chat"],
        summary_caption: `Q: ${refPoint} → A: ${turn.answer.slice(0, 100)}${turn.answer.length > 100 ? "..." : ""}`,
        reference_point: refPoint,
        next_action: "Continue conversation",
        keywords,
      });

      await store.saveFrame(frame);
      return frame;
    },

    async recall(query: string, limit = 10): Promise<Frame[]> {
      const results = await store.searchFrames({ query, limit });
      return results;
    },

    async timeline(limit = 20): Promise<Frame[]> {
      const result = await store.listFrames({ limit });
      return result.frames;
    },

    async close(): Promise<void> {
      await store.close();
    },
  };
}

/**
 * Extract meaningful keywords from a question.
 * Strips common stop words, keeps names and nouns.
 */
export function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very", "just",
    "don", "now", "and", "but", "or", "if", "while", "about", "what",
    "which", "who", "whom", "this", "that", "these", "those", "am", "it",
    "its", "i", "me", "my", "we", "our", "you", "your", "he", "him",
    "his", "she", "her", "they", "them", "their",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 10);
}
