/**
 * gamedata-ingest.test.ts — Tests for CDN snapshot ingestion functions
 *
 * Covers: syncCdnResearch, syncCdnBuildings, syncCdnHostiles,
 *         syncCdnConsumables, syncCdnSystems, getCdnVersion
 */

import { describe, it, expect, vi } from "vitest";
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCdnVersion,
  syncCdnResearch,
  syncCdnBuildings,
  syncCdnHostiles,
  syncCdnConsumables,
  syncCdnSystems,
} from "../src/server/services/gamedata-ingest.js";
import type { ReferenceStore } from "../src/server/stores/reference-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

// ─── Helpers ────────────────────────────────────────────────

/** Check if the CDN snapshot directory exists. */
async function snapshotExists(entityType: string): Promise<boolean> {
  try {
    await access(join(snapshotDir, entityType, "summary.json"));
    return true;
  } catch {
    return false;
  }
}

/** Create a minimal mock reference store for testing sync functions. */
function createMockStore(): ReferenceStore {
  return {
    createOfficer: vi.fn().mockResolvedValue({}),
    getOfficer: vi.fn().mockResolvedValue(null),
    findOfficerByName: vi.fn().mockResolvedValue(null),
    listOfficers: vi.fn().mockResolvedValue([]),
    searchOfficers: vi.fn().mockResolvedValue([]),
    upsertOfficer: vi.fn().mockResolvedValue({}),
    deleteOfficer: vi.fn().mockResolvedValue(false),
    createShip: vi.fn().mockResolvedValue({}),
    getShip: vi.fn().mockResolvedValue(null),
    findShipByName: vi.fn().mockResolvedValue(null),
    listShips: vi.fn().mockResolvedValue([]),
    searchShips: vi.fn().mockResolvedValue([]),
    upsertShip: vi.fn().mockResolvedValue({}),
    deleteShip: vi.fn().mockResolvedValue(false),
    bulkUpsertOfficers: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertShips: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertResearch: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertBuildings: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertHostiles: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertConsumables: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    bulkUpsertSystems: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
    purgeLegacyEntries: vi.fn().mockResolvedValue({ ships: 0, officers: 0 }),
    getResearch: vi.fn().mockResolvedValue(null),
    searchResearch: vi.fn().mockResolvedValue([]),
    getBuilding: vi.fn().mockResolvedValue(null),
    searchBuildings: vi.fn().mockResolvedValue([]),
    getHostile: vi.fn().mockResolvedValue(null),
    searchHostiles: vi.fn().mockResolvedValue([]),
    getConsumable: vi.fn().mockResolvedValue(null),
    searchConsumables: vi.fn().mockResolvedValue([]),
    getSystem: vi.fn().mockResolvedValue(null),
    searchSystems: vi.fn().mockResolvedValue([]),
    counts: vi.fn().mockResolvedValue({
      officers: 0, ships: 0, research: 0, buildings: 0,
      hostiles: 0, consumables: 0, systems: 0,
    }),
    close: vi.fn(),
  };
}

// ─── getCdnVersion ──────────────────────────────────────────

describe("getCdnVersion", () => {
  it("returns a version string when snapshot exists", async () => {
    const version = await getCdnVersion();
    // If snapshot exists it should return a non-empty string;
    // if not available, null is acceptable
    if (version != null) {
      expect(typeof version).toBe("string");
      expect(version.length).toBeGreaterThan(0);
      // Must be a valid UUID (validation added for untrusted content safety)
      expect(version).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } else {
      expect(version).toBeNull();
    }
  });
});

// ─── syncCdnResearch ────────────────────────────────────────

describe("syncCdnResearch", () => {
  it("calls bulkUpsertResearch with mapped inputs when snapshot exists", async () => {
    const hasSnapshot = await snapshotExists("research");
    if (!hasSnapshot) return; // skip if no snapshot

    const store = createMockStore();
    (store.bulkUpsertResearch as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 100, updated: 0 });

    const result = await syncCdnResearch(store);

    expect(result.source).toBe("game-data-cdn");
    expect(result.research.total).toBeGreaterThan(0);
    expect(store.bulkUpsertResearch).toHaveBeenCalledTimes(1);

    // Verify inputs are properly structured
    const inputs = (store.bulkUpsertResearch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Array.isArray(inputs)).toBe(true);
    expect(inputs.length).toBeGreaterThan(0);

    const first = inputs[0];
    expect(first.id).toMatch(/^cdn:research:\d+$/);
    expect(typeof first.name).toBe("string");
    expect(first.source).toBe("cdn:game-data");
    expect(first.gameId).toBeTypeOf("number");
  });

  it("returns zero counts when snapshot is missing", async () => {
    // This test exercises the early-exit path. We can't easily remove
    // the snapshot, but if it IS missing the function should return gracefully.
    const hasSnapshot = await snapshotExists("research");
    if (hasSnapshot) return; // skip — we only test the missing path

    const store = createMockStore();
    const result = await syncCdnResearch(store);
    expect(result.research.total).toBe(0);
    expect(store.bulkUpsertResearch).not.toHaveBeenCalled();
  });
});

// ─── syncCdnBuildings ───────────────────────────────────────

