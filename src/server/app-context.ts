/**
 * app-context.ts — Shared types and configuration for the Majel server.
 *
 * Extracted from index.ts (ADR-005 Phase 2) to avoid circular dependencies
 * between the main app factory and route modules.
 */

import type { GeminiEngine, FleetConfig, IntentConfig, IntentMode } from "./services/gemini/index.js";
import type { MemoryService } from "./services/memory.js";
import type { FrameStoreFactory } from "./stores/postgres-frame-store.js";
import type { SettingsStore } from "./stores/settings.js";
import type { SessionStore } from "./sessions.js";
import type { CrewStore, CrewStoreFactory } from "./stores/crew-store.js";
import type { ReceiptStore, ReceiptStoreFactory } from "./stores/receipt-store.js";
import type { BehaviorStore } from "./stores/behavior-store.js";
import type { ReferenceStore } from "./stores/reference-store.js";
import type { OverlayStore, OverlayStoreFactory } from "./stores/overlay-store.js";
import type { InviteStore } from "./stores/invite-store.js";
import type { UserStore } from "./stores/user-store.js";
import type { TargetStore, TargetStoreFactory } from "./stores/target-store.js";
import type { AuditStore } from "./stores/audit-store.js";
import type { UserSettingsStore } from "./stores/user-settings-store.js";
import type { ResearchStore, ResearchStoreFactory } from "./stores/research-store.js";
import type { InventoryStore, InventoryStoreFactory } from "./stores/inventory-store.js";
import type { ProposalStore, ProposalStoreFactory } from "./stores/proposal-store.js";
import type { ToolContextFactory } from "./services/fleet-tools/index.js";
import type { AppConfig } from "./config.js";
import type { Pool } from "./db.js";
import { createMicroRunner, type MicroRunner, type ContextSources, type ReferenceEntry } from "./services/micro-runner.js";

function toIntentMode(value: string): IntentMode {
  return value === "+" || value === "-" || value === "off" ? value : "-";
}

// ─── App State ──────────────────────────────────────────────────

