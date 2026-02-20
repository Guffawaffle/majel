/**
 * app-context.test.ts — App Context Helper Tests
 *
 * Tests readFleetConfig, readFleetConfigForUser, formatFleetConfigBlock,
 * and buildMicroRunnerFromState.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readFleetConfig,
  readFleetConfigForUser,
  formatFleetConfigBlock,
  buildMicroRunnerFromState,
} from "../src/server/app-context.js";
import { createSettingsStore } from "../src/server/stores/settings.js";
import { createUserSettingsStore } from "../src/server/stores/user-settings-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { makeState } from "./helpers/make-state.js";

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

// ─── #85 H3: Per-User Fleet Config ─────────────────────────

describe("readFleetConfigForUser", () => {
  it("returns null when userSettingsStore is null", async () => {
    const result = await readFleetConfigForUser(null, "user-1");
    expect(result).toBeNull();
  });

  it("returns system defaults when user has no overrides", async () => {
    await cleanDatabase(pool);
    const settingsStore = await createSettingsStore(pool);
    const userSettingsStore = await createUserSettingsStore(pool, undefined, settingsStore);
    const config = await readFleetConfigForUser(userSettingsStore, "00000000-0000-0000-0000-000000000001");
    expect(config).toBeDefined();
    expect(config).toHaveProperty("opsLevel");
    expect(config).toHaveProperty("drydockCount");
    expect(config).toHaveProperty("shipHangarSlots");
    expect(typeof config!.opsLevel).toBe("number");
  });

  it("returns user overrides when set", async () => {
    await cleanDatabase(pool);
    const settingsStore = await createSettingsStore(pool);
    const userSettingsStore = await createUserSettingsStore(pool, undefined, settingsStore);

    await userSettingsStore.setForUser("00000000-0000-0000-0000-000000000002", "fleet.opsLevel", "42");
    await userSettingsStore.setForUser("00000000-0000-0000-0000-000000000002", "fleet.drydockCount", "5");

    const config = await readFleetConfigForUser(userSettingsStore, "00000000-0000-0000-0000-000000000002");
    expect(config!.opsLevel).toBe(42);
    expect(config!.drydockCount).toBe(5);
    // shipHangarSlots not overridden → should be system default (a number)
    expect(typeof config!.shipHangarSlots).toBe("number");
  });

  it("gives different users different fleet configs", async () => {
    await cleanDatabase(pool);
    const settingsStore = await createSettingsStore(pool);
    const userSettingsStore = await createUserSettingsStore(pool, undefined, settingsStore);

    await userSettingsStore.setForUser("00000000-0000-0000-0000-000000000003", "fleet.opsLevel", "35");
    await userSettingsStore.setForUser("00000000-0000-0000-0000-000000000004", "fleet.opsLevel", "50");

    const configA = await readFleetConfigForUser(userSettingsStore, "00000000-0000-0000-0000-000000000003");
    const configB = await readFleetConfigForUser(userSettingsStore, "00000000-0000-0000-0000-000000000004");
    expect(configA!.opsLevel).toBe(35);
    expect(configB!.opsLevel).toBe(50);
  });
});

describe("formatFleetConfigBlock", () => {
  it("formats fleet config as labeled context block", () => {
    const block = formatFleetConfigBlock({ opsLevel: 40, drydockCount: 4, shipHangarSlots: 60 });
    expect(block).toContain("[FLEET CONFIG]");
    expect(block).toContain("[END FLEET CONFIG]");
    expect(block).toContain("Operations Level: 40");
    expect(block).toContain("Active Drydocks: 4");
    expect(block).toContain("Ship Hangar Slots: 60");
  });
});
