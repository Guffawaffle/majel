/**
 * crew-store.test.ts — ADR-025 Crew Composition Data Layer Tests
 *
 * Integration tests against live PostgreSQL (docker-compose).
 * Tests the unified crew composition model: BridgeCores, BelowDeckPolicies,
 * Loadouts (with variants), Docks, FleetPresets, PlanItems,
 * OfficerReservations, and composition functions.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createCrewStore, type CrewStore } from "../src/server/stores/crew-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/stores/reference-store.js";
import { createTestPool, truncatePublicTables, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Test Helpers ───────────────────────────────────────────────

const REF_DEFAULTS = {
  source: "test", sourceUrl: null, sourcePageId: null,
  sourceRevisionId: null, sourceRevisionTimestamp: null,
};

async function seedShip(store: ReferenceStore, id: string, name: string, shipClass: string, tier = 3) {
  await store.upsertShip({ id, name, shipClass, tier, grade: null, rarity: null, faction: null, ...REF_DEFAULTS });
}

async function seedOfficer(store: ReferenceStore, id: string, name: string, rarity: string, groupName: string) {
  await store.upsertOfficer({ id, name, rarity, groupName, captainManeuver: null, officerAbility: null, belowDeckAbility: null, ...REF_DEFAULTS });
}

async function seedBaseData(refStore: ReferenceStore) {
  await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
  await seedShip(refStore, "kumari", "Kumari", "Interceptor");
  await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
  await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  await seedOfficer(refStore, "mccoy", "McCoy", "Rare", "TOS");
  await seedOfficer(refStore, "uhura", "Uhura", "Rare", "TOS");
  await seedOfficer(refStore, "scotty", "Scotty", "Rare", "TOS");
  await seedOfficer(refStore, "sulu", "Sulu", "Rare", "TOS");
}

// ═══════════════════════════════════════════════════════════════
// Bridge Cores
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Bridge Cores", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("creates a bridge core with members", async () => {
    const core = await store.createBridgeCore("TOS Core", [
      { officerId: "kirk", slot: "captain" },
      { officerId: "spock", slot: "bridge_1" },
      { officerId: "mccoy", slot: "bridge_2" },
    ]);
    expect(core.name).toBe("TOS Core");
    expect(core.members).toHaveLength(3);
    expect(core.members.find(m => m.slot === "captain")?.officerId).toBe("kirk");
    expect(core.members.find(m => m.slot === "bridge_1")?.officerId).toBe("spock");
    expect(core.members.find(m => m.slot === "bridge_2")?.officerId).toBe("mccoy");
  });

  it("lists bridge cores", async () => {
    await store.createBridgeCore("Core A", [{ officerId: "kirk", slot: "captain" }]);
    await store.createBridgeCore("Core B", [{ officerId: "spock", slot: "captain" }]);
    const cores = await store.listBridgeCores();
    expect(cores).toHaveLength(2);
    expect(cores.map(c => c.name)).toEqual(["Core A", "Core B"]);
    // Each core should have members attached
    expect(cores[0].members.length).toBeGreaterThanOrEqual(1);
  });

  it("gets a bridge core by id", async () => {
    const created = await store.createBridgeCore("Solo Core", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const retrieved = await store.getBridgeCore(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Solo Core");
    expect(retrieved!.members).toHaveLength(1);
  });

  it("returns null for nonexistent bridge core", async () => {
    const core = await store.getBridgeCore(99999);
    expect(core).toBeNull();
  });

  it("updates a bridge core", async () => {
    const created = await store.createBridgeCore("Old Name", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const updated = await store.updateBridgeCore(created.id, { name: "New Name", notes: "Updated" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New Name");
    expect(updated!.notes).toBe("Updated");
  });

  it("deletes a bridge core", async () => {
    const created = await store.createBridgeCore("Doomed", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const deleted = await store.deleteBridgeCore(created.id);
    expect(deleted).toBe(true);
    const retrieved = await store.getBridgeCore(created.id);
    expect(retrieved).toBeNull();
  });

  it("replaces bridge core members", async () => {
    const created = await store.createBridgeCore("Swap Core", [
      { officerId: "kirk", slot: "captain" },
      { officerId: "spock", slot: "bridge_1" },
    ]);
    const newMembers = await store.setBridgeCoreMembers(created.id, [
      { officerId: "mccoy", slot: "captain" },
      { officerId: "uhura", slot: "bridge_1" },
      { officerId: "scotty", slot: "bridge_2" },
    ]);
    expect(newMembers).toHaveLength(3);
    expect(newMembers.find(m => m.slot === "captain")?.officerId).toBe("mccoy");
  });

  it("enforces unique slot per bridge core", async () => {
    await expect(
      store.createBridgeCore("Dup Slot", [
        { officerId: "kirk", slot: "captain" },
        { officerId: "spock", slot: "captain" },
      ]),
    ).rejects.toThrow();
  });

  it("enforces unique officer per bridge core", async () => {
    await expect(
      store.createBridgeCore("Dup Officer", [
        { officerId: "kirk", slot: "captain" },
        { officerId: "kirk", slot: "bridge_1" },
      ]),
    ).rejects.toThrow();
  });

  it("enforces unique name", async () => {
    await store.createBridgeCore("Same Name", [{ officerId: "kirk", slot: "captain" }]);
    await expect(
      store.createBridgeCore("Same Name", [{ officerId: "spock", slot: "captain" }]),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Below Deck Policies
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Below Deck Policies", () => {
  let store: CrewStore;

  beforeAll(async () => {
    await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
  });

  it("creates a below deck policy", async () => {
    const policy = await store.createBelowDeckPolicy("Default", "stats_then_bda", {
      pinned: ["kirk", "spock"],
    });
    expect(policy.name).toBe("Default");
    expect(policy.mode).toBe("stats_then_bda");
    expect(policy.spec.pinned).toEqual(["kirk", "spock"]);
  });

  it("lists below deck policies", async () => {
    await store.createBelowDeckPolicy("Policy A", "stats_then_bda", {});
    await store.createBelowDeckPolicy("Policy B", "pinned_only", { pinned: ["kirk"] });
    const policies = await store.listBelowDeckPolicies();
    expect(policies).toHaveLength(2);
    expect(policies.map(p => p.name)).toEqual(["Policy A", "Policy B"]);
  });

  it("gets a below deck policy by id", async () => {
    const created = await store.createBelowDeckPolicy("Find Me", "stat_fill_only", {});
    const retrieved = await store.getBelowDeckPolicy(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Find Me");
    expect(retrieved!.mode).toBe("stat_fill_only");
  });

  it("updates a below deck policy", async () => {
    const created = await store.createBelowDeckPolicy("Old", "stats_then_bda", {});
    const updated = await store.updateBelowDeckPolicy(created.id, {
      name: "New",
      mode: "pinned_only",
      spec: { pinned: ["kirk"] },
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(updated!.mode).toBe("pinned_only");
    expect(updated!.spec.pinned).toEqual(["kirk"]);
  });

  it("deletes a below deck policy", async () => {
    const created = await store.createBelowDeckPolicy("Gone", "stats_then_bda", {});
    const deleted = await store.deleteBelowDeckPolicy(created.id);
    expect(deleted).toBe(true);
    const check = await store.getBelowDeckPolicy(created.id);
    expect(check).toBeNull();
  });

  it("enforces unique name", async () => {
    await store.createBelowDeckPolicy("Unique", "stats_then_bda", {});
    await expect(
      store.createBelowDeckPolicy("Unique", "pinned_only", {}),
    ).rejects.toThrow();
  });

  it("enforces valid mode values", async () => {
    await expect(
      store.createBelowDeckPolicy("Bad Mode", "invalid_mode" as any, {}),
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadouts
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Loadouts", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("creates a basic loadout", async () => {
    const loadout = await store.createLoadout({
      shipId: "vidar",
      name: "Mining Build",
      intentKeys: ["mining"],
      tags: ["pve"],
    });
    expect(loadout.shipId).toBe("vidar");
    expect(loadout.name).toBe("Mining Build");
    expect(loadout.isActive).toBe(true);
    expect(loadout.priority).toBe(0);
    expect(loadout.intentKeys).toEqual(["mining"]);
    expect(loadout.tags).toEqual(["pve"]);
  });

  it("creates a loadout with bridge core and below deck", async () => {
    const core = await store.createBridgeCore("Test Core", [
      { officerId: "kirk", slot: "captain" },
      { officerId: "spock", slot: "bridge_1" },
    ]);
    const bdp = await store.createBelowDeckPolicy("Standard", "stats_then_bda", {});
    const loadout = await store.createLoadout({
      shipId: "vidar",
      name: "Full Build",
      bridgeCoreId: core.id,
      belowDeckPolicyId: bdp.id,
    });
    expect(loadout.bridgeCoreId).toBe(core.id);
    expect(loadout.belowDeckPolicyId).toBe(bdp.id);
  });

  it("gets a loadout with refs", async () => {
    const core = await store.createBridgeCore("Core", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const bdp = await store.createBelowDeckPolicy("BDP", "stats_then_bda", {});
    const created = await store.createLoadout({
      shipId: "vidar", name: "Build",
      bridgeCoreId: core.id, belowDeckPolicyId: bdp.id,
    });
    const retrieved = await store.getLoadout(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.bridgeCore).not.toBeNull();
    expect(retrieved!.bridgeCore!.name).toBe("Core");
    expect(retrieved!.belowDeckPolicy).not.toBeNull();
    expect(retrieved!.belowDeckPolicy!.name).toBe("BDP");
  });

  it("lists loadouts with filters", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A", intentKeys: ["mining"], tags: ["pve"] });
    await store.createLoadout({ shipId: "kumari", name: "B", intentKeys: ["combat"], tags: ["pvp"] });
    await store.createLoadout({ shipId: "vidar", name: "C", isActive: false });

    const byShip = await store.listLoadouts({ shipId: "vidar" });
    expect(byShip).toHaveLength(2);

    const byIntent = await store.listLoadouts({ intentKey: "mining" });
    expect(byIntent).toHaveLength(1);
    expect(byIntent[0].name).toBe("A");

    const byTag = await store.listLoadouts({ tag: "pvp" });
    expect(byTag).toHaveLength(1);
    expect(byTag[0].name).toBe("B");

    const byActive = await store.listLoadouts({ active: true });
    expect(byActive).toHaveLength(2);
  });

  it("updates a loadout", async () => {
    const created = await store.createLoadout({ shipId: "vidar", name: "V1" });
    const updated = await store.updateLoadout(created.id, {
      name: "V2",
      priority: 5,
      isActive: false,
      tags: ["updated"],
      notes: "Changed",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("V2");
    expect(updated!.priority).toBe(5);
    expect(updated!.isActive).toBe(false);
    expect(updated!.tags).toEqual(["updated"]);
    expect(updated!.notes).toBe("Changed");
  });

  it("deletes a loadout", async () => {
    const created = await store.createLoadout({ shipId: "vidar", name: "Gone" });
    expect(await store.deleteLoadout(created.id)).toBe(true);
    expect(await store.getLoadout(created.id)).toBeNull();
  });

  it("enforces unique (ship_id, name)", async () => {
    await store.createLoadout({ shipId: "vidar", name: "Same" });
    await expect(
      store.createLoadout({ shipId: "vidar", name: "Same" }),
    ).rejects.toThrow();
  });

  it("allows same name on different ships", async () => {
    await store.createLoadout({ shipId: "vidar", name: "Mining" });
    const second = await store.createLoadout({ shipId: "kumari", name: "Mining" });
    expect(second.name).toBe("Mining");
  });

  it("cascades bridge core deletion to null on loadout", async () => {
    const core = await store.createBridgeCore("Temp Core", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Test", bridgeCoreId: core.id,
    });
    await store.deleteBridgeCore(core.id);
    const retrieved = await store.getLoadout(loadout.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.bridgeCoreId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadout Variants
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Loadout Variants", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;
  let baseLoadoutId: number;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Base" });
    baseLoadoutId = loadout.id;
  });

  it("creates a variant with patch", async () => {
    const variant = await store.createVariant(baseLoadoutId, "PvP Swap", {
      bridge: { captain: "spock" },
    });
    expect(variant.name).toBe("PvP Swap");
    expect(variant.baseLoadoutId).toBe(baseLoadoutId);
    expect(variant.patch.bridge?.captain).toBe("spock");
  });

  it("lists variants for a loadout", async () => {
    await store.createVariant(baseLoadoutId, "V1", { intent_keys: ["mining"] });
    await store.createVariant(baseLoadoutId, "V2", { bridge: { bridge_1: "mccoy" } });
    const variants = await store.listVariants(baseLoadoutId);
    expect(variants).toHaveLength(2);
    expect(variants.map(v => v.name)).toEqual(["V1", "V2"]);
  });

  it("gets a variant by id", async () => {
    const created = await store.createVariant(baseLoadoutId, "Find", {});
    const retrieved = await store.getVariant(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Find");
  });

  it("updates a variant", async () => {
    const created = await store.createVariant(baseLoadoutId, "Old", {});
    const updated = await store.updateVariant(created.id, {
      name: "New",
      patch: { bridge: { captain: "spock" } },
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(updated!.patch.bridge?.captain).toBe("spock");
  });

  it("deletes a variant", async () => {
    const created = await store.createVariant(baseLoadoutId, "Gone", {});
    expect(await store.deleteVariant(created.id)).toBe(true);
    expect(await store.getVariant(created.id)).toBeNull();
  });

  it("cascades deletion when base loadout is deleted", async () => {
    const variant = await store.createVariant(baseLoadoutId, "Cascade", {});
    await store.deleteLoadout(baseLoadoutId);
    const retrieved = await store.getVariant(variant.id);
    expect(retrieved).toBeNull();
  });

  it("enforces unique (base_loadout_id, name)", async () => {
    await store.createVariant(baseLoadoutId, "Same", {});
    await expect(
      store.createVariant(baseLoadoutId, "Same", {}),
    ).rejects.toThrow();
  });

  it("rejects unknown patch keys", async () => {
    await expect(
      store.createVariant(baseLoadoutId, "Bad", { foo: "bar" } as any),
    ).rejects.toThrow("Unknown patch key");
  });

  it("rejects mutual exclusion: policy_id + below_deck_patch", async () => {
    await expect(
      store.createVariant(baseLoadoutId, "Conflict", {
        below_deck_policy_id: 1,
        below_deck_patch: { pinned_add: ["kirk"] },
      }),
    ).rejects.toThrow("mutually exclusive");
  });
});

// ═══════════════════════════════════════════════════════════════
// Docks
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Docks", () => {
  let store: CrewStore;

  beforeAll(async () => {
    await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
  });

  it("upserts a dock", async () => {
    const dock = await store.upsertDock(1, { label: "Dock Alpha", unlocked: true });
    expect(dock.dockNumber).toBe(1);
    expect(dock.label).toBe("Dock Alpha");
    expect(dock.unlocked).toBe(true);
  });

  it("upserts updates an existing dock", async () => {
    await store.upsertDock(1, { label: "Original" });
    const updated = await store.upsertDock(1, { label: "Updated" });
    expect(updated.label).toBe("Updated");
    const all = await store.listDocks();
    expect(all).toHaveLength(1);
  });

  it("lists docks ordered by dock_number", async () => {
    await store.upsertDock(3, { label: "C" });
    await store.upsertDock(1, { label: "A" });
    await store.upsertDock(2, { label: "B" });
    const docks = await store.listDocks();
    expect(docks.map(d => d.dockNumber)).toEqual([1, 2, 3]);
  });

  it("gets a dock by number", async () => {
    await store.upsertDock(5, { label: "Dock 5" });
    const dock = await store.getDock(5);
    expect(dock).not.toBeNull();
    expect(dock!.label).toBe("Dock 5");
  });

  it("returns null for nonexistent dock", async () => {
    expect(await store.getDock(999)).toBeNull();
  });

  it("deletes a dock", async () => {
    await store.upsertDock(1, {});
    expect(await store.deleteDock(1)).toBe(true);
    expect(await store.getDock(1)).toBeNull();
  });

  it("rejects dock_number < 1", async () => {
    await expect(store.upsertDock(0, {})).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Fleet Presets
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Fleet Presets", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("creates a fleet preset", async () => {
    const preset = await store.createFleetPreset("Daily Grind");
    expect(preset.name).toBe("Daily Grind");
    expect(preset.isActive).toBe(false);
  });

  it("lists fleet presets with slots", async () => {
    const preset = await store.createFleetPreset("FP1");
    await store.upsertDock(1, { label: "D1" });
    const loadout = await store.createLoadout({ shipId: "vidar", name: "L1" });
    await store.setFleetPresetSlots(preset.id, [
      { dockNumber: 1, loadoutId: loadout.id, priority: 1 },
    ]);
    const presets = await store.listFleetPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0].slots).toHaveLength(1);
    expect(presets[0].slots[0].dockNumber).toBe(1);
    expect(presets[0].slots[0].loadoutId).toBe(loadout.id);
  });

  it("gets a fleet preset by id", async () => {
    const created = await store.createFleetPreset("Findable");
    const retrieved = await store.getFleetPreset(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Findable");
    expect(retrieved!.slots).toEqual([]);
  });

  it("activates a preset (only one active)", async () => {
    const p1 = await store.createFleetPreset("P1");
    const p2 = await store.createFleetPreset("P2");
    await store.updateFleetPreset(p1.id, { isActive: true });
    let r1 = await store.getFleetPreset(p1.id);
    expect(r1!.isActive).toBe(true);

    // Activating P2 should deactivate P1
    await store.updateFleetPreset(p2.id, { isActive: true });
    r1 = await store.getFleetPreset(p1.id);
    const r2 = await store.getFleetPreset(p2.id);
    expect(r1!.isActive).toBe(false);
    expect(r2!.isActive).toBe(true);
  });

  it("replaces all slots on a preset", async () => {
    const preset = await store.createFleetPreset("Slotted");
    await store.upsertDock(1, {});
    await store.upsertDock(2, {});
    const l1 = await store.createLoadout({ shipId: "vidar", name: "L1" });
    const l2 = await store.createLoadout({ shipId: "kumari", name: "L2" });

    await store.setFleetPresetSlots(preset.id, [
      { dockNumber: 1, loadoutId: l1.id },
    ]);
    let retrieved = await store.getFleetPreset(preset.id);
    expect(retrieved!.slots).toHaveLength(1);

    // Replace with new slots
    await store.setFleetPresetSlots(preset.id, [
      { dockNumber: 1, loadoutId: l2.id },
      { dockNumber: 2, loadoutId: l1.id },
    ]);
    retrieved = await store.getFleetPreset(preset.id);
    expect(retrieved!.slots).toHaveLength(2);
  });

  it("deletes a fleet preset (cascading slots)", async () => {
    const preset = await store.createFleetPreset("Doomed");
    await store.upsertDock(1, {});
    const l = await store.createLoadout({ shipId: "vidar", name: "L1" });
    await store.setFleetPresetSlots(preset.id, [{ dockNumber: 1, loadoutId: l.id }]);
    expect(await store.deleteFleetPreset(preset.id)).toBe(true);
    expect(await store.getFleetPreset(preset.id)).toBeNull();
  });

  it("enforces unique preset name", async () => {
    await store.createFleetPreset("Same");
    await expect(store.createFleetPreset("Same")).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Items
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Plan Items", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("creates a plan item with loadout", async () => {
    await store.upsertDock(1, {});
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Plan Build" });
    const item = await store.createPlanItem({
      label: "Mining Run",
      loadoutId: loadout.id,
      dockNumber: 1,
      priority: 10,
    });
    expect(item.label).toBe("Mining Run");
    expect(item.loadoutId).toBe(loadout.id);
    expect(item.dockNumber).toBe(1);
    expect(item.isActive).toBe(true);
    expect(item.source).toBe("manual");
  });

  it("creates a plan item with away officers", async () => {
    const item = await store.createPlanItem({
      label: "Away Mission",
      awayOfficers: ["kirk", "spock", "mccoy"],
    });
    expect(item.awayOfficers).toEqual(["kirk", "spock", "mccoy"]);
    expect(item.loadoutId).toBeNull();
  });

  it("lists plan items with filters", async () => {
    await store.upsertDock(1, {});
    await store.upsertDock(2, {});
    const l = await store.createLoadout({ shipId: "vidar", name: "L" });
    await store.createPlanItem({ loadoutId: l.id, dockNumber: 1, isActive: true });
    await store.createPlanItem({ loadoutId: l.id, dockNumber: 2, isActive: false });

    const active = await store.listPlanItems({ active: true });
    expect(active).toHaveLength(1);

    const atDock1 = await store.listPlanItems({ dockNumber: 1 });
    expect(atDock1).toHaveLength(1);
  });

  it("updates a plan item", async () => {
    const item = await store.createPlanItem({ label: "V1", awayOfficers: ["kirk"] });
    const updated = await store.updatePlanItem(item.id, {
      label: "V2",
      priority: 5,
      isActive: false,
    });
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("V2");
    expect(updated!.priority).toBe(5);
    expect(updated!.isActive).toBe(false);
  });

  it("deletes a plan item", async () => {
    const item = await store.createPlanItem({ label: "Delete me", awayOfficers: ["kirk"] });
    expect(await store.deletePlanItem(item.id)).toBe(true);
    expect(await store.getPlanItem(item.id)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Officer Reservations
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — Officer Reservations", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("sets a reservation", async () => {
    const res = await store.setReservation("kirk", "loadout:1", true, "Captain always here");
    expect(res.officerId).toBe("kirk");
    expect(res.reservedFor).toBe("loadout:1");
    expect(res.locked).toBe(true);
    expect(res.notes).toBe("Captain always here");
  });

  it("upserts a reservation", async () => {
    await store.setReservation("kirk", "loadout:1");
    const updated = await store.setReservation("kirk", "loadout:2", true);
    expect(updated.reservedFor).toBe("loadout:2");
    expect(updated.locked).toBe(true);
    const all = await store.listReservations();
    expect(all).toHaveLength(1);
  });

  it("gets a reservation by officer id", async () => {
    await store.setReservation("spock", "science_bay");
    const res = await store.getReservation("spock");
    expect(res).not.toBeNull();
    expect(res!.reservedFor).toBe("science_bay");
  });

  it("returns null for unreserved officer", async () => {
    expect(await store.getReservation("nobody")).toBeNull();
  });

  it("lists all reservations", async () => {
    await store.setReservation("kirk", "bridge");
    await store.setReservation("spock", "science");
    const all = await store.listReservations();
    expect(all).toHaveLength(2);
  });

  it("deletes a reservation", async () => {
    await store.setReservation("kirk", "bridge");
    expect(await store.deleteReservation("kirk")).toBe(true);
    expect(await store.getReservation("kirk")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Resolve Variant (ADR-025 § Patch Merge)
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — resolveVariant", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("resolves bridge override", async () => {
    const core = await store.createBridgeCore("Base Core", [
      { officerId: "kirk", slot: "captain" },
      { officerId: "spock", slot: "bridge_1" },
      { officerId: "mccoy", slot: "bridge_2" },
    ]);
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Base Build",
      bridgeCoreId: core.id,
    });
    const variant = await store.createVariant(loadout.id, "PvP", {
      bridge: { captain: "uhura" },
    });

    const resolved = await store.resolveVariant(loadout.id, variant.id);
    expect(resolved.bridge.captain).toBe("uhura");
    expect(resolved.bridge.bridge_1).toBe("spock"); // unchanged
    expect(resolved.bridge.bridge_2).toBe("mccoy"); // unchanged
  });

  it("resolves below_deck_policy_id replacement", async () => {
    const bdp1 = await store.createBelowDeckPolicy("Original", "stats_then_bda", {});
    const bdp2 = await store.createBelowDeckPolicy("Replacement", "pinned_only", { pinned: ["kirk"] });
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Build",
      belowDeckPolicyId: bdp1.id,
    });
    const variant = await store.createVariant(loadout.id, "Swap BDP", {
      below_deck_policy_id: bdp2.id,
    });

    const resolved = await store.resolveVariant(loadout.id, variant.id);
    expect(resolved.belowDeckPolicy).not.toBeNull();
    expect(resolved.belowDeckPolicy!.name).toBe("Replacement");
    expect(resolved.belowDeckPolicy!.mode).toBe("pinned_only");
  });

  it("resolves below_deck_patch (set-diff on pinned)", async () => {
    const bdp = await store.createBelowDeckPolicy("Base", "stats_then_bda", {
      pinned: ["kirk", "spock", "mccoy"],
    });
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Build",
      belowDeckPolicyId: bdp.id,
    });
    const variant = await store.createVariant(loadout.id, "Adjusted", {
      below_deck_patch: {
        pinned_add: ["uhura"],
        pinned_remove: ["mccoy"],
      },
    });

    const resolved = await store.resolveVariant(loadout.id, variant.id);
    const pinned = resolved.belowDeckPolicy!.spec.pinned!;
    expect(pinned).toContain("kirk");
    expect(pinned).toContain("spock");
    expect(pinned).toContain("uhura");
    expect(pinned).not.toContain("mccoy");
  });

  it("resolves intent_keys replacement", async () => {
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Build",
      intentKeys: ["mining", "survey"],
    });
    const variant = await store.createVariant(loadout.id, "Combat Only", {
      intent_keys: ["combat"],
    });

    const resolved = await store.resolveVariant(loadout.id, variant.id);
    expect(resolved.intentKeys).toEqual(["combat"]);
  });

  it("throws for nonexistent base loadout", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "X" });
    const variant = await store.createVariant(loadout.id, "V", {});
    await expect(store.resolveVariant(99999, variant.id)).rejects.toThrow("not found");
  });

  it("throws for nonexistent variant", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "X" });
    await expect(store.resolveVariant(loadout.id, 99999)).rejects.toThrow("not found");
  });

  it("throws for variant belonging to different loadout", async () => {
    const l1 = await store.createLoadout({ shipId: "vidar", name: "L1" });
    const l2 = await store.createLoadout({ shipId: "kumari", name: "L2" });
    const variant = await store.createVariant(l1.id, "V", {});
    await expect(store.resolveVariant(l2.id, variant.id)).rejects.toThrow("does not belong");
  });
});

// ═══════════════════════════════════════════════════════════════
// getEffectiveDockState (ADR-025 § D6)
// ═══════════════════════════════════════════════════════════════

describe("CrewStore — getEffectiveDockState", () => {
  let store: CrewStore;
  let refStore: ReferenceStore;

  beforeAll(async () => {
    refStore = await createReferenceStore(pool);
    store = await createCrewStore(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await seedBaseData(refStore);
  });

  it("returns empty state with no plan items", async () => {
    const state = await store.getEffectiveDockState();
    expect(state.docks).toEqual([]);
    expect(state.awayTeams).toEqual([]);
    expect(state.conflicts).toEqual([]);
  });

  it("builds dock entries from plan items with loadouts", async () => {
    await store.upsertDock(1, { label: "D1" });
    const core = await store.createBridgeCore("Core", [
      { officerId: "kirk", slot: "captain" },
      { officerId: "spock", slot: "bridge_1" },
    ]);
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "Mining",
      bridgeCoreId: core.id,
      intentKeys: ["mining"],
    });
    await store.createPlanItem({
      loadoutId: loadout.id,
      dockNumber: 1,
    });

    const state = await store.getEffectiveDockState();
    expect(state.docks).toHaveLength(1);
    expect(state.docks[0].dockNumber).toBe(1);
    expect(state.docks[0].loadout).not.toBeNull();
    expect(state.docks[0].loadout!.bridge.captain).toBe("kirk");
    expect(state.docks[0].intentKeys).toContain("mining");
  });

  it("collects away teams from plan items", async () => {
    await store.createPlanItem({
      label: "Away Team Alpha",
      awayOfficers: ["kirk", "spock", "mccoy"],
    });

    const state = await store.getEffectiveDockState();
    expect(state.awayTeams).toHaveLength(1);
    expect(state.awayTeams[0].label).toBe("Away Team Alpha");
    expect(state.awayTeams[0].officers).toEqual(["kirk", "spock", "mccoy"]);
  });

  it("detects officer conflicts across dock entries", async () => {
    await store.upsertDock(1, {});
    await store.upsertDock(2, {});
    // Both loadouts use kirk as captain
    const core1 = await store.createBridgeCore("C1", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const core2 = await store.createBridgeCore("C2", [
      { officerId: "kirk", slot: "bridge_1" },
    ]);
    const l1 = await store.createLoadout({ shipId: "vidar", name: "L1", bridgeCoreId: core1.id });
    const l2 = await store.createLoadout({ shipId: "kumari", name: "L2", bridgeCoreId: core2.id });
    await store.createPlanItem({ loadoutId: l1.id, dockNumber: 1 });
    await store.createPlanItem({ loadoutId: l2.id, dockNumber: 2 });

    const state = await store.getEffectiveDockState();
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0].officerId).toBe("kirk");
    expect(state.conflicts[0].locations).toHaveLength(2);
  });

  it("detects conflicts between dock and away team", async () => {
    await store.upsertDock(1, {});
    const core = await store.createBridgeCore("C", [
      { officerId: "kirk", slot: "captain" },
    ]);
    const loadout = await store.createLoadout({
      shipId: "vidar", name: "L", bridgeCoreId: core.id,
    });
    await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1 });
    await store.createPlanItem({
      label: "Away",
      awayOfficers: ["kirk", "spock"],
    });

    const state = await store.getEffectiveDockState();
    expect(state.conflicts.length).toBeGreaterThanOrEqual(1);
    const kirkConflict = state.conflicts.find(c => c.officerId === "kirk");
    expect(kirkConflict).toBeDefined();
    expect(kirkConflict!.locations).toHaveLength(2);
  });

  it("skips inactive plan items", async () => {
    await store.upsertDock(1, {});
    const loadout = await store.createLoadout({ shipId: "vidar", name: "L" });
    await store.createPlanItem({
      loadoutId: loadout.id,
      dockNumber: 1,
      isActive: false,
    });

    const state = await store.getEffectiveDockState();
    expect(state.docks).toHaveLength(0);
  });
});
