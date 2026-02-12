/**
 * dock-store.test.ts — Drydock Loadout Data Layer Tests (ADR-010 Phases 1 & 2)
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  createDockStore,
  VALID_INTENT_CATEGORIES,
  type DockStore,
} from "../src/server/dock-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/reference-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

let pool: Pool;
beforeAll(() => { pool = createTestPool(); });
afterAll(async () => { await pool.end(); });

// ─── Test Helpers: seed reference data ──────────────────────────

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

// ─── Intent Catalog ─────────────────────────────────────────────

describe("DockStore — Intent Catalog", () => {
  let store: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createDockStore(pool);
  });

  it("seeds builtin intents on first create", async () => {
    const intents = await store.listIntents();
    expect(intents.length).toBeGreaterThanOrEqual(21);
    const keys = intents.map((i) => i.key);
    expect(keys).toContain("mining-gas");
    expect(keys).toContain("grinding");
    expect(keys).toContain("exploration");
  });

  it("all seed intents are marked builtin", async () => {
    const intents = await store.listIntents();
    const builtins = intents.filter((i) => i.isBuiltin);
    expect(builtins.length).toBeGreaterThanOrEqual(21);
  });

  it("filters intents by category", async () => {
    const mining = await store.listIntents({ category: "mining" });
    expect(mining.length).toBeGreaterThanOrEqual(9);
    expect(mining.every((i) => i.category === "mining")).toBe(true);

    const combat = await store.listIntents({ category: "combat" });
    expect(combat.length).toBeGreaterThanOrEqual(7);
    expect(combat.every((i) => i.category === "combat")).toBe(true);
  });

  it("gets a single intent by key", async () => {
    const intent = await store.getIntent("mining-gas");
    expect(intent).not.toBeNull();
    expect(intent!.label).toBe("Gas Mining");
    expect(intent!.category).toBe("mining");
    expect(intent!.icon).toBe("⛽");
    expect(intent!.isBuiltin).toBe(true);
  });

  it("returns null for unknown intent key", async () => {
    expect(await store.getIntent("warp-drive-repair")).toBeNull();
  });

  it("creates a custom intent", async () => {
    const custom = await store.createIntent({
      key: "custom-patrol",
      label: "System Patrol",
      category: "custom",
      description: "Patrolling a star system",
      icon: "🛸",
    });
    expect(custom.key).toBe("custom-patrol");
    expect(custom.isBuiltin).toBe(false);
    expect(custom.category).toBe("custom");
    expect(custom.icon).toBe("🛸");
  });

  it("rejects custom intent with invalid category", async () => {
    await expect(
      store.createIntent({
        key: "bad-cat",
        label: "Bad",
        category: "nonexistent" as never,
        description: null,
        icon: null,
      }),
    ).rejects.toThrow("Invalid category");
  });

  it("rejects custom intent with missing fields", async () => {
    await expect(
      store.createIntent({ key: "", label: "X", category: "custom", description: null, icon: null }),
    ).rejects.toThrow("requires key, label, and category");
  });

  it("rejects duplicate intent key", async () => {
    await store.createIntent({ key: "custom-one", label: "One", category: "custom", description: null, icon: null });
    await expect(
      store.createIntent({ key: "custom-one", label: "Two", category: "custom", description: null, icon: null }),
    ).rejects.toThrow(); // UNIQUE constraint
  });

  it("deletes a custom intent", async () => {
    await store.createIntent({ key: "custom-temp", label: "Temp", category: "custom", description: null, icon: null });
    expect(await store.deleteIntent("custom-temp")).toBe(true);
    expect(await store.getIntent("custom-temp")).toBeNull();
  });

  it("cannot delete a builtin intent", async () => {
    expect(await store.deleteIntent("mining-gas")).toBe(false);
    expect(await store.getIntent("mining-gas")).not.toBeNull();
  });

  it("returns false when deleting nonexistent intent", async () => {
    expect(await store.deleteIntent("does-not-exist")).toBe(false);
  });

  it("exposes valid intent categories", () => {
    expect(VALID_INTENT_CATEGORIES).toEqual(["mining", "combat", "utility", "custom"]);
  });
});

// ─── Dock Loadouts ──────────────────────────────────────────────

describe("DockStore — Dock Loadouts", () => {
  let store: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createDockStore(pool);
  });

  it("creates a dock via upsert", async () => {
    const dock = await store.upsertDock(1, { label: "Main Grinder" });
    expect(dock.dockNumber).toBe(1);
    expect(dock.label).toBe("Main Grinder");
    expect(dock.priority).toBe(0);
    expect(dock.createdAt).toBeTruthy();
  });

  it("updates an existing dock via upsert", async () => {
    await store.upsertDock(1, { label: "Grinder" });
    const updated = await store.upsertDock(1, { label: "Main Grinder", priority: 5 });
    expect(updated.label).toBe("Main Grinder");
    expect(updated.priority).toBe(5);
  });

  it("rejects non-positive dock number", async () => {
    await expect(store.upsertDock(0, { label: "Bad" })).rejects.toThrow("positive integer");
    await expect(store.upsertDock(-1, { label: "Bad" })).rejects.toThrow("positive integer");
    // dock 9+ should now be valid (no upper limit)
    await expect(store.upsertDock(9, { label: "Ok" })).resolves.not.toThrow();
  });

  it("lists all docks with context", async () => {
    await store.upsertDock(1, { label: "Grinder" });
    await store.upsertDock(3, { label: "Mining" });
    const docks = await store.listDocks();
    expect(docks.length).toBe(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[1].dockNumber).toBe(3);
    // Context fields present
    expect(docks[0].intents).toEqual([]);
    expect(docks[0].ships).toEqual([]);
  });

  it("gets a single dock with context", async () => {
    await store.upsertDock(2, { label: "Hostile Swapper", notes: "PvE grind" });
    const dock = await store.getDock(2);
    expect(dock).not.toBeNull();
    expect(dock!.label).toBe("Hostile Swapper");
    expect(dock!.notes).toBe("PvE grind");
    expect(dock!.intents).toEqual([]);
    expect(dock!.ships).toEqual([]);
  });

  it("returns null for nonexistent dock", async () => {
    expect(await store.getDock(5)).toBeNull();
  });

  it("deletes a dock", async () => {
    await store.upsertDock(1, { label: "Temp" });
    expect(await store.deleteDock(1)).toBe(true);
    expect(await store.getDock(1)).toBeNull();
  });

  it("returns false when deleting nonexistent dock", async () => {
    expect(await store.deleteDock(1)).toBe(false);
  });
});

// ─── Dock Intents (N:M) ────────────────────────────────────────

describe("DockStore — Dock Intents", () => {
  let store: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createDockStore(pool);
    await store.upsertDock(1, { label: "Grinder" });
    await store.upsertDock(3, { label: "Mining" });
  });

  it("assigns intents to a dock", async () => {
    await store.setDockIntents(1, ["grinding"]);
    const intents = await store.getDockIntents(1);
    expect(intents.length).toBe(1);
    expect(intents[0].key).toBe("grinding");
    expect(intents[0].label).toBe("Hostile Grinding");
  });

  it("assigns multiple intents to a dock", async () => {
    await store.setDockIntents(3, ["mining-gas", "mining-crystal", "mining-ore"]);
    const intents = await store.getDockIntents(3);
    expect(intents.length).toBe(3);
    const keys = intents.map((i) => i.key);
    expect(keys).toContain("mining-gas");
    expect(keys).toContain("mining-crystal");
    expect(keys).toContain("mining-ore");
  });

  it("replaces intents on repeated set", async () => {
    await store.setDockIntents(1, ["grinding", "pvp"]);
    await store.setDockIntents(1, ["armada"]);
    const intents = await store.getDockIntents(1);
    expect(intents.length).toBe(1);
    expect(intents[0].key).toBe("armada");
  });

  it("clears all intents with empty array", async () => {
    await store.setDockIntents(1, ["grinding"]);
    await store.setDockIntents(1, []);
    expect(await store.getDockIntents(1)).toEqual([]);
  });

  it("auto-creates dock when setting intents on nonexistent dock", async () => {
    await store.setDockIntents(7, ["grinding"]);
    const dock = await store.getDock(7);
    expect(dock).toBeTruthy();
    expect(dock!.intents.length).toBe(1);
    expect(dock!.intents[0].key).toBe("grinding");
  });

  it("rejects unknown intent key", async () => {
    await expect(store.setDockIntents(1, ["warp-field-resonance"])).rejects.toThrow("Unknown intent key");
  });

  it("intents appear in dock context", async () => {
    await store.setDockIntents(3, ["mining-gas", "mining-crystal"]);
    const dock = await store.getDock(3);
    expect(dock!.intents.length).toBe(2);
    expect(dock!.intents[0].isBuiltin).toBe(true);
  });

  it("deleting a dock cascades to its intents", async () => {
    await store.setDockIntents(1, ["grinding", "pvp"]);
    await store.deleteDock(1);
    // Can't query intents for deleted dock, but recreating shows clean state
    await store.upsertDock(1, { label: "New" });
    expect(await store.getDockIntents(1)).toEqual([]);
  });
});

// ─── Dock Ships (Rotation) ─────────────────────────────────────

describe("DockStore — Dock Ships", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    // Reference store creates ships table; dock store needs it for FK refs
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);

    // Create test ships
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "franklin", "U.S.S. Franklin", "Explorer", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);

    // Create test docks
    await dockStore.upsertDock(1, { label: "Main Grinder" });
    await dockStore.upsertDock(2, { label: "Hostile Swapper" });
    await dockStore.upsertDock(3, { label: "Raw Mining" });
  });

  it("adds a ship to a dock rotation", async () => {
    const dockShip = await dockStore.addDockShip(1, "kumari");
    expect(dockShip.dockNumber).toBe(1);
    expect(dockShip.shipId).toBe("kumari");
    expect(dockShip.shipName).toBe("Kumari");
    expect(dockShip.isActive).toBe(false);
    expect(dockShip.sortOrder).toBe(0);
  });

  it("adds a ship with notes", async () => {
    const dockShip = await dockStore.addDockShip(1, "kumari", { notes: "Primary grinder" });
    expect(dockShip.notes).toBe("Primary grinder");
  });

  it("auto-increments sort order within a dock", async () => {
    const s1 = await dockStore.addDockShip(2, "kumari");
    const s2 = await dockStore.addDockShip(2, "franklin");
    expect(s1.sortOrder).toBe(0);
    expect(s2.sortOrder).toBe(1);
  });

  it("rejects duplicate ship in same dock", async () => {
    await dockStore.addDockShip(1, "kumari");
    await expect(dockStore.addDockShip(1, "kumari")).rejects.toThrow("already assigned to dock 1");
  });

  it("allows same ship in different docks", async () => {
    const d1 = await dockStore.addDockShip(1, "kumari");
    const d2 = await dockStore.addDockShip(2, "kumari");
    expect(d1.dockNumber).toBe(1);
    expect(d2.dockNumber).toBe(2);
  });

  it("rejects ship not in reference catalog", async () => {
    await expect(dockStore.addDockShip(1, "nonexistent-ship")).rejects.toThrow("not found in reference catalog");
  });

  it("auto-creates dock when adding ship to nonexistent dock", async () => {
    await dockStore.addDockShip(7, "kumari");
    const dock = await dockStore.getDock(7);
    expect(dock).toBeTruthy();
    expect((await dockStore.getDockShips(7)).length).toBe(1);
  });

  it("removes a ship from a dock", async () => {
    await dockStore.addDockShip(1, "kumari");
    expect(await dockStore.removeDockShip(1, "kumari")).toBe(true);
    expect(await dockStore.getDockShips(1)).toEqual([]);
  });

  it("returns false when removing non-assigned ship", async () => {
    expect(await dockStore.removeDockShip(1, "kumari")).toBe(false);
  });

  it("lists ships in a dock ordered by sort_order", async () => {
    await dockStore.addDockShip(2, "kumari");
    await dockStore.addDockShip(2, "franklin");
    const ships = await dockStore.getDockShips(2);
    expect(ships.length).toBe(2);
    expect(ships[0].shipId).toBe("kumari");
    expect(ships[1].shipId).toBe("franklin");
  });

  it("sets a ship as active (clears others)", async () => {
    await dockStore.addDockShip(2, "kumari");
    await dockStore.addDockShip(2, "franklin");

    const updated = await dockStore.updateDockShip(2, "franklin", { isActive: true });
    expect(updated!.isActive).toBe(true);

    // kumari should now be inactive
    const ships = await dockStore.getDockShips(2);
    const kumari = ships.find((s) => s.shipId === "kumari");
    const franklin = ships.find((s) => s.shipId === "franklin");
    expect(kumari!.isActive).toBe(false);
    expect(franklin!.isActive).toBe(true);
  });

  it("deactivates a ship", async () => {
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });
    await dockStore.updateDockShip(1, "kumari", { isActive: false });
    const ships = await dockStore.getDockShips(1);
    expect(ships[0].isActive).toBe(false);
  });

  it("updates sort order", async () => {
    await dockStore.addDockShip(2, "kumari");
    await dockStore.addDockShip(2, "franklin");
    await dockStore.updateDockShip(2, "franklin", { sortOrder: -1 });
    const ships = await dockStore.getDockShips(2);
    // franklin (-1) should sort before kumari (0)
    expect(ships[0].shipId).toBe("franklin");
    expect(ships[1].shipId).toBe("kumari");
  });

  it("updates notes", async () => {
    await dockStore.addDockShip(1, "kumari");
    const updated = await dockStore.updateDockShip(1, "kumari", { notes: "Best grinder" });
    expect(updated!.notes).toBe("Best grinder");
  });

  it("returns null when updating non-assigned ship", async () => {
    expect(await dockStore.updateDockShip(1, "kumari", { isActive: true })).toBeNull();
  });

  it("ships appear in dock context", async () => {
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });
    const dock = await dockStore.getDock(1);
    expect(dock!.ships.length).toBe(1);
    expect(dock!.ships[0].shipName).toBe("Kumari");
    expect(dock!.ships[0].isActive).toBe(true);
  });

  it("deleting a dock cascades to its ships", async () => {
    await dockStore.addDockShip(1, "kumari");
    await dockStore.deleteDock(1);
    await dockStore.upsertDock(1, { label: "New" });
    expect(await dockStore.getDockShips(1)).toEqual([]);
  });
});

// ─── Diagnostics ────────────────────────────────────────────────

describe("DockStore — Diagnostics", () => {
  let store: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createDockStore(pool);
  });

  it("counts entities correctly", async () => {
    const counts = await store.counts();
    expect(counts.intents).toBeGreaterThanOrEqual(21); // seed data
    expect(counts.docks).toBe(0);
    expect(counts.dockShips).toBe(0);
  });

  it("reports store is truthy", () => {
    expect(store).toBeTruthy();
  });
});

// ─── Crew Presets ───────────────────────────────────────────────

describe("DockStore — Crew Presets", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    // Create test ships and officers
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "mccoy", "McCoy", "Rare", "TOS");
    await seedOfficer(refStore, "stonn", "Stonn", "Common", "TOS");
  });

  it("creates a crew preset", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Main Grind Crew" });
    expect(preset.id).toBeGreaterThan(0);
    expect(preset.shipId).toBe("kumari");
    expect(preset.intentKey).toBe("grinding");
    expect(preset.presetName).toBe("Main Grind Crew");
    expect(preset.isDefault).toBe(false);
    expect(preset.shipName).toBe("Kumari");
    expect(preset.intentLabel).toBe("Hostile Grinding");
    expect(preset.members).toEqual([]);
  });

  it("creates a default preset and clears others", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew A", isDefault: true });
    const p2 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew B", isDefault: true });
    // p2 should be default, p1 should have been cleared
    expect(p2.isDefault).toBe(true);
    const p1Refreshed = await dockStore.getPreset(p1.id);
    expect(p1Refreshed!.isDefault).toBe(false);
  });

  it("rejects preset for nonexistent ship", async () => {
    await expect(dockStore.createPreset({ shipId: "nope", intentKey: "grinding", presetName: "x" }))
      .rejects.toThrow(/not found in reference catalog/);
  });

  it("rejects preset for nonexistent intent", async () => {
    await expect(dockStore.createPreset({ shipId: "kumari", intentKey: "nope", presetName: "x" }))
      .rejects.toThrow(/not found in catalog/);
  });

  it("rejects duplicate preset name for same ship+intent", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Same" });
    await expect(dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Same" }))
      .rejects.toThrow(/already exists/);
  });

  it("allows same preset name for different ship or intent", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Alpha" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "grinding", presetName: "Alpha" });
    await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "Alpha" });
    expect((await dockStore.listPresets()).length).toBe(3);
  });

  it("gets a preset by ID", async () => {
    const created = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Test" });
    const preset = await dockStore.getPreset(created.id);
    expect(preset).not.toBeNull();
    expect(preset!.presetName).toBe("Test");
  });

  it("returns null for nonexistent preset", async () => {
    expect(await dockStore.getPreset(999)).toBeNull();
  });

  it("lists presets unfiltered", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = await dockStore.listPresets();
    expect(presets.length).toBe(2);
  });

  it("filters presets by shipId", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = await dockStore.listPresets({ shipId: "kumari" });
    expect(presets.length).toBe(1);
    expect(presets[0].shipId).toBe("kumari");
  });

  it("filters presets by intentKey", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = await dockStore.listPresets({ intentKey: "grinding" });
    expect(presets.length).toBe(1);
    expect(presets[0].intentKey).toBe("grinding");
  });

  it("filters presets by both shipId and intentKey", async () => {
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "B" });
    const presets = await dockStore.listPresets({ shipId: "kumari", intentKey: "grinding" });
    expect(presets.length).toBe(1);
  });

  it("updates a preset name", async () => {
    const created = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Old" });
    const updated = await dockStore.updatePreset(created.id, { presetName: "New" });
    expect(updated!.presetName).toBe("New");
  });

  it("updates isDefault flag", async () => {
    const created = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    expect(created.isDefault).toBe(false);
    const updated = await dockStore.updatePreset(created.id, { isDefault: true });
    expect(updated!.isDefault).toBe(true);
  });

  it("returns null when updating nonexistent preset", async () => {
    expect(await dockStore.updatePreset(999, { presetName: "x" })).toBeNull();
  });

  it("deletes a preset", async () => {
    const created = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Del" });
    expect(await dockStore.deletePreset(created.id)).toBe(true);
    expect(await dockStore.getPreset(created.id)).toBeNull();
  });

  it("returns false when deleting nonexistent preset", async () => {
    expect(await dockStore.deletePreset(999)).toBe(false);
  });

  it("requires missing fields", async () => {
    await expect(dockStore.createPreset({ shipId: "", intentKey: "grinding", presetName: "x" }))
      .rejects.toThrow(/requires/);
  });
});

// ─── Crew Preset Members ────────────────────────────────────────

describe("DockStore — Crew Preset Members", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "mccoy", "McCoy", "Rare", "TOS");
  });

  it("sets preset members", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    const members = await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
      { officerId: "mccoy", roleType: "bridge", slot: "officer_2" },
    ]);
    expect(members.length).toBe(3);
    expect(members[0].officerName).toBe("Kirk");
    expect(members[0].roleType).toBe("bridge");
    expect(members[0].slot).toBe("captain");
  });

  it("replaces members on repeated set", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
    ]);
    const members = await dockStore.setPresetMembers(preset.id, [
      { officerId: "spock", roleType: "bridge", slot: "captain" },
    ]);
    expect(members.length).toBe(1);
    expect(members[0].officerName).toBe("Spock");
  });

  it("members appear in preset via getPreset", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);
    const full = await dockStore.getPreset(preset.id);
    expect(full!.members.length).toBe(2);
  });

  it("rejects nonexistent preset", async () => {
    await expect(dockStore.setPresetMembers(999, [{ officerId: "kirk", roleType: "bridge" }]))
      .rejects.toThrow(/not found/);
  });

  it("rejects nonexistent officer", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await expect(dockStore.setPresetMembers(preset.id, [{ officerId: "nope", roleType: "bridge" }]))
      .rejects.toThrow(/not found in reference catalog/);
  });

  it("rejects invalid roleType", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await expect(dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "invalid" as "bridge" },
    ])).rejects.toThrow(/Invalid roleType/);
  });

  it("clears members with empty array", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await dockStore.setPresetMembers(preset.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const members = await dockStore.setPresetMembers(preset.id, []);
    expect(members.length).toBe(0);
  });

  it("deleting a preset cascades to members", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    await dockStore.setPresetMembers(preset.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await dockStore.deletePreset(preset.id);
    // Verify via counts
    const counts = await dockStore.counts();
    expect(counts.presets).toBe(0);
    expect(counts.presetMembers).toBe(0);
  });
});

// ─── Officer Conflicts ──────────────────────────────────────────

describe("DockStore — Officer Conflicts", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  });

  it("returns empty when no conflicts", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const conflicts = await dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("detects officer appearing in multiple presets", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const conflicts = await dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].officerId).toBe("kirk");
    expect(conflicts[0].officerName).toBe("Kirk");
    expect(conflicts[0].appearances.length).toBe(2);
  });

  it("does not flag officers in same preset as conflicts", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.setPresetMembers(p1.id, [
      { officerId: "kirk", roleType: "bridge" },
      { officerId: "spock", roleType: "bridge" },
    ]);
    const conflicts = await dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("resolves dock numbers for conflicting ships", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.addDockShip(1, "kumari");
    await dockStore.upsertDock(2, { label: "Mining" });
    await dockStore.addDockShip(2, "botany-bay");

    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);

    const conflicts = await dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    const kumariAppearance = conflicts[0].appearances.find((a) => a.shipId === "kumari");
    expect(kumariAppearance!.dockNumbers).toContain(1);
    const botanyAppearance = conflicts[0].appearances.find((a) => a.shipId === "botany-bay");
    expect(botanyAppearance!.dockNumbers).toContain(2);
  });
});

// ─── Tags & Discovery ──────────────────────────────────────────

describe("DockStore — Preset Tags", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  });

  it("sets and retrieves tags for a preset", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    const tags = await dockStore.setPresetTags(preset.id, ["meta", "federation-synergy", "event"]);
    expect(tags).toEqual(["event", "federation-synergy", "meta"]); // sorted
  });

  it("normalizes tags to lowercase and trims whitespace", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    const tags = await dockStore.setPresetTags(preset.id, [" Meta ", "BUDGET", "  tos  "]);
    expect(tags).toEqual(["budget", "meta", "tos"]);
  });

  it("replaces tags on subsequent calls (full replace)", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    await dockStore.setPresetTags(preset.id, ["meta", "event"]);
    const tags = await dockStore.setPresetTags(preset.id, ["budget"]);
    expect(tags).toEqual(["budget"]);
  });

  it("clears tags with empty array", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    await dockStore.setPresetTags(preset.id, ["meta"]);
    const tags = await dockStore.setPresetTags(preset.id, []);
    expect(tags).toEqual([]);
  });

  it("throws for non-existent preset", async () => {
    await expect(dockStore.setPresetTags(999, ["meta"])).rejects.toThrow("Preset 999 not found");
  });

  it("ignores empty/whitespace-only tags", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    const tags = await dockStore.setPresetTags(preset.id, ["meta", "", "  ", "budget"]);
    expect(tags).toEqual(["budget", "meta"]);
  });

  it("deduplicates tags", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    const tags = await dockStore.setPresetTags(preset.id, ["meta", "Meta", "META"]);
    expect(tags).toEqual(["meta"]);
  });

  it("includes tags in resolved preset", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    await dockStore.setPresetTags(preset.id, ["meta", "event"]);
    const resolved = await dockStore.getPreset(preset.id);
    expect(resolved!.tags).toEqual(["event", "meta"]);
  });

  it("returns empty tags array for preset with no tags", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    expect(preset.tags).toEqual([]);
  });

  it("cascades tag deletion when preset is deleted", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
    await dockStore.setPresetTags(preset.id, ["meta", "event"]);
    await dockStore.deletePreset(preset.id);
    expect(await dockStore.listAllTags()).toEqual([]);
  });

  it("lists all unique tags across presets", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetTags(p1.id, ["meta", "event"]);
    await dockStore.setPresetTags(p2.id, ["meta", "budget"]);
    expect(await dockStore.listAllTags()).toEqual(["budget", "event", "meta"]);
  });

  it("filters presets by tag", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetTags(p1.id, ["meta"]);
    await dockStore.setPresetTags(p2.id, ["budget"]);
    const metaPresets = await dockStore.listPresets({ tag: "meta" });
    expect(metaPresets.length).toBe(1);
    expect(metaPresets[0].presetName).toBe("A");
  });

  it("filters presets by officerId", async () => {
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await dockStore.setPresetMembers(p2.id, [{ officerId: "spock", roleType: "bridge" }]);
    const kirkPresets = await dockStore.listPresets({ officerId: "kirk" });
    expect(kirkPresets.length).toBe(1);
    expect(kirkPresets[0].presetName).toBe("A");
  });

  it("counts tags in diagnostics", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.setPresetTags(preset.id, ["meta", "event"]);
    expect((await dockStore.counts()).tags).toBe(2);
  });
});

describe("DockStore — Find Presets For Dock", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
  });

  it("finds presets matching a dock's ships and intents", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");

    // This preset matches: kumari is in dock 1, grinding is an intent of dock 1
    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Match" });
    // This preset doesn't match: botany-bay is NOT in dock 1
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "grinding", presetName: "No Match" });
    // This preset doesn't match: mining-gas is NOT an intent of dock 1
    const p3 = await dockStore.createPreset({ shipId: "kumari", intentKey: "mining-gas", presetName: "Wrong Intent" });

    const found = await dockStore.findPresetsForDock(1);
    expect(found.length).toBe(1);
    expect(found[0].presetName).toBe("Match");
  });

  it("returns empty for dock with no ships", async () => {
    await dockStore.upsertDock(2, { label: "Empty" });
    await dockStore.setDockIntents(2, ["grinding"]);
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    expect(await dockStore.findPresetsForDock(2)).toEqual([]);
  });

  it("returns empty for dock with no intents", async () => {
    await dockStore.upsertDock(3, { label: "No Intents" });
    await dockStore.addDockShip(3, "kumari");
    await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    expect(await dockStore.findPresetsForDock(3)).toEqual([]);
  });

  it("finds multiple matching presets for multi-intent dock", async () => {
    await dockStore.upsertDock(1, { label: "Mining Hub" });
    await dockStore.setDockIntents(1, ["mining-gas", "mining-crystal"]);
    await dockStore.addDockShip(1, "botany-bay");

    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "Gas Crew" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-crystal", presetName: "Crystal Crew" });
    await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-ore", presetName: "Ore Crew" });

    const found = await dockStore.findPresetsForDock(1);
    expect(found.length).toBe(2);
    expect(found.map((p) => p.presetName).sort()).toEqual(["Crystal Crew", "Gas Crew"]);
  });

  it("includes tags in found presets", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    const p = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    await dockStore.setPresetTags(p.id, ["meta"]);
    const found = await dockStore.findPresetsForDock(1);
    expect(found[0].tags).toEqual(["meta"]);
  });
});

// ─── Dock Briefing Builder ──────────────────────────────────────

describe("DockStore — Dock Briefing", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
    await seedShip(refStore, "botany-bay", "Botany Bay", "Survey", 2);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "mccoy", "McCoy", "Rare", "TOS");
  });

  it("returns empty briefing when no docks exist", async () => {
    const briefing = await dockStore.buildBriefing();
    expect(briefing.statusLines.length).toBe(0);
    expect(briefing.text).toBe("");
    expect(briefing.totalChars).toBe(0);
  });

  it("generates Tier 1 status lines", async () => {
    await dockStore.upsertDock(1, { label: "Main Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = await dockStore.buildBriefing();
    expect(briefing.statusLines.length).toBe(1);
    expect(briefing.statusLines[0]).toContain("D1");
    expect(briefing.statusLines[0]).toContain('"Main Grinder"');
    expect(briefing.statusLines[0]).toContain("grinding");
    expect(briefing.statusLines[0]).toContain("Kumari (active)");
  });

  it("shows (none active) when ships exist but none active", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.addDockShip(1, "kumari");

    const briefing = await dockStore.buildBriefing();
    expect(briefing.statusLines[0]).toContain("none active");
  });

  it("generates Tier 2 crew lines from presets", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });

    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Main Crew" });
    await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);

    const briefing = await dockStore.buildBriefing();
    expect(briefing.crewLines.length).toBe(1);
    expect(briefing.crewLines[0]).toContain("Kirk(cpt)");
    expect(briefing.crewLines[0]).toContain("Spock");
  });

  it("includes tags in crew lines when preset has tags", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });

    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Main Crew" });
    await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
    ]);
    await dockStore.setPresetTags(preset.id, ["meta", "federation"]);

    const briefing = await dockStore.buildBriefing();
    expect(briefing.crewLines[0]).toContain("[federation, meta]");
  });

  it("shows model-suggest fallback when no preset crew", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = await dockStore.buildBriefing();
    expect(briefing.crewLines[0]).toContain("model will suggest");
  });

  it("generates conflict lines", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.upsertDock(2, { label: "Mining" });
    await dockStore.addDockShip(1, "kumari");
    await dockStore.addDockShip(2, "botany-bay");

    const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = await dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);

    const briefing = await dockStore.buildBriefing();
    expect(briefing.conflictLines.length).toBe(1);
    expect(briefing.conflictLines[0]).toContain("Kirk");
  });

  it("generates insight for single-ship docks", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.addDockShip(1, "kumari");

    const briefing = await dockStore.buildBriefing();
    expect(briefing.insights.some((i) => i.includes("single point of failure"))).toBe(true);
  });

  it("generates insight for no-active-ship docks", async () => {
    await dockStore.upsertDock(1, { label: "Grinder" });
    await dockStore.addDockShip(1, "kumari");
    await dockStore.addDockShip(1, "botany-bay");

    const briefing = await dockStore.buildBriefing();
    expect(briefing.insights.some((i) => i.includes("none marked active"))).toBe(true);
  });

  it("assembles text with all tiers", async () => {
    await dockStore.upsertDock(1, { label: "Main Grinder" });
    await dockStore.setDockIntents(1, ["grinding"]);
    await dockStore.addDockShip(1, "kumari");
    await dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = await dockStore.buildBriefing();
    expect(briefing.text).toContain("DRYDOCK STATUS");
    expect(briefing.text).toContain("ACTIVE CREW");
    expect(briefing.totalChars).toBeGreaterThan(0);
  });

  it("counts include presets and presetMembers", async () => {
    const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Test" });
    await dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge" },
    ]);
    const counts = await dockStore.counts();
    expect(counts.presets).toBe(1);
    expect(counts.presetMembers).toBe(1);
  });
});

// ─── API Routes ─────────────────────────────────────────────────

import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";
import { bootstrapConfigSync } from "../src/server/config.js";

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    geminiEngine: null,
    memoryService: null,
    frameStoreFactory: null,
    settingsStore: null,
    sessionStore: null,
    dockStore: null,
    behaviorStore: null,
    referenceStore: null,
    overlayStore: null,
    inviteStore: null,
    startupComplete: false,
    config: bootstrapConfigSync(),
    ...overrides,
  };
}

describe("Dock API Routes", () => {
  let dockStore: DockStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    dockStore = await createDockStore(pool);
    // Create test ships for dock rotation tests
    await seedShip(refStore, "kumari", "Kumari", "Interceptor", 3);
  });

  // ── Intents ─────────────────────────────────────────────

  describe("GET /api/dock/intents", () => {
    it("returns all intents", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/intents");
      expect(res.status).toBe(200);
      expect(res.body.data.intents.length).toBeGreaterThanOrEqual(21);
      expect(res.body.data.count).toBeGreaterThanOrEqual(21);
    });

    it("filters by category", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/intents?category=mining");
      expect(res.status).toBe(200);
      expect(res.body.data.intents.every((i: { category: string }) => i.category === "mining")).toBe(true);
    });

    it("rejects invalid category", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/intents?category=bogus");
      expect(res.status).toBe(400);
    });

    it("returns 503 when dock store unavailable", async () => {
      const app = createApp(makeState());
      const res = await request(app).get("/api/dock/intents");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /api/dock/intents", () => {
    it("creates a custom intent", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/dock/intents")
        .send({ key: "custom-scout", label: "Scouting", category: "custom" });
      expect(res.status).toBe(201);
      expect(res.body.data.key).toBe("custom-scout");
      expect(res.body.data.isBuiltin).toBe(false);
    });

    it("rejects missing fields", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/dock/intents")
        .send({ key: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/dock/intents/:key", () => {
    it("deletes a custom intent", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.createIntent({ key: "custom-del", label: "Del", category: "custom", description: null, icon: null });
      const res = await request(app).delete("/api/dock/intents/custom-del");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("deleted");
    });

    it("rejects deleting builtin intent", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/dock/intents/mining-gas");
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/built-in/i);
    });
  });

  // ── Docks ───────────────────────────────────────────────

  describe("PUT /api/dock/docks/:num", () => {
    it("creates a dock", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .put("/api/dock/docks/1")
        .send({ label: "Main Grinder", priority: 3 });
      expect(res.status).toBe(200);
      expect(res.body.data.dockNumber).toBe(1);
      expect(res.body.data.label).toBe("Main Grinder");
    });

    it("rejects invalid dock number", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).put("/api/dock/docks/0").send({ label: "Bad" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/dock/docks", () => {
    it("lists docks with context", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      await dockStore.upsertDock(2, { label: "Mining" });
      const res = await request(app).get("/api/dock/docks");
      expect(res.status).toBe(200);
      expect(res.body.data.docks.length).toBe(2);
      expect(res.body.data.docks[0]).toHaveProperty("intents");
      expect(res.body.data.docks[0]).toHaveProperty("ships");
    });
  });

  describe("GET /api/dock/docks/:num", () => {
    it("returns a dock with context", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app).get("/api/dock/docks/1");
      expect(res.status).toBe(200);
      expect(res.body.data.label).toBe("Grinder");
    });

    it("returns 404 for nonexistent dock", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/docks/5");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/dock/docks/:num", () => {
    it("deletes a dock", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Temp" });
      const res = await request(app).delete("/api/dock/docks/1");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("deleted");
    });
  });

  // ── Dock Intents ────────────────────────────────────────

  describe("PUT /api/dock/docks/:num/intents", () => {
    it("sets dock intents", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .put("/api/dock/docks/1/intents")
        .send({ intents: ["grinding", "pvp"] });
      expect(res.status).toBe(200);
      expect(res.body.data.intents.length).toBe(2);
      expect(res.body.data.count).toBe(2);
    });

    it("rejects non-array intents", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .put("/api/dock/docks/1/intents")
        .send({ intents: "grinding" });
      expect(res.status).toBe(400);
    });
  });

  // ── Dock Ships ──────────────────────────────────────────

  describe("POST /api/dock/docks/:num/ships", () => {
    it("adds a ship to dock rotation", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .post("/api/dock/docks/1/ships")
        .send({ shipId: "kumari" });
      expect(res.status).toBe(201);
      expect(res.body.data.shipId).toBe("kumari");
      expect(res.body.data.shipName).toBe("Kumari");
    });

    it("rejects missing shipId", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .post("/api/dock/docks/1/ships")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/dock/docks/:num/ships/:shipId", () => {
    it("sets a ship as active", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      await dockStore.addDockShip(1, "kumari");
      const res = await request(app)
        .patch("/api/dock/docks/1/ships/kumari")
        .send({ isActive: true });
      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it("returns 404 for non-assigned ship", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .patch("/api/dock/docks/1/ships/kumari")
        .send({ isActive: true });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/dock/docks/:num/ships/:shipId", () => {
    it("removes a ship from dock", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      await dockStore.addDockShip(1, "kumari");
      const res = await request(app).delete("/api/dock/docks/1/ships/kumari");
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("removed");
    });

    it("returns 404 for non-assigned ship", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/dock/docks/1/ships/kumari");
      expect(res.status).toBe(404);
    });
  });

  // ── Crew Presets ────────────────────────────────────────

  describe("POST /api/dock/presets", () => {
    it("creates a crew preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/dock/presets")
        .send({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
      expect(res.status).toBe(201);
      expect(res.body.data.shipId).toBe("kumari");
      expect(res.body.data.presetName).toBe("Grind Crew");
      expect(res.body.data.members).toEqual([]);
    });

    it("rejects missing fields", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/dock/presets")
        .send({ shipId: "kumari" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/dock/presets", () => {
    it("lists presets", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get("/api/dock/presets");
      expect(res.status).toBe(200);
      expect(res.body.data.presets.length).toBe(1);
      expect(res.body.data.count).toBe(1);
    });

    it("filters by shipId", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get("/api/dock/presets?shipId=kumari");
      expect(res.status).toBe(200);
      expect(res.body.data.presets.length).toBe(1);
    });
  });

  describe("GET /api/dock/presets/:id", () => {
    it("returns a preset with members", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get(`/api/dock/presets/${preset.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.presetName).toBe("A");
      expect(res.body.data.members).toEqual([]);
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/presets/999");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/dock/presets/:id", () => {
    it("updates a preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Old" });
      const res = await request(app)
        .patch(`/api/dock/presets/${preset.id}`)
        .send({ presetName: "New" });
      expect(res.status).toBe(200);
      expect(res.body.data.presetName).toBe("New");
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .patch("/api/dock/presets/999")
        .send({ presetName: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/dock/presets/:id", () => {
    it("deletes a preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Del" });
      const res = await request(app).delete(`/api/dock/presets/${preset.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("deleted");
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/dock/presets/999");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/dock/presets/:id/members", () => {
    it("sets preset members", async () => {
      await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/dock/presets/${preset.id}/members`)
        .send({ members: [{ officerId: "kirk", roleType: "bridge", slot: "captain" }] });
      expect(res.status).toBe(200);
      expect(res.body.data.members.length).toBe(1);
      expect(res.body.data.members[0].officerName).toBe("Kirk");
    });

    it("rejects non-array members", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/dock/presets/${preset.id}/members`)
        .send({ members: "kirk" });
      expect(res.status).toBe(400);
    });
  });

  // ── Computed Endpoints ──────────────────────────────────

  describe("GET /api/dock/docks/summary", () => {
    it("returns a dock briefing", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app).get("/api/dock/docks/summary");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("statusLines");
      expect(res.body.data).toHaveProperty("text");
      expect(res.body.data).toHaveProperty("totalChars");
    });
  });

  describe("GET /api/dock/docks/conflicts", () => {
    it("returns officer conflicts", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/docks/conflicts");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("conflicts");
      expect(res.body.data).toHaveProperty("count");
    });
  });

  // ── Tags & Discovery Endpoints ──────────────────────────

  describe("PUT /api/dock/presets/:id/tags", () => {
    it("sets tags on a preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/dock/presets/${preset.id}/tags`)
        .send({ tags: ["meta", "event"] });
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toEqual(["event", "meta"]);
      expect(res.body.data.count).toBe(2);
    });

    it("rejects non-array tags", async () => {
      const app = createApp(makeState({ dockStore }));
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/dock/presets/${preset.id}/tags`)
        .send({ tags: "meta" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for non-existent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .put("/api/dock/presets/999/tags")
        .send({ tags: ["meta"] });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/dock/tags", () => {
    it("lists all unique tags", async () => {
      const app = createApp(makeState({ dockStore }));
      const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      await dockStore.setPresetTags(p1.id, ["meta", "event"]);
      const res = await request(app).get("/api/dock/tags");
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toEqual(["event", "meta"]);
      expect(res.body.data.count).toBe(2);
    });
  });

  describe("GET /api/dock/presets?tag=", () => {
    it("filters presets by tag", async () => {
      const app = createApp(makeState({ dockStore }));
      const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      await dockStore.setPresetTags(p1.id, ["meta"]);
      await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "B" });
      const res = await request(app).get("/api/dock/presets?tag=meta");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.presets[0].presetName).toBe("A");
    });
  });

  describe("GET /api/dock/presets?officerId=", () => {
    it("filters presets by officer", async () => {
      await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
      const app = createApp(makeState({ dockStore }));
      const p1 = await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      await dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
      await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "B" });
      const res = await request(app).get("/api/dock/presets?officerId=kirk");
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.presets[0].presetName).toBe("A");
    });
  });

  describe("GET /api/dock/docks/:num/presets", () => {
    it("finds presets relevant to a dock", async () => {
      const app = createApp(makeState({ dockStore }));
      await dockStore.upsertDock(1, { label: "Grinder" });
      await dockStore.setDockIntents(1, ["grinding"]);
      await dockStore.addDockShip(1, "kumari");
      await dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Match" });
      await dockStore.createPreset({ shipId: "kumari", intentKey: "mining-gas", presetName: "No Match" });
      const res = await request(app).get("/api/dock/docks/1/presets");
      expect(res.status).toBe(200);
      expect(res.body.data.dockNumber).toBe(1);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.presets[0].presetName).toBe("Match");
    });

    it("returns 400 for invalid dock number", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/docks/0/presets");
      expect(res.status).toBe(400);
    });
  });

  // ── Cascade Preview Routes ──────────────────────────────

  describe("GET /api/dock/docks/:num/cascade-preview", () => {
    it("returns empty preview for dock with no data", async () => {
      await dockStore.upsertDock(1, { label: "Empty" });
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/docks/1/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.shipCount).toBe(0);
      expect(res.body.data.intentCount).toBe(0);
      expect(res.body.data.ships).toEqual([]);
      expect(res.body.data.intents).toEqual([]);
    });

    it("returns ships and intents that would be deleted", async () => {
      await dockStore.upsertDock(1, { label: "Test" });
      await dockStore.addDockShip(1, "kumari");
      await dockStore.setDockIntents(1, ["pvp"]);
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/docks/1/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.shipCount).toBe(1);
      expect(res.body.data.intentCount).toBe(1);
      expect(res.body.data.ships[0].shipName).toBe("Kumari");
      expect(res.body.data.intents[0].label).toBe("PvP/Raiding");
    });
  });

  describe("GET /api/dock/ships/:id/cascade-preview", () => {
    it("returns dock assignments and presets for a ship", async () => {
      await dockStore.upsertDock(1, { label: "Dock 1" });
      await dockStore.addDockShip(1, "kumari");
      await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "Arena Build" });
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/ships/kumari/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.dockAssignments.length).toBe(1);
      expect(res.body.data.dockAssignments[0].dockLabel).toBe("Dock 1");
      expect(res.body.data.crewPresets.length).toBe(1);
      expect(res.body.data.crewPresets[0].presetName).toBe("Arena Build");
    });

    it("returns empty for ship with no references", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/ships/kumari/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.dockAssignments).toEqual([]);
      expect(res.body.data.crewPresets).toEqual([]);
    });
  });

  describe("GET /api/dock/officers/:id/cascade-preview", () => {
    it("returns preset memberships for an officer", async () => {
      await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
      const preset = await dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "Arena Build" });
      await dockStore.setPresetMembers(preset.id, [{ officerId: "kirk", roleType: "bridge", slot: "captain" }]);
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/officers/kirk/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.presetMemberships.length).toBe(1);
      expect(res.body.data.presetMemberships[0].presetName).toBe("Arena Build");
    });

    it("returns empty for officer with no references", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/dock/officers/kirk/cascade-preview");
      expect(res.status).toBe(200);
      expect(res.body.data.presetMemberships).toEqual([]);
    });
  });
});
