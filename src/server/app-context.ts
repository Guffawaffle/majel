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
import type { DockStore } from "./dock-store.js";
import type { AppConfig } from "./config.js";

// ─── App State ──────────────────────────────────────────────────

export interface AppState {
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  fleetStore: FleetStore | null;
  dockStore: DockStore | null;
  fleetData: FleetData | null;
  rosterError: string | null;
  startupComplete: boolean;
  config: AppConfig;
}

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

/** Build the dock briefing text for model context injection. Returns null if no docks configured. */
export function readDockBriefing(dockStore: DockStore | null): string | null {
  if (!dockStore) return null;
  const briefing = dockStore.buildBriefing();
  return briefing.totalChars > 0 ? briefing.text : null;
}