describe("syncCdnBuildings", () => {
  it("calls bulkUpsertBuildings with mapped inputs when snapshot exists", async () => {
    const hasSnapshot = await snapshotExists("building");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertBuildings as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 50, updated: 0 });

    const result = await syncCdnBuildings(store);

    expect(result.source).toBe("game-data-cdn");
    expect(result.buildings.total).toBeGreaterThan(0);
    expect(store.bulkUpsertBuildings).toHaveBeenCalledTimes(1);

    const inputs = (store.bulkUpsertBuildings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inputs.length).toBeGreaterThan(0);

    const first = inputs[0];
    expect(first.id).toMatch(/^cdn:building:\d+$/);
    expect(typeof first.name).toBe("string");
    expect(first.source).toBe("cdn:game-data");
  });
});

// ─── syncCdnHostiles ───────────────────────────────────────

describe("syncCdnHostiles", () => {
  it("calls bulkUpsertHostiles with mapped inputs when snapshot exists", async () => {
    const hasSnapshot = await snapshotExists("hostile");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertHostiles as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 500, updated: 0 });

    const result = await syncCdnHostiles(store);

    expect(result.source).toBe("game-data-cdn");
    expect(result.hostiles.total).toBeGreaterThan(0);
    expect(store.bulkUpsertHostiles).toHaveBeenCalledTimes(1);

    const inputs = (store.bulkUpsertHostiles as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inputs.length).toBeGreaterThan(0);

    const first = inputs[0];
    expect(first.id).toMatch(/^cdn:hostile:\d+$/);
    expect(typeof first.name).toBe("string");
    expect(first.source).toBe("cdn:game-data");
    expect(first.gameId).toBeTypeOf("number");
  });
});

// ─── syncCdnConsumables ────────────────────────────────────

describe("syncCdnConsumables", () => {
  it("calls bulkUpsertConsumables with mapped inputs when snapshot exists", async () => {
    const hasSnapshot = await snapshotExists("consumable");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertConsumables as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 200, updated: 0 });

    const result = await syncCdnConsumables(store);

    expect(result.source).toBe("game-data-cdn");
    expect(result.consumables.total).toBeGreaterThan(0);
    expect(store.bulkUpsertConsumables).toHaveBeenCalledTimes(1);

    const inputs = (store.bulkUpsertConsumables as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inputs.length).toBeGreaterThan(0);

    const first = inputs[0];
    expect(first.id).toMatch(/^cdn:consumable:\d+$/);
    expect(typeof first.name).toBe("string");
    expect(first.source).toBe("cdn:game-data");
  });
});

// ─── syncCdnSystems ────────────────────────────────────────

describe("syncCdnSystems", () => {
  it("calls bulkUpsertSystems with mapped inputs when snapshot exists", async () => {
    const hasSnapshot = await snapshotExists("system");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 1000, updated: 0 });

    const result = await syncCdnSystems(store);

    expect(result.source).toBe("game-data-cdn");
    expect(result.systems.total).toBeGreaterThan(0);
    expect(store.bulkUpsertSystems).toHaveBeenCalledTimes(1);

    const inputs = (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inputs.length).toBeGreaterThan(0);

    const first = inputs[0];
    expect(first.id).toMatch(/^cdn:system:\d+$/);
    expect(typeof first.name).toBe("string");
    expect(first.source).toBe("cdn:game-data");
    expect(first.gameId).toBeTypeOf("number");
    expect(typeof first.level).toBe("number");
  });

  it("includes coordinate data in system inputs", async () => {
    const hasSnapshot = await snapshotExists("system");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 0, updated: 0 });

    await syncCdnSystems(store);

    const inputs = (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Find any system with coordinates
    const withCoords = inputs.find((s: { coordsX: number | null }) => s.coordsX != null);
    if (withCoords) {
      expect(typeof withCoords.coordsX).toBe("number");
      expect(typeof withCoords.coordsY).toBe("number");
    }
  });

  it("maps hostile count from system hostiles array length", async () => {
    const hasSnapshot = await snapshotExists("system");
    if (!hasSnapshot) return;

    const store = createMockStore();
    (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mockResolvedValue({ created: 0, updated: 0 });

    await syncCdnSystems(store);

    const inputs = (store.bulkUpsertSystems as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // hostileCount should be a number
    for (const sys of inputs.slice(0, 5)) {
      expect(typeof sys.hostileCount).toBe("number");
      expect(sys.hostileCount).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Snapshot Data Counts ───────────────────────────────────

describe("snapshot data coverage", () => {
  it("research snapshot contains 2000+ entries", async () => {
    const hasSnapshot = await snapshotExists("research");
    if (!hasSnapshot) return;

    const raw = await readFile(join(snapshotDir, "research", "summary.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(2000);
  });

  it("building snapshot contains 100+ entries", async () => {
    const hasSnapshot = await snapshotExists("building");
    if (!hasSnapshot) return;

    const raw = await readFile(join(snapshotDir, "building", "summary.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(100);
  });

  it("hostile snapshot contains 4000+ entries", async () => {
    const hasSnapshot = await snapshotExists("hostile");
    if (!hasSnapshot) return;

    const raw = await readFile(join(snapshotDir, "hostile", "summary.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(4000);
  });

  it("consumable snapshot contains 2000+ entries", async () => {
    const hasSnapshot = await snapshotExists("consumable");
    if (!hasSnapshot) return;

    const raw = await readFile(join(snapshotDir, "consumable", "summary.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(2000);
  });

  it("system snapshot contains 2000+ entries", async () => {
    const hasSnapshot = await snapshotExists("system");
    if (!hasSnapshot) return;

    const raw = await readFile(join(snapshotDir, "system", "summary.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(2000);
  });
});
