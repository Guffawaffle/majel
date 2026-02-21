/**
 * Hash-based router for Majel Svelte client.
 *
 * Uses Svelte 5 runes ($state) for reactive current view.
 * Mirrors the vanilla router's hash convention: #/viewName
 */

import type { ViewDef } from "./types.js";

/** All registered views, in sidebar display order */
export const views: ViewDef[] = [
  { name: "chat",        icon: "💬", title: "Chat",             subtitle: "Gemini-powered fleet advisor" },
  { name: "startsync",   icon: "📥", title: "Start / Sync",     subtitle: "Onboarding, import paths, and receipt history" },
  { name: "catalog",     icon: "📋", title: "Catalog",          subtitle: "Reference data & ownership tracking" },
  { name: "fleet",       icon: "🚀", title: "Fleet",            subtitle: "Your owned roster — levels, ranks & power" },
  { name: "crews",       icon: "⚓", title: "Workshop",         subtitle: "Composition workshop — cores, loadouts, policies & reservations" },
  { name: "plan",        icon: "🗺️", title: "Plan",             subtitle: "Fleet state — docks, presets & assignments" },
  { name: "diagnostics", icon: "⚡", title: "Diagnostics",      subtitle: "System health, data summary & query console", gate: "admiral" },
  { name: "admiral",     icon: "🛡️", title: "Admiral Console",  subtitle: "User management, invites & sessions",        gate: "admiral" },
];

const viewMap = new Map(views.map((v) => [v.name, v]));

/** Backward-compatibility hash redirects */
const REDIRECTS: Record<string, string> = {
  admin: "admiral",
  drydock: "crews",
  "crew-builder": "crews",
  "fleet-ops": "plan",
};

const DEFAULT_VIEW = "chat";

/** Parse a hash string into a view name, applying redirects */
function parseHash(hash: string): string {
  const raw = hash.replace(/^#\/?/, "").toLowerCase();
  const redirected = REDIRECTS[raw] ?? raw;
  return viewMap.has(redirected) ? redirected : DEFAULT_VIEW;
}

// ─── Reactive State ─────────────────────────────────────────

const initialHash = typeof window !== "undefined" ? window.location.hash : "";
let currentViewName = $state(parseHash(initialHash));

/** The currently active view name (reactive) */
export function getCurrentView(): string {
  return currentViewName;
}

/** The full ViewDef for the current view (reactive) */
export function getCurrentViewDef(): ViewDef {
  return viewMap.get(currentViewName) ?? views[0];
}

/** Navigate to a view by name. Updates hash and reactive state. */
export function navigate(name: string): void {
  const resolved = REDIRECTS[name] ?? name;
  if (!viewMap.has(resolved)) return;
  currentViewName = resolved;
  const newHash = `#/${resolved}`;
  if (window.location.hash !== newHash) {
    window.location.hash = newHash;
  }
}

/** Look up a view definition by name */
export function getViewDef(name: string): ViewDef | undefined {
  return viewMap.get(name);
}

// ─── Hash Change Listener ───────────────────────────────────

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    currentViewName = parseHash(window.location.hash);
  });
}
