/**
 * fleet-tools/suggest-targets.test.ts — Tests for suggest_targets tool
 *
 * Covers: suggest_targets, suggest_targets — Ready to Upgrade
 */

import { describe, it, expect, vi } from "vitest";
import {
  executeFleetTool,
  toolEnv,
  createMockReferenceStore,
  createMockOverlayStore,
  createMockCrewStore,
  createMockTargetStore,
  createMockInventoryStore,
  createMockUserSettingsStore,
  FIXTURE_OFFICER_OVERLAY,
  FIXTURE_SHIP,
  FIXTURE_SHIP_OVERLAY,
} from "./helpers.js";

describe("suggest_targets", () => {
  it("gathers comprehensive fleet state for suggestions", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_OFFICER_OVERLAY]) // owned officers
          .mockResolvedValueOnce([FIXTURE_OFFICER_OVERLAY]), // targeted overlay officers
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY]) // owned ships
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY]), // targeted overlay ships
      }),
      crewStore: createMockCrewStore({
        listLoadouts: vi.fn().mockResolvedValue([{
          id: 10, name: "Kirk Crew", shipId: "ship-enterprise",
          isActive: true, intentKeys: ["pvp"],
        }]),
      }),
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([{
          id: 1,
          targetType: "officer",
          refId: "officer-spock",
          loadoutId: null,
          reason: "Need for science team",
          priority: 2,
        }]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Catalog size
    expect(result.catalogSize).toEqual({ officers: 42, ships: 18 });

    // Owned officers
    const officers = result.ownedOfficers as Array<Record<string, unknown>>;
    expect(officers).toHaveLength(1);
    expect(officers[0].name).toBe("James T. Kirk");
    expect(officers[0].captainManeuver).toBe("Inspirational");

    // Owned ships
    const ships = result.ownedShips as Array<Record<string, unknown>>;
    expect(ships).toHaveLength(1);
    expect(ships[0].name).toBe("USS Enterprise");

    // Loadouts
    const loadouts = result.loadouts as Array<Record<string, unknown>>;
    expect(loadouts).toHaveLength(1);
    expect(loadouts[0].name).toBe("Kirk Crew");

    // Existing targets
    const targets = result.existingTargets as Array<Record<string, unknown>>;
    expect(targets).toHaveLength(1);
    expect(targets[0].refId).toBe("officer-spock");

    // Officer conflicts
    const conflicts = result.officerConflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].officerId).toBe("officer-kirk");
    expect(conflicts[0].locationCount).toBe(2);

    // Overlay targets
    expect(result.overlayTargets).toEqual({ officers: 1, ships: 1 });
  });

  it("works with minimal context (no stores)", async () => {
    const result = await executeFleetTool("suggest_targets", {}, toolEnv()) as Record<string, unknown>;
    // Should return empty object, no errors
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("error");
  });

  it("works with only reference store", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
    });
    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    expect(result.catalogSize).toEqual({ officers: 42, ships: 18 });
    expect(result).not.toHaveProperty("ownedOfficers");
    expect(result).not.toHaveProperty("loadouts");
  });

  it("works with only target store", async () => {
    const ctx = toolEnv({
      targetStore: createMockTargetStore({
        list: vi.fn().mockResolvedValue([]),
      }),
    });
    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    expect(result.existingTargets).toEqual([]);
    expect(result).not.toHaveProperty("catalogSize");
  });

  it("adds faction-gated store recommendations from faction standings", async () => {
    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore: createMockUserSettingsStore(),
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY])
          .mockResolvedValueOnce([]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    const recommendations = result.storeRecommendations as Record<string, unknown>;
    expect(recommendations).toBeDefined();

    const blocked = recommendations.blockedByFactionAccess as Array<Record<string, unknown>>;
    expect(blocked).toHaveLength(1);
    expect(blocked[0].shipName).toBe("USS Enterprise");
    expect(blocked[0].faction).toBe("Federation");
    expect(blocked[0].reason).toBe("faction_store_access_insufficient");
  });

  it("marks ship store recommendation eligible when faction access is open", async () => {
    const userSettingsStore = createMockUserSettingsStore({
      getForUser: vi.fn().mockImplementation(async (_userId: string, key: string) => {
        if (key === "fleet.factionStandings") {
          return {
            key,
            value: JSON.stringify({ Federation: { reputation: 15000000, tier: "Celebrated" } }),
            source: "user" as const,
          };
        }
        return { key, value: "[]", source: "default" as const };
      }),
    });

    const ctx = toolEnv({
      userId: "00000000-0000-0000-0000-000000000001",
      userSettingsStore,
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([FIXTURE_SHIP_OVERLAY])
          .mockResolvedValueOnce([]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;
    const recommendations = result.storeRecommendations as Record<string, unknown>;
    const eligible = recommendations.eligibleBlueprintAccess as Array<Record<string, unknown>>;
    expect(eligible).toHaveLength(1);
    expect(eligible[0].shipName).toBe("USS Enterprise");
    expect(eligible[0].access).toBe("open");
  });
});


describe("suggest_targets — Ready to Upgrade", () => {
  it("includes readyToUpgrade when ship has ≥80% resource coverage", async () => {
    const shipWithTiers: ReferenceShip = {
      ...FIXTURE_SHIP,
      id: "cdn:ship:enterprise",
      name: "USS Enterprise",
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 300, name: "3★ Ore" }] },
            { build_cost: [{ resource_id: 102, amount: 100, name: "3★ Crystal" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ownedOverlay = { refId: "cdn:ship:enterprise", ownershipState: "owned", tier: 5 };

    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue([shipWithTiers]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([ownedOverlay])  // 1. owned ships for display
          .mockResolvedValueOnce([])               // 2. targeted ships for overlay targets
          .mockResolvedValueOnce([ownedOverlay]),  // 3. owned ships for upgrade check
      }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          { id: 1, category: "ore", name: "3★ Ore", grade: "3-star", quantity: 300, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
          { id: 2, category: "crystal", name: "3★ Crystal", grade: "3-star", quantity: 100, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
        ]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Should have readyToUpgrade since 100% coverage
    const ready = result.readyToUpgrade as Array<Record<string, unknown>>;
    expect(ready).toBeDefined();
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready[0].shipName).toBe("USS Enterprise");
    expect(ready[0].coveragePct).toBe(100);
  });

  it("omits readyToUpgrade when resource coverage is below 80%", async () => {
    const shipWithTiers: ReferenceShip = {
      ...FIXTURE_SHIP,
      id: "cdn:ship:enterprise",
      name: "USS Enterprise",
      maxTier: 10,
      tiers: [
        {
          tier: 6,
          components: [
            { build_cost: [{ resource_id: 101, amount: 1000, name: "3★ Ore" }] },
          ],
        },
      ],
    } as ReferenceShip;

    const ownedOverlay = { refId: "cdn:ship:enterprise", ownershipState: "owned", tier: 5 };

    const ctx = toolEnv({
      referenceStore: createMockReferenceStore({
        listShips: vi.fn().mockResolvedValue([shipWithTiers]),
      }),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn()
          .mockResolvedValueOnce([ownedOverlay])  // 1. owned ships for display
          .mockResolvedValueOnce([])               // 2. targeted ships for overlay targets
          .mockResolvedValueOnce([ownedOverlay]),  // 3. owned ships for upgrade check
      }),
      inventoryStore: createMockInventoryStore({
        listItems: vi.fn().mockResolvedValue([
          { id: 1, category: "ore", name: "3★ Ore", grade: "3-star", quantity: 100, unit: null, source: "chat", capturedAt: "2026-01-01", updatedAt: "2026-01-01" },
        ]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Only 10% coverage (100/1000) — should NOT have readyToUpgrade
    expect(result.readyToUpgrade).toBeUndefined();
  });

  it("degrades gracefully when inventory store unavailable", async () => {
    const ctx = toolEnv({
      referenceStore: createMockReferenceStore(),
      overlayStore: createMockOverlayStore({
        listOfficerOverlays: vi.fn().mockResolvedValue([]),
        listShipOverlays: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await executeFleetTool("suggest_targets", {}, ctx) as Record<string, unknown>;

    // Should work fine — just no ready-to-upgrade data
    expect(result).not.toHaveProperty("error");
    expect(result.readyToUpgrade).toBeUndefined();
  });
});

// ─── User Isolation & Thread Safety ─────────────────────────

