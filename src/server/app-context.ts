/**
 * app-context.ts — Shared types and configuration for the Majel server.
 *
 * Extracted from index.ts (ADR-005 Phase 2) to avoid circular dependencies
 * between the main app factory and route modules.
 */

import type { GeminiEngine, FleetConfig } from "./gemini.js";
import type { MemoryService } from "./memory.js";
import type { FleetData } from "./fleet-data.js";
import type { SettingsStore } from "./settings.js";
import type { SessionStore } from "./sessions.js";
import type { FleetStore } from "./fleet-store.js";

// ─── App State ──────────────────────────────────────────────────

export interface AppState {
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  fleetStore: FleetStore | null;
  fleetData: FleetData | null;
  rosterError: string | null;
  startupComplete: boolean;
}

// ─── Configuration Constants ────────────────────────────────────

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const SPREADSHEET_ID = process.env.MAJEL_SPREADSHEET_ID || "";
export const SHEET_RANGE = process.env.MAJEL_SHEET_RANGE || "Sheet1!A:Z";
export const TAB_MAPPING_ENV = process.env.MAJEL_TAB_MAPPING || "";

// ─── Helpers ────────────────────────────────────────────────────

/** Read fleet config from the settings store for model context injection. */
export function readFleetConfig(store: SettingsStore | null): FleetConfig | null {
  if (!store) return null;
  return {
    opsLevel: store.getTyped("fleet.opsLevel") as number,
    drydockCount: store.getTyped("fleet.drydockCount") as number,
    shipHangarSlots: store.getTyped("fleet.shipHangarSlots") as number,
  };
}
