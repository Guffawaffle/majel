/**
 * Settings API — fleet and user settings.
 */

import type { SettingEntry } from "../types.js";
import { apiFetch, apiPatch, qs } from "./fetch.js";
import { cachedFetch, invalidateForMutation } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";

/**
 * Persist a single fleet setting (key → value).
 * Throws ApiError on failure.
 */
export async function saveFleetSetting(key: string, value: string | number): Promise<void> {
  await apiPatch("/api/settings", { [key]: String(value) });
  await invalidateForMutation("fleet-setting");
}

/**
 * Load all fleet-category settings.
 * Returns an empty array on failure.
 */
export async function loadFleetSettings(): Promise<SettingEntry[]> {
  try {
    const key = cacheKey("/api/settings", { category: "fleet" });
    const result = await cachedFetch<SettingEntry[]>(
      key,
      async () => {
        const data = await apiFetch<{ settings: SettingEntry[] }>(
          `/api/settings${qs({ category: "fleet" })}`,
        );
        return data.settings ?? [];
      },
      TTL.COMPOSITION,
    );
    return result.data;
  } catch {
    return [];
  }
}

/**
 * Load a single setting value, returning fallback on failure.
 */
export async function loadSetting(key: string, fallback = ""): Promise<string> {
  try {
    const k = cacheKey("/api/settings");
    const result = await cachedFetch<SettingEntry[]>(
      k,
      async () => {
        const data = await apiFetch<{ settings: SettingEntry[] }>("/api/settings");
        return data.settings ?? [];
      },
      TTL.COMPOSITION,
    );
    const entry = result.data.find((s) => s.key === key);
    return entry?.value ?? fallback;
  } catch {
    return fallback;
  }
}
