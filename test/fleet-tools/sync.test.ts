/**
 * fleet-tools/sync.test.ts — Sync mutation tests
 *
 * Tests for: sync_overlay, sync_research.
 *
 * Extracted from fleet-tools.test.ts (#193).
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockOverlayStore,
  createMockReferenceStore,
  createMockCrewStore,
  createMockReceiptStore,
  createMockResearchStore,
  FIXTURE_OFFICER,
  FIXTURE_SHIP,
} from "./helpers.js";

// ─── Overlay Sync Tool ──────────────────────────────────────

describe("sync_overlay", () => {
  it("returns error for unsupported export schema version", async () => {
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore(),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "2.0",
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(String(result.error)).toContain("Supported version is '1.0'");
  });

  it("warns when export date is stale", async () => {
    const staleDate = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        exportDate: staleDate,
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    const schema = result.schema as Record<string, unknown>;
    expect(schema.stale).toBe(true);
    expect(schema.importAgeDays).toBeGreaterThan(7);
    const warnings = result.warnings as string[];
    expect(warnings.some((w) => w.includes("stale"))).toBe(true);
  });

  it("returns dry-run diff summary without applying", async () => {
    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([
          {
            refId: "cdn:officer:100",
            ownershipState: "unowned",
            target: false,
            level: 20,
            rank: "2",
            power: 1000,
            targetNote: null,
            targetPriority: null,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        source: "manual",
        officers: [{ refId: "cdn:officer:100", level: 50, owned: true }],
        ships: [{ refId: "cdn:ship:200", tier: 8, owned: true }],
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.dryRun).toBe(true);
    const summary = result.summary as Record<string, unknown>;
    const officers = summary.officers as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(officers.changed).toBe(1);
    expect(ships.changed).toBe(1);
    expect(officers.applied).toBe(0);
    expect(ships.applied).toBe(0);
  });

  it("applies overlay updates when dry_run=false", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:100",
      ownershipState: "owned",
      target: false,
      level: 50,
      rank: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:200",
      ownershipState: "owned",
      target: false,
      tier: 8,
      level: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const createReceipt = vi.fn().mockResolvedValue({
      id: 42,
      sourceType: "guided_setup",
      sourceMeta: {},
      mapping: null,
      layer: "ownership",
      changeset: {},
      inverse: {},
      unresolved: null,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const createPlanItem = vi.fn().mockResolvedValue({
      id: 55,
      intentKey: null,
      label: "sync_overlay import",
      loadoutId: 20,
      variantId: null,
      dockNumber: 2,
      awayOfficers: null,
      priority: 0,
      isActive: true,
      source: "manual",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const updatePlanItem = vi.fn().mockResolvedValue({
      id: 10,
      intentKey: null,
      label: "Current Dock",
      loadoutId: 20,
      variantId: null,
      dockNumber: 1,
      awayOfficers: null,
      priority: 0,
      isActive: true,
      source: "manual",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([
          {
            id: 10,
            intentKey: null,
            label: "Current Dock",
            loadoutId: 10,
            variantId: null,
            dockNumber: 1,
            awayOfficers: null,
            priority: 0,
            isActive: true,
            source: "manual",
            notes: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        listLoadouts: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: 20,
              shipId: "cdn:ship:200",
              bridgeCoreId: null,
              belowDeckPolicyId: null,
              name: "Ship 200 Loadout",
              priority: 0,
              isActive: true,
              intentKeys: [],
              tags: [],
              notes: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 20,
              shipId: "cdn:ship:200",
              bridgeCoreId: null,
              belowDeckPolicyId: null,
              name: "Ship 200 Loadout",
              priority: 0,
              isActive: true,
              intentKeys: [],
              tags: [],
              notes: null,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]),
        createPlanItem,
        updatePlanItem,
      }),
      receiptStore: createMockReceiptStore({ createReceipt }),
    });

    const result = await executeFleetTool("sync_overlay", {
      payload_json: JSON.stringify({
        version: "1.0",
        officers: [{ refId: "100", owned: true, level: 50 }],
        ships: [{ refId: "200", owned: true, tier: 8 }],
        docks: [
          { number: 1, loadoutId: 20 },
          { number: 2, shipId: "200" },
        ],
      }),
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.dryRun).toBe(false);
    expect(setOfficerOverlay).toHaveBeenCalledTimes(1);
    expect(setShipOverlay).toHaveBeenCalledTimes(1);
    const summary = result.summary as Record<string, unknown>;
    const officers = summary.officers as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(officers.applied).toBe(1);
    expect(ships.applied).toBe(1);
    expect(createReceipt).toHaveBeenCalledTimes(1);
    const receipt = result.receipt as Record<string, unknown>;
    expect(receipt.created).toBe(true);
    expect(receipt.id).toBe(42);
    expect(updatePlanItem).toHaveBeenCalledTimes(1);
    expect(createPlanItem).toHaveBeenCalledTimes(1);
    const preview = result.changesPreview as Record<string, unknown>;
    const dockPreview = preview.docks as unknown[];
    expect(dockPreview.length).toBe(2);
  });

  it("supports manual free-text updates", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "ship-enterprise",
      ownershipState: "owned",
      target: false,
      tier: 7,
      level: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx = toolEnv({
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        searchOfficers: vi.fn().mockResolvedValue([]),
        searchShips: vi.fn().mockResolvedValue([FIXTURE_SHIP]),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["I upgraded my Enterprise to tier 7"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(1);
    const summary = result.summary as Record<string, unknown>;
    const ships = summary.ships as Record<string, unknown>;
    expect(ships.manualUpdates).toBe(1);
    expect(ships.applied).toBe(1);
  });

  it("supports bulk max ship updates with exceptions", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1",
      ownershipState: "owned",
      target: false,
      tier: 10,
      level: 45,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "USS Enterprise", maxTier: 10, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:2", name: "D'Vor", maxTier: 9, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:3", name: "Vi'Dar", maxTier: 8, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:4", name: "Sarcophagus", maxTier: 12, maxLevel: 45 },
    ];

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((ship) => ship.id === id) ?? null),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["Ok all of my ships except the D'Vor and Vi'Dar are max tier and level available to the ship"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(2);
    const calledRefIds = setShipOverlay.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).refId);
    expect(calledRefIds).toContain("cdn:ship:1");
    expect(calledRefIds).toContain("cdn:ship:4");
    expect(calledRefIds).not.toContain("cdn:ship:2");
    expect(calledRefIds).not.toContain("cdn:ship:3");

    // Verify written values match reference maxTier/maxLevel
    const enterpriseCall = setShipOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:ship:1");
    expect(enterpriseCall).toBeDefined();
    expect((enterpriseCall![0] as Record<string, unknown>).tier).toBe(10);
    expect((enterpriseCall![0] as Record<string, unknown>).level).toBe(45);
    expect((enterpriseCall![0] as Record<string, unknown>).ownershipState).toBe("owned");

    const sarcophagusCall = setShipOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:ship:4");
    expect(sarcophagusCall).toBeDefined();
    expect((sarcophagusCall![0] as Record<string, unknown>).tier).toBe(12);
    expect((sarcophagusCall![0] as Record<string, unknown>).level).toBe(45);
  });

  it("supports bulk max officer updates with exceptions", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:1",
      ownershipState: "owned",
      target: false,
      level: 50,
      rank: "5",
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const officers = [
      { ...FIXTURE_OFFICER, id: "cdn:officer:1", name: "Kirk", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:2", name: "Spock", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:3", name: "Bones", maxRank: 4 },
    ];

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue(officers),
        getOfficer: vi.fn().mockImplementation(async (id: string) => officers.find((officer) => officer.id === id) ?? null),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my officers except Spock are max rank and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setOfficerOverlay).toHaveBeenCalledTimes(2);
    const calledRefIds = setOfficerOverlay.mock.calls.map((call: unknown[]) => (call[0] as Record<string, unknown>).refId);
    expect(calledRefIds).toContain("cdn:officer:1");
    expect(calledRefIds).toContain("cdn:officer:3");
    expect(calledRefIds).not.toContain("cdn:officer:2");

    // Verify rank and level values from inferOfficerLevelFromMaxRank
    const kirkCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:1");
    expect(kirkCall).toBeDefined();
    expect((kirkCall![0] as Record<string, unknown>).rank).toBe("5");
    expect((kirkCall![0] as Record<string, unknown>).level).toBe(50);
    expect((kirkCall![0] as Record<string, unknown>).ownershipState).toBe("owned");

    const bonesCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:3");
    expect(bonesCall).toBeDefined();
    expect((bonesCall![0] as Record<string, unknown>).rank).toBe("4");
    expect((bonesCall![0] as Record<string, unknown>).level).toBe(40);
  });

  it("supports bulk max ship updates with no exceptions", async () => {
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:1",
      ownershipState: "owned",
      target: false,
      tier: 10,
      level: 45,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "USS Enterprise", maxTier: 10, maxLevel: 45 },
      { ...FIXTURE_SHIP, id: "cdn:ship:2", name: "D'Vor", maxTier: 9, maxLevel: 40 },
    ];

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((s) => s.id === id) ?? null),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my ships are max tier and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).toHaveBeenCalledTimes(2);
  });

  it("warns when bulk update excludes all entities", async () => {
    const setShipOverlay = vi.fn();

    const ships = [
      { ...FIXTURE_SHIP, id: "cdn:ship:1", name: "Enterprise", maxTier: 10, maxLevel: 45 },
    ];

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue(ships),
        getShip: vi.fn().mockImplementation(async (id: string) => ships.find((s) => s.id === id) ?? null),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my ships except Enterprise are max tier and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setShipOverlay).not.toHaveBeenCalled();
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("did not match any ships after exclusions"))).toBe(true);
  });

  it("handles officers with null maxRank in bulk update", async () => {
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:1",
      ownershipState: "owned",
      target: false,
      level: null,
      rank: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const officers = [
      { ...FIXTURE_OFFICER, id: "cdn:officer:1", name: "Kirk", maxRank: 5 },
      { ...FIXTURE_OFFICER, id: "cdn:officer:2", name: "Unknown Cadet", maxRank: null },
    ];

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
      }),
      referenceStore: createMockReferenceStore({
        listOfficers: vi.fn().mockResolvedValue(officers),
        getOfficer: vi.fn().mockImplementation(async (id: string) => officers.find((o) => o.id === id) ?? null),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: { version: "1.0" },
      manual_updates: ["all my officers are max rank and level"],
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(setOfficerOverlay).toHaveBeenCalledTimes(2);

    // Kirk should have rank/level from maxRank
    const kirkCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:1");
    expect(kirkCall).toBeDefined();
    expect((kirkCall![0] as Record<string, unknown>).rank).toBe("5");
    expect((kirkCall![0] as Record<string, unknown>).level).toBe(50);

    // Unknown Cadet should be owned but without rank/level
    const cadetCall = setOfficerOverlay.mock.calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).refId === "cdn:officer:2");
    expect(cadetCall).toBeDefined();
    expect((cadetCall![0] as Record<string, unknown>).level).toBeNull();

    // Should have a warning about missing max rank
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("Unknown Cadet") && w.includes("missing max rank"))).toBe(true);
  });

  it("accepts export object shaped exactly as declared schema (Gemini path)", async () => {
    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
    });

    // Shape matches exactly what Gemini would construct from the declared schema
    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        source: "screenshot",
        officers: [
          { refId: "cdn:officer:100", level: 45, rank: "3", owned: true, power: 5000 },
          { refId: "cdn:officer:200", level: 30, rank: "2", owned: true },
        ],
        ships: [
          { refId: "cdn:ship:300", tier: 7, level: 35, owned: true },
        ],
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.error).toBeUndefined();
    expect(result.dryRun).toBe(true);
    const summary = result.summary as Record<string, unknown>;
    const officersSummary = summary.officers as Record<string, unknown>;
    const shipsSummary = summary.ships as Record<string, unknown>;
    expect(officersSummary.input).toBe(2);
    expect(shipsSummary.input).toBe(1);
  });

  it("accepts export object with all three arrays (officers + ships + docks)", async () => {
    const createPlanItem = vi.fn().mockResolvedValue({
      id: 99,
      intentKey: null,
      label: "sync_overlay import",
      loadoutId: 20,
      variantId: null,
      dockNumber: 3,
      awayOfficers: null,
      priority: 0,
      isActive: true,
      source: "manual",
      notes: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const setOfficerOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:officer:100",
      ownershipState: "owned",
      target: false,
      level: 50,
      rank: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const setShipOverlay = vi.fn().mockResolvedValue({
      refId: "cdn:ship:200",
      ownershipState: "owned",
      target: false,
      tier: 8,
      level: null,
      power: null,
      targetNote: null,
      targetPriority: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
        setOfficerOverlay,
        setShipOverlay,
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
        getShip: vi.fn().mockResolvedValue(FIXTURE_SHIP),
      }),
      crewStore: createMockCrewStore({
        listPlanItems: vi.fn().mockResolvedValue([]),
        listLoadouts: vi.fn().mockResolvedValue([
          {
            id: 20,
            shipId: "cdn:ship:200",
            bridgeCoreId: null,
            belowDeckPolicyId: null,
            name: "Ship Loadout",
            priority: 0,
            isActive: true,
            intentKeys: [],
            tags: [],
            notes: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]),
        createPlanItem,
      }),
      receiptStore: createMockReceiptStore({
        createReceipt: vi.fn().mockResolvedValue({
          id: 42,
          sourceType: "guided_setup",
          sourceMeta: {},
          mapping: null,
          layer: "ownership",
          changeset: {},
          inverse: {},
          unresolved: null,
          createdAt: "2026-01-01T00:00:00Z",
        }),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        source: "csv-paste",
        officers: [{ refId: "cdn:officer:100", level: 50, owned: true }],
        ships: [{ refId: "cdn:ship:200", tier: 8, owned: true }],
        docks: [{ number: 3, shipId: "cdn:ship:200", loadoutId: 20 }],
      },
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.error).toBeUndefined();
    expect(result.dryRun).toBe(false);
    expect(setOfficerOverlay).toHaveBeenCalled();
    expect(setShipOverlay).toHaveBeenCalled();
    const summary = result.summary as Record<string, unknown>;
    const docksSummary = summary.docks as Record<string, unknown>;
    expect(docksSummary.changed).toBeGreaterThanOrEqual(1);
  });

  it("handles 30 officers in a single sync_overlay call (bulk scenario)", async () => {
    // Generate 30 officer entries — the exact scenario that motivated this change
    const officerEntries = Array.from({ length: 30 }, (_, i) => ({
      refId: `cdn:officer:${1000 + i}`,
      level: 10 + i,
      rank: String(Math.min(5, Math.floor(i / 6) + 1)),
      owned: true,
    }));

    const ctx = toolEnv({
      userId: "test-user",
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
      referenceStore: createMockReferenceStore({
        getOfficer: vi.fn().mockResolvedValue(FIXTURE_OFFICER),
      }),
    });

    const result = await executeFleetTool("sync_overlay", {
      export: {
        version: "1.0",
        source: "screenshot",
        officers: officerEntries,
      },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_overlay");
    expect(result.error).toBeUndefined();
    expect(result.dryRun).toBe(true);
    const summary = result.summary as Record<string, unknown>;
    const officersSummary = summary.officers as Record<string, unknown>;
    expect(officersSummary.input).toBe(30);
    expect(officersSummary.changed).toBe(30);
    expect(officersSummary.applied).toBe(0); // dry-run
  });
});

// ─── Research Sync Tool ─────────────────────────────────────

describe("sync_research", () => {
  const RESEARCH_EXPORT = {
    schema_version: "1.0",
    captured_at: "2026-02-18T00:00:00Z",
    source: "ripper-cc",
    nodes: [
      {
        node_id: "combat.weapon.damage.t4",
        tree: "combat",
        name: "Weapon Damage",
        max_level: 10,
        dependencies: [],
        buffs: [{ kind: "combat", metric: "weapon_damage", value: 0.15, unit: "percent" }],
      },
    ],
    state: [
      {
        node_id: "combat.weapon.damage.t4",
        level: 4,
        completed: false,
        updated_at: "2026-02-18T00:00:00Z",
      },
    ],
  };

  it("returns preview in dry-run mode by default", async () => {
    const replaceSnapshot = vi.fn();
    const ctx = toolEnv({
      researchStore: createMockResearchStore({ replaceSnapshot }),
    });

    const result = await executeFleetTool("sync_research", { export: RESEARCH_EXPORT }, ctx) as Record<string, unknown>;
    expect(result.tool).toBe("sync_research");
    expect(result.dryRun).toBe(true);
    expect(replaceSnapshot).not.toHaveBeenCalled();
    const summary = result.summary as Record<string, unknown>;
    expect(summary.nodes).toBe(1);
    expect(summary.trees).toBe(1);
  });

  it("applies snapshot when dry_run=false", async () => {
    const replaceSnapshot = vi.fn().mockResolvedValue({ nodes: 1, trees: 1 });
    const ctx = toolEnv({
      researchStore: createMockResearchStore({ replaceSnapshot }),
    });

    const result = await executeFleetTool("sync_research", {
      payload_json: JSON.stringify(RESEARCH_EXPORT),
      dry_run: false,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(result.dryRun).toBe(false);
    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
  });

  it("validates schema version", async () => {
    const ctx = toolEnv({
      researchStore: createMockResearchStore(),
    });
    const result = await executeFleetTool("sync_research", {
      export: { schema_version: "2.0", nodes: [], state: [] },
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("schema_version");
  });

  it("returns parse error for invalid payload_json", async () => {
    const ctx = toolEnv({
      researchStore: createMockResearchStore(),
    });
    const result = await executeFleetTool("sync_research", {
      payload_json: "{ not-json",
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("payload_json is not valid JSON");
  });

  it("validates node buff fields", async () => {
    const ctx = toolEnv({
      researchStore: createMockResearchStore(),
    });
    const invalidExport = {
      schema_version: "1.0",
      nodes: [
        {
          node_id: "combat.weapon",
          tree: "combat",
          name: "Weapon",
          max_level: 10,
          dependencies: [],
          buffs: [{ kind: "combat", metric: "weapon_damage", value: "bad", unit: "percent" }],
        },
      ],
      state: [{ node_id: "combat.weapon", level: 1, completed: false }],
    };

    const result = await executeFleetTool("sync_research", {
      export: invalidExport,
    }, ctx) as Record<string, unknown>;

    expect(result.tool).toBe("sync_research");
    expect(String(result.error)).toContain("invalid buff fields");
  });

  it("returns error when research store unavailable", async () => {
    const result = await executeFleetTool("sync_research", { export: RESEARCH_EXPORT }, {});
    expect(result).toHaveProperty("error");
  });
});
