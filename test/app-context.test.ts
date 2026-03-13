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
  formatProgressionBriefBlock,
  buildMicroRunnerFromState,
} from "../src/server/app-context.js";
import type { ProgressionContextV1 } from "../src/server/services/progression-context.js";
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

// ─── ADR-044 Phase 2: Progression Brief ────────────────────

function fullCtx(overrides?: Partial<ProgressionContextV1>): ProgressionContextV1 {
  return {
    opsLevel: 30,
    drydockCount: 4,
    ownedOfficerCount: 45,
    ownedShipCount: 12,
    loadoutCount: 3,
    activeTargetCount: 2,
    factionStandings: [],
    researchSummary: { completedNodes: 120, totalNodes: 350, pct: 34 },
    nextOpsBoundary: { level: 32, buildings: [{ name: "Academy", maxLevel: 80 }], buildingCount: 1 },
    intentCoverage: { covered: ["mining-gas", "pvp", "armada"], uncovered: ["grinding"] },
    dataQuality: {
      hasBuildingData: true,
      hasResearchData: true,
      hasInventoryData: true,
      hasFactionData: true,
      opsLevelIsDefault: false,
    },
    ...overrides,
  };
}

describe("formatProgressionBriefBlock", () => {
  it("formats a full context as labeled block", () => {
    const block = formatProgressionBriefBlock(fullCtx());
    expect(block).toContain("[PROGRESSION BRIEF]");
    expect(block).toContain("[END PROGRESSION BRIEF]");
    expect(block).toContain("Fleet: 45 officers, 12 ships, 3 loadouts, 2 active targets");
    expect(block).toContain("Research: 34% (120/350 nodes)");
    expect(block).toContain("Intent coverage: mining-gas, pvp, armada");
    expect(block).toContain("Next unlock: Ops 32");
    expect(block).not.toContain("Gaps:");
  });

  it("omits research line when researchSummary is null", () => {
    const block = formatProgressionBriefBlock(fullCtx({ researchSummary: null }));
    expect(block).not.toContain("Research:");
  });

  it("shows 'none' for intent coverage when no intents covered", () => {
    const block = formatProgressionBriefBlock(fullCtx({ intentCoverage: { covered: [], uncovered: ["grinding"] } }));
    expect(block).toContain("Intent coverage: none");
  });

  it("omits next unlock line when nextOpsBoundary is null", () => {
    const block = formatProgressionBriefBlock(fullCtx({ nextOpsBoundary: null }));
    expect(block).not.toContain("Next unlock:");
  });

  it("omits gaps line when all data quality flags are healthy", () => {
    const block = formatProgressionBriefBlock(fullCtx());
    expect(block).not.toContain("Gaps:");
  });

  it("renders gaps line for opsLevelIsDefault", () => {
    const block = formatProgressionBriefBlock(fullCtx({
      dataQuality: { hasBuildingData: true, hasResearchData: true, hasInventoryData: true, hasFactionData: true, opsLevelIsDefault: true },
    }));
    expect(block).toContain("Gaps: ops level is default");
  });

  it("renders multiple gaps separated by comma", () => {
    const block = formatProgressionBriefBlock(fullCtx({
      dataQuality: { hasBuildingData: false, hasResearchData: false, hasInventoryData: true, hasFactionData: true, opsLevelIsDefault: false },
    }));
    expect(block).toContain("Gaps: no building data, no research synced");
  });

  it("renders all five gap phrases when everything is missing", () => {
    const block = formatProgressionBriefBlock(fullCtx({
      dataQuality: { hasBuildingData: false, hasResearchData: false, hasInventoryData: false, hasFactionData: false, opsLevelIsDefault: true },
    }));
    expect(block).toContain("Gaps:");
    expect(block).toContain("ops level is default");
    expect(block).toContain("no building data");
    expect(block).toContain("no research synced");
    expect(block).toContain("no inventory synced");
    expect(block).toContain("no faction data");
  });
});
