import { apiFetch, apiPut } from "./fetch.js";
import type { SettingEntry } from "../types.js";
import { cachedFetch } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import { runLockedMutation } from "./mutation.js";

export async function loadUserSetting(key: string, fallback = ""): Promise<string> {
  try {
    const k = cacheKey("/api/user-settings");
    const result = await cachedFetch<SettingEntry[]>(
      k,
      async () => {
        const data = await apiFetch<{ settings: SettingEntry[] }>("/api/user-settings");
        return data.settings ?? [];
      },
      TTL.COMPOSITION,
    );
    const entry = result.data.find((setting) => setting.key === key);
    return entry?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function saveUserSetting(key: string, value: string | number): Promise<void> {
  const path = `/api/user-settings/${encodeURIComponent(key)}`;
  const body = { value: String(value) };
  await runLockedMutation({
    label: `Save user setting ${key}`,
    lockKey: `user-setting:${key}`,
    mutationKey: "user-setting",
    queueOnNetworkError: true,
    replayIntent: {
      label: `Save user setting ${key}`,
      lockKey: `user-setting:${key}`,
      method: "PUT",
      path,
      body,
      mutationKey: "user-setting",
    },
    mutate: async () => {
      await apiPut(path, body);
    },
  });
}