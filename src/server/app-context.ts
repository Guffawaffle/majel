/**
 * app-context.ts — Shared types and configuration for the Majel server.
 *
 * Extracted from index.ts (ADR-005 Phase 2) to avoid circular dependencies
 * between the main app factory and route modules.
 */

import type { GeminiEngine, FleetConfig } from "./gemini.js";
import type { MemoryService } from "./memory.js";
import type { SettingsStore } from "./settings.js";
import type { SessionStore } from "./sessions.js";
import type { DockStore } from "./dock-store.js";
import type { BehaviorStore } from "./behavior-store.js";
import type { ReferenceStore } from "./reference-store.js";
import type { OverlayStore } from "./overlay-store.js";
import type { InviteStore } from "./invite-store.js";
import type { UserStore } from "./user-store.js";
import type { AppConfig } from "./config.js";
import type { Pool } from "./db.js";
import { createMicroRunner, type MicroRunner, type ContextSources, type ReferenceEntry } from "./micro-runner.js";

// ─── App State ──────────────────────────────────────────────────

export interface AppState {
  pool: Pool | null;
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  dockStore: DockStore | null;
  behaviorStore: BehaviorStore | null;
  referenceStore: ReferenceStore | null;
  overlayStore: OverlayStore | null;
  inviteStore: InviteStore | null;
  userStore: UserStore | null;
  startupComplete: boolean;
  config: AppConfig;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Read fleet config from the settings store for model context injection. */
export async function readFleetConfig(store: SettingsStore | null): Promise<FleetConfig | null> {
  if (!store) return null;
  return {
    opsLevel: await store.getTyped("fleet.opsLevel") as number,
    drydockCount: await store.getTyped("fleet.drydockCount") as number,
    shipHangarSlots: await store.getTyped("fleet.shipHangarSlots") as number,
  };
}

/** Build the dock briefing text for model context injection. Returns null if no docks configured. */
export async function readDockBriefing(dockStore: DockStore | null): Promise<string | null> {
  if (!dockStore) return null;
  const briefing = await dockStore.buildBriefing();
  return briefing.totalChars > 0 ? briefing.text : null;
}

/**
 * Build a MicroRunner from current app state.
 *
 * Wires the reference store into the MicroRunner's ContextSources so the
 * ContextGate can look up officers for T2 reference injection and the
 * PromptCompiler knows which officer names to match against.
 *
 * Returns null if the reference store isn't available (MicroRunner is optional).
 */
export async function buildMicroRunnerFromState(appState: AppState): Promise<MicroRunner | null> {
  const referenceStore = appState.referenceStore;

  // Pre-fetch officers into a Map for sync lookup (store methods are now async)
  const officerMap = new Map<string, ReferenceEntry>();
  let knownOfficerNames: string[] | undefined;
  if (referenceStore) {
    const refCounts = await referenceStore.counts();
    const allOfficers = refCounts.officers > 0 ? await referenceStore.listOfficers() : [];
    for (const o of allOfficers) {
      officerMap.set(o.name.toLowerCase(), {
        id: o.id,
        name: o.name,
        rarity: o.rarity,
        groupName: o.groupName,
        source: o.source,
        importedAt: o.createdAt,
      });
    }
    knownOfficerNames = allOfficers.map((o) => o.name);
  }

  // Build context sources from current state
  const contextSources: ContextSources = {
    hasFleetConfig: !!appState.settingsStore,
    hasRoster: officerMap.size > 0,
    hasDockBriefing: !!appState.dockStore,
    lookupOfficer: officerMap.size > 0
      ? (name: string): ReferenceEntry | null => {
          return officerMap.get(name.toLowerCase()) ?? null;
        }
      : undefined,
  };

  return createMicroRunner({ contextSources, knownOfficerNames, behaviorStore: appState.behaviorStore ?? undefined });
}
