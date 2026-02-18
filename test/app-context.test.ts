/**
 * app-context.test.ts — App Context Helper Tests
 *
 * Tests readFleetConfig and buildMicroRunnerFromState.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFleetConfig, buildMicroRunnerFromState, type AppState } from "../src/server/app-context.js";
import { createSettingsStore } from "../src/server/stores/settings.js";
import { bootstrapConfigSync } from "../src/server/config.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

describe("readFleetConfig", () => {
  it("returns null when store is null", async () => {
    const result = await readFleetConfig(null);
    expect(result).toBeNull();
  });

  it("returns fleet config from settings store", async () => {
    await cleanDatabase(pool);
    const store = await createSettingsStore(pool);
    const config = await readFleetConfig(store);
    expect(config).toBeDefined();
    expect(config).toHaveProperty("opsLevel");
    expect(config).toHaveProperty("drydockCount");
    expect(config).toHaveProperty("shipHangarSlots");
    expect(typeof config!.opsLevel).toBe("number");
  });
});

describe("buildMicroRunnerFromState", () => {
  function makeState(overrides: Partial<AppState> = {}): AppState {
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
      inviteStore: null,
      userStore: null,
      targetStore: null,
      startupComplete: false,
      config: bootstrapConfigSync(),
      ...overrides,
    } as AppState;
  }

  it("returns a MicroRunner even without reference store", async () => {
    const runner = await buildMicroRunnerFromState(makeState());
    expect(runner).toBeDefined();
    expect(runner).not.toBeNull();
  });

  it("returns a MicroRunner with empty reference store", async () => {
    await cleanDatabase(pool);
    const { createReferenceStore } = await import("../src/server/stores/reference-store.js");
    const refStore = await createReferenceStore(pool);
    const runner = await buildMicroRunnerFromState(makeState({ referenceStore: refStore }));
    expect(runner).toBeDefined();
  });
});
