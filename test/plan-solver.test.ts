/**
 * plan-solver.test.ts — Plan Solver Tests (ADR-022 Phase 5)
 *
 * Integration tests against live PostgreSQL.
 * Tests the greedy priority queue solver algorithm.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  createCrewStore,
  type CrewStore,
} from "../src/server/stores/crew-store.js";
import type { BridgeSlot } from "../src/server/types/crew-types.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";
import { solvePlan } from "../src/server/services/plan-solver.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Test Helpers ───────────────────────────────────────────────

const REF_DEFAULTS = {
  source: "test", sourceUrl: null, sourcePageId: null,
  sourceRevisionId: null, sourceRevisionTimestamp: null,
};

async function seedShip(store: ReferenceStore, id: string, name: string, shipClass: string) {
  await store.upsertShip({ id, name, shipClass, tier: 3, grade: null, rarity: null, faction: null, ...REF_DEFAULTS });
}

async function seedOfficer(store: ReferenceStore, id: string, name: string) {
  await store.upsertOfficer({ id, name, rarity: "Epic", groupName: "TOS", captainManeuver: null, officerAbility: null, belowDeckAbility: null, ...REF_DEFAULTS });
}

const SLOTS: BridgeSlot[] = ["captain", "bridge_1", "bridge_2"];

/** Create a loadout with optional bridge core crew (new ADR-025 model). */
async function seedLoadout(
  store: CrewStore,
  opts: { shipId: string; name: string; priority?: number; officers?: string[] },
) {
  let bridgeCoreId: number | undefined;
  if (opts.officers && opts.officers.length > 0) {
    const members = opts.officers.map((id, i) => ({ officerId: id, slot: SLOTS[i] ?? ("bridge_" + i as BridgeSlot) }));
    const bc = await store.createBridgeCore(`${opts.name} Bridge`, members);
    bridgeCoreId = bc.id;
  }
  return store.createLoadout({ shipId: opts.shipId, name: opts.name, priority: opts.priority, bridgeCoreId });
}

// ═══════════════════════════════════════════════════════════════
// Plan Solver — Greedy Priority Queue
// ═══════════════════════════════════════════════════════════════

