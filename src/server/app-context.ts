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
import type { BehaviorStore } from "./behavior-store.js";
import type { AppConfig } from "./config.js";
import { createMicroRunner, type MicroRunner, type ContextSources, type ReferenceEntry } from "./micro-runner.js";

// ─── App State ──────────────────────────────────────────────────

export interface AppState {
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  fleetStore: FleetStore | null;
  dockStore: DockStore | null;
  behaviorStore: BehaviorStore | null;
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

/**
 * Build a MicroRunner from current app state.
 *
 * Wires the fleet store into the MicroRunner's ContextSources so the
 * ContextGate can look up officers for T2 reference injection and the
 * PromptCompiler knows which officer names to match against.
 *
 * Returns null if the fleet store isn't available (MicroRunner is optional).
 */
export function buildMicroRunnerFromState(appState: AppState): MicroRunner | null {
  const fleetStore = appState.fleetStore;

  // Build context sources from current state
  const contextSources: ContextSources = {
    hasFleetConfig: !!appState.settingsStore,
    hasRoster: !!appState.fleetData,
    hasDockBriefing: !!appState.dockStore,
    lookupOfficer: fleetStore
      ? (name: string): ReferenceEntry | null => {
          // Search officers by name match
          const officers = fleetStore.listOfficers();
          const match = officers.find(
            (o) => o.name.toLowerCase() === name.toLowerCase(),
          );
          if (!match) return null;
          return {
            id: match.id,
            name: match.name,
            rarity: match.rarity,
            groupName: match.groupName,
            source: match.importedFrom ?? "fleet store",
            importedAt: match.createdAt,
          };
        }
      : undefined,
  };

  // Gather known officer names for the PromptCompiler's keyword matching
  const knownOfficerNames = fleetStore
    ? fleetStore.listOfficers().map((o) => o.name)
    : undefined;

  return createMicroRunner({ contextSources, knownOfficerNames, behaviorStore: appState.behaviorStore ?? undefined });
}
