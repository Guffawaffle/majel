/**
 * make-state.ts — Shared AppState factory for tests (#91 Phase F)
 *
 * Single source of truth for the default test AppState.
 * When new fields are added to AppState, update this ONE file.
 *
 * Usage:
 *   import { makeState } from './helpers/make-state.js';
 *   const state = makeState({ geminiEngine: mockEngine });
 */

import { type AppState } from "../../src/server/app-context.js";
import { bootstrapConfigSync, type AppConfig } from "../../src/server/config.js";

/**
 * Build a complete AppState with all stores defaulted to null.
 * Tests that need auth explicitly override config.
 */
export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    adminPool: null,
    pool: null,
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    crewStore: null,
    receiptStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    overlayStoreFactory: null,
    inviteStore: null,
    userStore: null,
    targetStore: null,
    targetStoreFactory: null,
    auditStore: null,
    startupComplete: false,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

/**
 * Build a test AppConfig with overrides.
 * Base config comes from bootstrapConfigSync() (env-cleared by vitest.config.ts).
 */
export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...bootstrapConfigSync(),
    ...overrides,
  };
}

/**
 * Like makeState but with startupComplete: true.
 * Use for route tests that need the startup gate to pass.
 */
export function makeReadyState(overrides: Partial<AppState> = {}): AppState {
  return makeState({ startupComplete: true, ...overrides });
}