describe("Plan Solver", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedShip(refStore, "enterprise", "Enterprise", "Battleship");
    await seedOfficer(refStore, "kirk", "Kirk");
    await seedOfficer(refStore, "spock", "Spock");
    await seedOfficer(refStore, "mccoy", "McCoy");
    await seedOfficer(refStore, "uhura", "Uhura");
    await seedOfficer(refStore, "scotty", "Scotty");
  });

  // ─── Empty Plan ───────────────────────────────────────────

  it("empty plan returns empty result", async () => {
    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(0);
    expect(result.applied).toBe(false);
    expect(result.conflicts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.summary).toContain("preview");
  });

  // ─── Basic Assignment ─────────────────────────────────────

  it("assigns active plan items to available docks by priority", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "Mining Alpha", priority: 1, officers: ["kirk"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "Combat Beta", priority: 2, officers: ["spock"] });
    await store.upsertDock(1, { label: "Alpha Dock" });
    await store.upsertDock(2, { label: "Beta Dock" });
    await store.createPlanItem({ loadoutId: loA.id, label: "Mine Gas", priority: 1 });
    await store.createPlanItem({ loadoutId: loB.id, label: "Grind Hostiles", priority: 2 });

    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(2);
    expect(result.applied).toBe(false);

    // Both should get assigned docks
    const assigned = result.assignments.filter(a => a.action === "assigned");
    expect(assigned.length).toBe(2);
    expect(assigned[0].dockNumber).toBe(1);
    expect(assigned[1].dockNumber).toBe(2);
  });

  it("keeps existing dock assignments if valid", async () => {
    const lo = await seedLoadout(store, { shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    // Already assigned to dock 2
    await store.createPlanItem({ loadoutId: lo.id, dockNumber: 2, label: "Already Docked", priority: 1 });

    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].action).toBe("unchanged");
    expect(result.assignments[0].dockNumber).toBe(2);
    expect(result.assignments[0].explanation).toContain("keeps Dock 2");
  });

  // ─── Queuing (No Dock Available) ──────────────────────────

  it("queues lower-priority items when no docks available", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "A", priority: 1, officers: ["kirk"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "B", priority: 2, officers: ["spock"] });
    const loC = await seedLoadout(store, { shipId: "enterprise", name: "C", priority: 3, officers: ["mccoy"] });
    await store.upsertDock(1, { label: "D1" });
    // Only 1 dock for 3 plan items
    await store.createPlanItem({ loadoutId: loA.id, label: "High Priority", priority: 1 });
    await store.createPlanItem({ loadoutId: loB.id, label: "Medium Priority", priority: 2 });
    await store.createPlanItem({ loadoutId: loC.id, label: "Low Priority", priority: 3 });

    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(3);

    const assigned = result.assignments.filter(a => a.action === "assigned");
    const queued = result.assignments.filter(a => a.action === "queued");
    expect(assigned.length).toBe(1);
    expect(assigned[0].planItemLabel).toBe("High Priority");
    expect(queued.length).toBe(2);
    expect(result.warnings.length).toBe(2);
  });

  // ─── Officer Conflict Detection ───────────────────────────

  it("detects officer conflicts and skips conflicting items", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "A", priority: 1, officers: ["kirk"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "B", priority: 2, officers: ["kirk"] });
    // Both loadouts use Kirk — conflict!
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loA.id, label: "Uses Kirk First", priority: 1 });
    await store.createPlanItem({ loadoutId: loB.id, label: "Also Uses Kirk", priority: 2 });

    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(2);

    const first = result.assignments[0];
    expect(first.action).toBe("assigned");
    expect(first.planItemLabel).toBe("Uses Kirk First");

    const second = result.assignments[1];
    expect(second.action).toBe("conflict");
    expect(second.explanation).toContain("Kirk");
    expect(second.explanation).toContain("already assigned");
    expect(result.warnings.length).toBe(1);
  });

  // ─── Apply Mode ───────────────────────────────────────────

  it("applies assignments to DB when apply=true", async () => {
    const lo = await seedLoadout(store, { shipId: "vidar", name: "A", officers: ["kirk"] });
    await store.upsertDock(1, { label: "D1" });
    const pi = await store.createPlanItem({ loadoutId: lo.id, label: "Unassigned", priority: 1 });
    expect(pi.dockNumber).toBeNull();

    const result = await solvePlan(store, { apply: true });
    expect(result.applied).toBe(true);
    expect(result.assignments[0].action).toBe("assigned");
    expect(result.assignments[0].dockNumber).toBe(1);
    expect(result.summary).toContain("applied");

    // Verify DB was updated
    const updated = await store.getPlanItem(pi.id);
    expect(updated!.dockNumber).toBe(1);
  });

  it("dry run (apply=false) does NOT change DB", async () => {
    const lo = await seedLoadout(store, { shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    const pi = await store.createPlanItem({ loadoutId: lo.id, label: "Unassigned", priority: 1 });

    const result = await solvePlan(store, { apply: false });
    expect(result.applied).toBe(false);
    expect(result.assignments[0].action).toBe("assigned");

    // DB should be unchanged
    const unchanged = await store.getPlanItem(pi.id);
    expect(unchanged!.dockNumber).toBeNull();
  });

  // ─── Away Team Handling ───────────────────────────────────

  it("handles away team items without dock assignment", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "A", officers: ["kirk"] });
    await store.upsertDock(1, { label: "D1" });
    // Plan item with away team members but no dock
    const awayItem = await store.createPlanItem({ label: "Away Mission", priority: 1, awayOfficers: ["kirk", "spock"] });

    const result = await solvePlan(store);
    const away = result.assignments.find(a => a.planItemId === awayItem.id);
    expect(away).toBeDefined();
    expect(away!.action).toBe("unchanged");
    expect(away!.explanation).toContain("away team");
    expect(away!.dockNumber).toBeNull();
  });

  // ─── Priority Ordering ────────────────────────────────────

  it("processes plan items in priority order (lowest number first)", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "Low Priority Ship", officers: ["kirk"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "High Priority Ship", officers: ["spock"] });
    await store.upsertDock(1, { label: "D1" });
    // Create in reverse priority order — solver should still process B first
    await store.createPlanItem({ loadoutId: loA.id, label: "Low Pri", priority: 5 });
    await store.createPlanItem({ loadoutId: loB.id, label: "High Pri", priority: 1 });

    const result = await solvePlan(store);
    expect(result.assignments[0].planItemLabel).toBe("High Pri");
    expect(result.assignments[0].action).toBe("assigned");
    expect(result.assignments[0].dockNumber).toBe(1);
    expect(result.assignments[1].planItemLabel).toBe("Low Pri");
    expect(result.assignments[1].action).toBe("queued");
  });

  // ─── Multiple Conflicts ───────────────────────────────────

  it("handles multiple officer conflicts across loadouts", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "A", officers: ["kirk", "spock"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "B", officers: ["kirk"] });
    const loC = await seedLoadout(store, { shipId: "enterprise", name: "C", officers: ["spock"] });
    // A: kirk + spock, B: kirk (conflict), C: spock (conflict)
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.upsertDock(3, { label: "D3" });
    await store.createPlanItem({ loadoutId: loA.id, label: "A", priority: 1 });
    await store.createPlanItem({ loadoutId: loB.id, label: "B", priority: 2 });
    await store.createPlanItem({ loadoutId: loC.id, label: "C", priority: 3 });

    const result = await solvePlan(store);
    const conflicts = result.assignments.filter(a => a.action === "conflict");
    expect(conflicts.length).toBe(2);
    expect(result.warnings.length).toBe(2);
  });

  // ─── Summary Format ──────────────────────────────────────

  it("produces informative summary for mixed results", async () => {
    const loA = await seedLoadout(store, { shipId: "vidar", name: "A", officers: ["kirk"] });
    const loB = await seedLoadout(store, { shipId: "kumari", name: "B", officers: ["spock"] });
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loA.id, label: "A", priority: 1 });
    await store.createPlanItem({ loadoutId: loB.id, label: "B", priority: 2 });

    const result = await solvePlan(store);
    expect(result.summary).toContain("preview");
    expect(result.summary).toContain("assigned");
  });

  // ─── Inactive Plan Items ──────────────────────────────────

  it("only processes active plan items", async () => {
    const lo = await seedLoadout(store, { shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: lo.id, label: "Active", priority: 1, isActive: true });
    await store.createPlanItem({ loadoutId: lo.id, label: "Paused", priority: 2, isActive: false });

    const result = await solvePlan(store);
    // Should only see the active item
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].planItemLabel).toBe("Active");
  });

  // ─── No Loadout Plan Item ─────────────────────────────────

  it("handles plan items without loadouts (no officer tracking)", async () => {
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ label: "Bare Item", priority: 1, awayOfficers: ["officer-generic"] });

    const result = await solvePlan(store);
    expect(result.assignments).toHaveLength(1);
    // Away team plan items don't need dock assignment
    expect(result.assignments[0].action).toBe("unchanged");
    expect(result.assignments[0].dockNumber).toBeNull();
    expect(result.assignments[0].loadoutId).toBeNull();
  });
});
