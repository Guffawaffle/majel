/**
 * broadcast.ts — Cross-tab cache invalidation via BroadcastChannel.
 *
 * ADR-032 Phase 4: When one tab invalidates a cache pattern,
 * all other tabs receive the same invalidation so stale data
 * doesn't persist across browser tabs.
 *
 * Safe to call if BroadcastChannel is unavailable (e.g., older browsers).
 */

import { cacheInvalidate } from "./idb-cache.js";
import { bumpEpochForPatterns } from "./cache-epochs.js";

const CHANNEL_PREFIX = "majel-cache";

let channel: BroadcastChannel | null = null;
let channelScope: string | null = null;

// ─── Lifecycle ──────────────────────────────────────────────

/**
 * Open the broadcast channel and listen for invalidation events from other tabs.
 * Call once during cache initialization.
 */
export function openBroadcast(userId: string): void {
  const scope = String(userId || "anonymous");
  if (channel && channelScope === scope) return;
  if (channel && channelScope !== scope) closeBroadcast();
  try {
    channelScope = scope;
    channel = new BroadcastChannel(`${CHANNEL_PREFIX}:${scope}`);
    channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; patterns?: string[]; scope?: string };
      if (msg.scope && msg.scope !== channelScope) return;
      if (msg.type === "invalidate" && Array.isArray(msg.patterns)) {
        bumpEpochForPatterns(msg.patterns);
        // Invalidate locally — don't re-broadcast (would loop)
        Promise.all(msg.patterns.map((p) => cacheInvalidate(p))).catch(() => {});
      }
    };
  } catch {
    // BroadcastChannel unavailable — degrade silently
    channel = null;
  }
}

/** Close the broadcast channel. Call on teardown/logout. */
export function closeBroadcast(): void {
  if (channel) {
    channel.close();
    channel = null;
    channelScope = null;
  }
}

// ─── Broadcasting ───────────────────────────────────────────

/**
 * Broadcast invalidation patterns to other tabs.
 * Call after local invalidation completes.
 */
export function broadcastInvalidation(patterns: string[]): void {
  if (!channel) return;
  try {
    channel.postMessage({ type: "invalidate", patterns, scope: channelScope });
  } catch {
    // Channel closed or other error — silently ignore
  }
}
