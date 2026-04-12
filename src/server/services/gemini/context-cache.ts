/**
 * gemini/context-cache.ts — Context cache lifecycle management (#240)
 *
 * Wraps Gemini's CachedContent API for system instruction caching.
 * Caching reduces per-request input token cost by ~75%.
 */

import type { GoogleGenAI } from "@google/genai";
import type { Logger } from "pino";

/** Default cache TTL: 1 hour — matches session cleanup cycle. */
export const CACHE_TTL = "3600s";

/**
 * Manages the lifecycle of a Gemini context cache.
 *
 * Encapsulates create/delete operations and tracks the active cache name.
 * The engine reads `manager.name` when building chat configs to decide
 * between cached and inline system instructions.
 */
export class ContextCacheManager {
  private cacheName: string | null = null;

  constructor(
    private ai: GoogleGenAI,
    private logger: Logger,
  ) {}

  /** The active cache resource name, or null if no cache is active. */
  get name(): string | null { return this.cacheName; }
  set name(value: string | null) { this.cacheName = value; }

  /**
   * Create a context cache for the given model and system instruction.
   * Returns the cache name on success, null on failure (falls back to inline).
   */
  async create(
    modelId: string,
    systemInstruction: string,
    tools?: object[],
  ): Promise<string | null> {
    try {
      const cached = await this.ai.caches.create({
        model: modelId,
        config: {
          systemInstruction,
          ...(tools ? { tools } : {}),
          ttl: CACHE_TTL,
          displayName: `majel-system-${modelId}`,
        },
      });
      if (cached.name) {
        this.cacheName = cached.name;
        this.logger.info({
          cacheName: cached.name,
          model: modelId,
          tokenCount: cached.usageMetadata?.totalTokenCount,
        }, "context_cache:created");
        return cached.name;
      }
      return null;
    } catch (err) {
      this.logger.warn({
        err: err instanceof Error ? err.message : String(err),
        model: modelId,
      }, "context_cache:create_failed — falling back to inline systemInstruction");
      return null;
    }
  }

  /** Delete the active context cache. Best-effort — cache expires via TTL anyway. */
  async delete(): Promise<void> {
    if (!this.cacheName) return;
    const name = this.cacheName;
    this.cacheName = null;
    try {
      await this.ai.caches.delete({ name });
      this.logger.debug({ cacheName: name }, "context_cache:deleted");
    } catch {
      // Best-effort cleanup — cache will expire via TTL anyway
    }
  }

  /** Detect a stale/expired context cache error from the Gemini API (403). */
  static isExpiredError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes("CachedContent not found");
  }
}
