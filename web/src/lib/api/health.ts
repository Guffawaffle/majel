/**
 * Health API — system health check.
 */

import type { HealthResponse } from "../types.js";
import { apiFetch } from "./fetch.js";

/** Ping the health endpoint. Returns null on failure. */
export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    return await apiFetch<HealthResponse>("/api/health");
  } catch {
    return null;
  }
}