export interface AppState {
  /** Admin pool (superuser) — DDL/schema only, closed after boot. */
  adminPool: Pool | null;
  /** App pool (non-superuser) — all runtime queries, RLS enforced (#39). */
  pool: Pool | null;
  geminiEngine: GeminiEngine | null;
  memoryService: MemoryService | null;
  /** ADR-021: Factory that creates per-user RLS-scoped FrameStores. */
  frameStoreFactory: FrameStoreFactory | null;
  settingsStore: SettingsStore | null;
  sessionStore: SessionStore | null;
  /** ADR-025: Unified crew composition store (replaces dock + loadout stores). */
  crewStore: CrewStore | null;
  /** #94: Factory that creates per-user RLS-scoped CrewStores. */
  crewStoreFactory: CrewStoreFactory | null;
  /** ADR-026: Import receipt audit trail + undo. */
  receiptStore: ReceiptStore | null;
  /** #94: Factory that creates per-user RLS-scoped ReceiptStores. */
  receiptStoreFactory: ReceiptStoreFactory | null;
  behaviorStore: BehaviorStore | null;
  referenceStore: ReferenceStore | null;
  overlayStore: OverlayStore | null;
  /** #85: Factory that creates per-user RLS-scoped OverlayStores. */
  overlayStoreFactory: OverlayStoreFactory | null;
  inviteStore: InviteStore | null;
  userStore: UserStore | null;
  targetStore: TargetStore | null;
  /** #85: Factory that creates per-user RLS-scoped TargetStores. */
  targetStoreFactory: TargetStoreFactory | null;
  /** #91 Phase A: Append-only audit log for auth events. */
  auditStore: AuditStore | null;
  /** #86: Per-user settings overrides. */
  userSettingsStore: UserSettingsStore | null;
  /** ADR-028 Phase 2: Per-user research tree state. */
  researchStore: ResearchStore | null;
  /** Factory that creates per-user RLS-scoped ResearchStores. */
  researchStoreFactory: ResearchStoreFactory | null;
  /** ADR-028 Phase 3: Per-user inventory state. */
  inventoryStore: InventoryStore | null;
  /** Factory that creates per-user RLS-scoped InventoryStores. */
  inventoryStoreFactory: InventoryStoreFactory | null;
  /** ADR-026b #93: Mutation proposal store. */
  proposalStore: ProposalStore | null;
  /** #93: Factory for per-user proposal stores. */
  proposalStoreFactory: ProposalStoreFactory | null;
  /** #93: Factory for per-user tool contexts. */
  toolContextFactory: ToolContextFactory | null;
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

/**
 * Read fleet config for a specific user (#85 H3).
 *
 * Resolution: user settings override → system default → schema default.
 * This ensures the system prompt and per-message context reflect each user's
 * actual game state rather than the global system-level defaults.
 */
export async function readFleetConfigForUser(
  userSettingsStore: UserSettingsStore | null,
  userId: string,
): Promise<FleetConfig | null> {
  if (!userSettingsStore) return null;
  const [opsEntry, dockEntry, hangarEntry] = await Promise.all([
    userSettingsStore.getForUser(userId, "fleet.opsLevel"),
    userSettingsStore.getForUser(userId, "fleet.drydockCount"),
    userSettingsStore.getForUser(userId, "fleet.shipHangarSlots"),
  ]);
  return {
    opsLevel: Number(opsEntry.value),
    drydockCount: Number(dockEntry.value),
    shipHangarSlots: Number(hangarEntry.value),
  };
}

/**
 * Format a FleetConfig as a labeled context block for per-message injection (#85 H3).
 * This block is prepended to the user's message so the model sees the user's
 * fleet configuration without it being baked into the static system prompt.
 */
export function formatFleetConfigBlock(config: FleetConfig): string {
  return `[FLEET CONFIG]
Operations Level: ${config.opsLevel}
Active Drydocks: ${config.drydockCount}
Ship Hangar Slots: ${config.shipHangarSlots}
[END FLEET CONFIG]`;
}

/** Read per-user intent configuration for chat-time modulation (#90). */
export async function readIntentConfigForUser(
  userSettingsStore: UserSettingsStore | null,
  userId: string,
): Promise<IntentConfig | null> {
  if (!userSettingsStore) return null;
  const [humor, lore, verbosity, confirmation, proactive, formality] = await Promise.all([
    userSettingsStore.getForUser(userId, "intent.humor"),
    userSettingsStore.getForUser(userId, "intent.lore"),
    userSettingsStore.getForUser(userId, "intent.verbosity"),
    userSettingsStore.getForUser(userId, "intent.confirmation"),
    userSettingsStore.getForUser(userId, "intent.proactive"),
    userSettingsStore.getForUser(userId, "intent.formality"),
  ]);

  return {
    humor: toIntentMode(humor.value),
    lore: toIntentMode(lore.value),
    verbosity: toIntentMode(verbosity.value),
    confirmation: toIntentMode(confirmation.value),
    proactive: toIntentMode(proactive.value),
    formality: toIntentMode(formality.value),
  };
}

/** Format an IntentConfig as a labeled context block for per-message injection (#90). */
export function formatIntentConfigBlock(config: IntentConfig): string {
  return `[INTENT CONFIG]
humor: ${config.humor}
lore: ${config.lore}
verbosity: ${config.verbosity}
confirmation: ${config.confirmation}
proactive: ${config.proactive}
formality: ${config.formality}
[END INTENT CONFIG]`;
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
    hasDockBriefing: !!appState.crewStore,
    lookupOfficer: officerMap.size > 0
      ? (name: string): ReferenceEntry | null => {
          return officerMap.get(name.toLowerCase()) ?? null;
        }
      : undefined,
  };

  return createMicroRunner({ contextSources, knownOfficerNames, behaviorStore: appState.behaviorStore ?? undefined });
}
