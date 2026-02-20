/**
 * Settings API — fleet and user settings.
 */

import type { SettingEntry } from "../types.js";
import { apiFetch, apiPatch, qs } from "./fetch.js";

/**
 * Persist a single fleet setting (key → value).
 * Throws ApiError on failure.
 */
export async function saveFleetSetting(key: string, value: string | number): Promise<void> {
  await apiPatch("/api/settings", { [key]: String(value) });
}

/**
 * Load all fleet-category settings.
 * Returns an empty array on failure.
 */
export async function loadFleetSettings(): Promise<SettingEntry[]> {
  try {
    const data = await apiFetch<{ settings: SettingEntry[] }>(
      `/api/settings${qs({ category: "fleet" })}`,
    );
    return data.settings ?? [];
  } catch {
    return [];
  }
}

/**
 * Load a single setting value, returning fallback on failure.
 */
export async function loadSetting(key: string, fallback = ""): Promise<string> {
  try {
    const data = await apiFetch<{ settings: SettingEntry[] }>("/api/settings");
    const entry = data.settings?.find((s) => s.key === key);
    return entry?.value ?? fallback;
  } catch {
    return fallback;
  }
}
