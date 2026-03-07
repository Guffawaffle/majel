/**
 * resource-defs.test.ts — Tests for resource definition loader (Phase 1, #183)
 *
 * Covers:
 * - loadResourceDefs returns populated map from snapshot data
 * - deriveCategory covers all known mining categories
 * - resolveResourceId returns safe fallback for unknown IDs
 * - Golden three: G4 ore/gas/crystal resolve to correct names and categories
 * - Graceful degradation when files are missing
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  loadResourceDefs,
  deriveCategory,
  resolveResourceId,
  type ResourceDef,
} from "../src/server/services/resource-defs.js";

const SNAPSHOT_DIR = resolve(__dirname, "..", "data", ".stfc-snapshot");
const HAS_SNAPSHOT = existsSync(resolve(SNAPSHOT_DIR, "..", ".stfc-resources.json"));

// ─── Known G4 resource IDs (source of truth for golden tests) ───

const G4_ORE_RAW_ID = 802509572;
const G4_GAS_RAW_ID = 2964093937;
const G4_CRYSTAL_RAW_ID = 3735331456;

// ─── loadResourceDefs ───────────────────────────────────────

describe.skipIf(!HAS_SNAPSHOT)("loadResourceDefs", () => {
  it("loads all resource entries from snapshot", () => {
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    // .stfc-resources.json has 2,516 entries
    expect(defs.size).toBeGreaterThanOrEqual(2500);
  });

  it("resolves G4 Raw Ore to correct name and category", () => {
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    const ore = defs.get(G4_ORE_RAW_ID);
    expect(ore).toBeDefined();
    expect(ore!.name).toBe("4★ Raw Ore");
    expect(ore!.grade).toBe(4);
    expect(ore!.category).toBe("ore");
    expect(ore!.resourceKey).toBe("Resource_G4_Ore_Raw");
  });

  it("resolves G4 Raw Gas (Hydrocarbon) to correct name and category", () => {
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    const gas = defs.get(G4_GAS_RAW_ID);
    expect(gas).toBeDefined();
    expect(gas!.name).toBe("4★ Raw Gas");
    expect(gas!.grade).toBe(4);
    expect(gas!.category).toBe("gas");
    expect(gas!.resourceKey).toBe("Resource_G4_Hydrocarbon_Raw");
  });

  it("resolves G4 Raw Crystal to correct name and category", () => {
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    const crystal = defs.get(G4_CRYSTAL_RAW_ID);
    expect(crystal).toBeDefined();
    expect(crystal!.name).toBe("4★ Raw Crystal");
    expect(crystal!.grade).toBe(4);
    expect(crystal!.category).toBe("crystal");
    expect(crystal!.resourceKey).toBe("Resource_G4_Crystal_Raw");
  });

  it("returns empty map for missing snapshot dir", () => {
    const defs = loadResourceDefs("/nonexistent/path");
    expect(defs.size).toBe(0);
  });

  it("falls back to resourceKey when translation is missing", () => {
    // Pick any entry — verify name is never null/undefined
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    for (const [, def] of defs) {
      expect(def.name).toBeTruthy();
      expect(typeof def.name).toBe("string");
    }
  });
});

// ─── deriveCategory ─────────────────────────────────────────

describe("deriveCategory", () => {
  it("identifies ore resources", () => {
    expect(deriveCategory("Resource_G4_Ore_Raw")).toBe("ore");
    expect(deriveCategory("Resource_G3_Ore_Refined")).toBe("ore");
  });

  it("identifies gas (hydrocarbon) resources", () => {
    expect(deriveCategory("Resource_G4_Hydrocarbon_Raw")).toBe("gas");
    expect(deriveCategory("Resource_G3_Hydrocarbon_Refined")).toBe("gas");
  });

  it("identifies crystal resources", () => {
    expect(deriveCategory("Resource_G4_Crystal_Raw")).toBe("crystal");
    expect(deriveCategory("Resource_G3_Crystal_Refined")).toBe("crystal");
  });

  it("identifies currency resources", () => {
    expect(deriveCategory("Resource_Concentrated_Latinum")).toBe("currency");
  });

  it("returns 'other' for unrecognised patterns", () => {
    // GenericToken is a compound word — conservative derivation doesn't split it
    expect(deriveCategory("Resource_M76_GenericToken_1")).toBe("other");
    // ShipXP — _xp is not at a word boundary
    expect(deriveCategory("Resource_ShipXP")).toBe("other");
    expect(deriveCategory("Resource_CosmeticShard_USSTitan_Healing_ASA")).toBe("other");
  });

  it("is conservative — does not over-classify", () => {
    // 'Parts' in ship parts should NOT match mining parts without the _Raw suffix
    expect(deriveCategory("Resource_Dauntless_Parts_R1")).toBe("other");
  });
});

// ─── resolveResourceId ──────────────────────────────────────

describe("resolveResourceId", () => {
  const mockDefs = new Map<number, ResourceDef>([
    [2964093937, {
      gameId: 2964093937,
      resourceKey: "Resource_G4_Hydrocarbon_Raw",
      name: "4★ Raw Gas",
      grade: 4,
      rarity: 1,
      category: "gas",
      locaId: 12,
    }],
  ]);

  it("resolves known ID to human-readable object", () => {
    const resolved = resolveResourceId(2964093937, mockDefs);
    expect(resolved.name).toBe("4★ Raw Gas");
    expect(resolved.grade).toBe(4);
    expect(resolved.category).toBe("gas");
    expect(resolved.resourceKey).toBe("Resource_G4_Hydrocarbon_Raw");
  });

  it("returns safe fallback for unknown ID — never guesses", () => {
    const resolved = resolveResourceId(9999999, mockDefs);
    expect(resolved.name).toContain("Unknown resource");
    expect(resolved.grade).toBe(-1);
    expect(resolved.category).toBe("other");
  });
});

// ─── Golden query: "lowest warp G4 raw gas systems" ─────────
// End-to-end resolution chain: load real defs → resolve mine resource arrays
// → filter to G4 gas → sort by warp. No DB required — simulates store output.

describe.skipIf(!HAS_SNAPSHOT)("golden query: lowest warp G4 raw gas systems", () => {
  // Simulated reference_systems rows (mirrors DB JSONB shape)
  const fakeSystems = [
    { name: "Solari", estWarp: 42, mineResources: [{ id: G4_GAS_RAW_ID }, { id: G4_ORE_RAW_ID }] },
    { name: "Kelva",  estWarp: 18, mineResources: [{ id: G4_GAS_RAW_ID }] },
    { name: "Rigel",  estWarp: 55, mineResources: [{ id: G4_CRYSTAL_RAW_ID }] },
    { name: "Narwa",  estWarp: 30, mineResources: [{ id: G4_GAS_RAW_ID }, { id: G4_CRYSTAL_RAW_ID }] },
    { name: "Empty",  estWarp: 5,  mineResources: [] },
  ];

  it("returns sorted G4 gas systems with warp values, no prose", () => {
    const defs = loadResourceDefs(SNAPSHOT_DIR);
    expect(defs.size).toBeGreaterThan(0);

    // Resolve + filter: only systems containing G4 raw gas
    const g4GasSystems = fakeSystems
      .filter((sys) =>
        sys.mineResources.some((r) => {
          const resolved = resolveResourceId(r.id, defs);
          return resolved.category === "gas" && resolved.grade === 4;
        }),
      )
      .sort((a, b) => a.estWarp - b.estWarp)
      .map((sys) => ({
        name: sys.name,
        warp: sys.estWarp,
        resources: sys.mineResources.map((r) => resolveResourceId(r.id, defs)),
      }));

    // Assertions: correct systems, correct order, correct values
    expect(g4GasSystems).toHaveLength(3);
    expect(g4GasSystems.map((s) => s.name)).toEqual(["Kelva", "Narwa", "Solari"]);
    expect(g4GasSystems.map((s) => s.warp)).toEqual([18, 30, 42]);

    // Every result includes the resolved gas resource
    for (const sys of g4GasSystems) {
      const gasResource = sys.resources.find((r) => r.category === "gas");
      expect(gasResource).toBeDefined();
      expect(gasResource!.name).toBe("4★ Raw Gas");
      expect(gasResource!.grade).toBe(4);
    }

    // Rigel (crystal only) and Empty (no resources) are excluded
    expect(g4GasSystems.find((s) => s.name === "Rigel")).toBeUndefined();
    expect(g4GasSystems.find((s) => s.name === "Empty")).toBeUndefined();
  });
});

// ─── Guardrail path ─────────────────────────────────────────

describe("guardrail: resolveResourceId with empty defs", () => {
  const emptyDefs = new Map<number, ResourceDef>();

  it("returns fallback for any ID when defs map is empty", () => {
    const resolved = resolveResourceId(G4_GAS_RAW_ID, emptyDefs);
    expect(resolved.name).toContain("Unknown resource");
    expect(resolved.grade).toBe(-1);
    expect(resolved.category).toBe("other");
    expect(resolved.id).toBe(G4_GAS_RAW_ID);
  });

  it("resolveResourceId never throws for any input", () => {
    expect(() => resolveResourceId(0, emptyDefs)).not.toThrow();
    expect(() => resolveResourceId(-1, emptyDefs)).not.toThrow();
    expect(() => resolveResourceId(Number.MAX_SAFE_INTEGER, emptyDefs)).not.toThrow();
  });
});
