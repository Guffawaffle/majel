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

const CHANNEL_NAME = "majel-cache";

let channel: BroadcastChannel | null = null;

// ─── Lifecycle ──────────────────────────────────────────────

/**
 * Open the broadcast channel and listen for invalidation events from other tabs.
 * Call once during cache initialization.
 */
export function openBroadcast(): void {
  if (channel) return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; patterns?: string[] };
      if (msg.type === "invalidate" && Array.isArray(msg.patterns)) {
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
    channel.postMessage({ type: "invalidate", patterns });
  } catch {
    // Channel closed or other error — silently ignore
  }
}
