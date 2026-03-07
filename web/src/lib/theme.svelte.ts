/**
 * theme.svelte.ts — Reactive theme state with user-settings persistence.
 *
 * Themes:
 *   "dark"  — clean dark UI
 *   "lcars" — LCARS visual treatment
 *
 * Default:
 *   "lcars" — primary theme unless user preference overrides it
 */

import { loadUserSetting, saveUserSetting } from "./api/user-settings.js";

export type Theme = "dark" | "lcars";
const VALID_THEMES: ReadonlySet<string> = new Set(["dark", "lcars"]);
const SETTING_KEY = "display.theme";

let currentTheme: Theme = $state("lcars");

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = theme;
  applyTheme(theme);
  saveUserSetting(SETTING_KEY, theme).catch(() => {
    // Non-fatal — offline/error modes.
  });
}

export function toggleTheme(): void {
  setTheme(currentTheme === "lcars" ? "dark" : "lcars");
}

/** Load persisted theme from user settings; call during boot. */
export async function loadTheme(): Promise<void> {
  const stored = await loadUserSetting(SETTING_KEY, "lcars");
  const theme = VALID_THEMES.has(stored) ? (stored as Theme) : "lcars";
  currentTheme = theme;
  applyTheme(theme);
}

/** Apply the data-theme attribute to the document root. */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
