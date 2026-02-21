import { apiFetch, apiPut } from "./fetch.js";
import type { SettingEntry } from "../types.js";

export async function loadUserSetting(key: string, fallback = ""): Promise<string> {
  try {
    const data = await apiFetch<{ settings: SettingEntry[] }>("/api/user-settings");
    const entry = data.settings?.find((setting) => setting.key === key);
    return entry?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function saveUserSetting(key: string, value: string | number): Promise<void> {
  await apiPut(`/api/user-settings/${encodeURIComponent(key)}`, {
    value: String(value),
  });
}