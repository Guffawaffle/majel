/**
 * network-status.svelte.ts — Reactive online/offline detection.
 *
 * ADR-032 Phase 3: Uses navigator.onLine + online/offline events.
 * Provides getOnline() getter for reactive Svelte 5 consumption.
 */

let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

function handleOnline() {
  online = true;
}

function handleOffline() {
  online = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
}

/** Reactive getter — returns current online status. */
export function getOnline(): boolean {
  return online;
}
