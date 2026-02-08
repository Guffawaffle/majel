/**
 * dock-store.test.ts — Drydock Loadout Data Layer Tests (ADR-010 Phases 1 & 2)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createDockStore,
  VALID_INTENT_CATEGORIES,
  type DockStore,
} from "../src/server/dock-store.js";
import { createFleetStore, type FleetStore } from "../src/server/fleet-store.js";

const TEST_DB = path.resolve(".test-dock.db");

// ─── Intent Catalog ─────────────────────────────────────────────

describe("DockStore — Intent Catalog", () => {
  let store: DockStore;

  beforeEach(() => {
    store = createDockStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("seeds builtin intents on first create", () => {
    const intents = store.listIntents();
    expect(intents.length).toBeGreaterThanOrEqual(21);
    const keys = intents.map((i) => i.key);
    expect(keys).toContain("mining-gas");
    expect(keys).toContain("grinding");
    expect(keys).toContain("exploration");
  });

  it("all seed intents are marked builtin", () => {
    const intents = store.listIntents();
    const builtins = intents.filter((i) => i.isBuiltin);
    expect(builtins.length).toBeGreaterThanOrEqual(21);
  });

  it("filters intents by category", () => {
    const mining = store.listIntents({ category: "mining" });
    expect(mining.length).toBeGreaterThanOrEqual(9);
    expect(mining.every((i) => i.category === "mining")).toBe(true);

    const combat = store.listIntents({ category: "combat" });
    expect(combat.length).toBeGreaterThanOrEqual(7);
    expect(combat.every((i) => i.category === "combat")).toBe(true);
  });

  it("gets a single intent by key", () => {
    const intent = store.getIntent("mining-gas");
    expect(intent).not.toBeNull();
    expect(intent!.label).toBe("Gas Mining");
    expect(intent!.category).toBe("mining");
    expect(intent!.icon).toBe("⛽");
    expect(intent!.isBuiltin).toBe(true);
  });

  it("returns null for unknown intent key", () => {
    expect(store.getIntent("warp-drive-repair")).toBeNull();
  });

  it("creates a custom intent", () => {
    const custom = store.createIntent({
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

  it("rejects custom intent with invalid category", () => {
    expect(() =>
      store.createIntent({
        key: "bad-cat",
        label: "Bad",
        category: "nonexistent" as never,
        description: null,
        icon: null,
      }),
    ).toThrow("Invalid category");
  });

  it("rejects custom intent with missing fields", () => {
    expect(() =>
      store.createIntent({ key: "", label: "X", category: "custom", description: null, icon: null }),
    ).toThrow("requires key, label, and category");
  });

  it("rejects duplicate intent key", () => {
    store.createIntent({ key: "custom-one", label: "One", category: "custom", description: null, icon: null });
    expect(() =>
      store.createIntent({ key: "custom-one", label: "Two", category: "custom", description: null, icon: null }),
    ).toThrow(); // UNIQUE constraint
  });

  it("deletes a custom intent", () => {
    store.createIntent({ key: "custom-temp", label: "Temp", category: "custom", description: null, icon: null });
    expect(store.deleteIntent("custom-temp")).toBe(true);
    expect(store.getIntent("custom-temp")).toBeNull();
  });

  it("cannot delete a builtin intent", () => {
    expect(store.deleteIntent("mining-gas")).toBe(false);
    expect(store.getIntent("mining-gas")).not.toBeNull();
  });

  it("returns false when deleting nonexistent intent", () => {
    expect(store.deleteIntent("does-not-exist")).toBe(false);
  });

  it("exposes valid intent categories", () => {
    expect(VALID_INTENT_CATEGORIES).toEqual(["mining", "combat", "utility", "custom"]);
  });
});

// ─── Dock Loadouts ──────────────────────────────────────────────

describe("DockStore — Dock Loadouts", () => {
  let store: DockStore;

  beforeEach(() => {
    store = createDockStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a dock via upsert", () => {
    const dock = store.upsertDock(1, { label: "Main Grinder" });
    expect(dock.dockNumber).toBe(1);
    expect(dock.label).toBe("Main Grinder");
    expect(dock.priority).toBe(0);
    expect(dock.createdAt).toBeTruthy();
  });

  it("updates an existing dock via upsert", () => {
    store.upsertDock(1, { label: "Grinder" });
    const updated = store.upsertDock(1, { label: "Main Grinder", priority: 5 });
    expect(updated.label).toBe("Main Grinder");
    expect(updated.priority).toBe(5);
  });

  it("rejects dock number outside 1-8", () => {
    expect(() => store.upsertDock(0, { label: "Bad" })).toThrow("between 1 and 8");
    expect(() => store.upsertDock(9, { label: "Bad" })).toThrow("between 1 and 8");
  });

  it("lists all docks with context", () => {
    store.upsertDock(1, { label: "Grinder" });
    store.upsertDock(3, { label: "Mining" });
    const docks = store.listDocks();
    expect(docks.length).toBe(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[1].dockNumber).toBe(3);
    // Context fields present
    expect(docks[0].intents).toEqual([]);
    expect(docks[0].ships).toEqual([]);
  });

  it("gets a single dock with context", () => {
    store.upsertDock(2, { label: "Hostile Swapper", notes: "PvE grind" });
    const dock = store.getDock(2);
    expect(dock).not.toBeNull();
    expect(dock!.label).toBe("Hostile Swapper");
    expect(dock!.notes).toBe("PvE grind");
    expect(dock!.intents).toEqual([]);
    expect(dock!.ships).toEqual([]);
  });

  it("returns null for nonexistent dock", () => {
    expect(store.getDock(5)).toBeNull();
  });

  it("deletes a dock", () => {
    store.upsertDock(1, { label: "Temp" });
    expect(store.deleteDock(1)).toBe(true);
    expect(store.getDock(1)).toBeNull();
  });

  it("returns false when deleting nonexistent dock", () => {
    expect(store.deleteDock(1)).toBe(false);
  });
});

// ─── Dock Intents (N:M) ────────────────────────────────────────

describe("DockStore — Dock Intents", () => {
  let store: DockStore;

  beforeEach(() => {
    store = createDockStore(TEST_DB);
    store.upsertDock(1, { label: "Grinder" });
    store.upsertDock(3, { label: "Mining" });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("assigns intents to a dock", () => {
    store.setDockIntents(1, ["grinding"]);
    const intents = store.getDockIntents(1);
    expect(intents.length).toBe(1);
    expect(intents[0].key).toBe("grinding");
    expect(intents[0].label).toBe("Hostile Grinding");
  });

  it("assigns multiple intents to a dock", () => {
    store.setDockIntents(3, ["mining-gas", "mining-crystal", "mining-ore"]);
    const intents = store.getDockIntents(3);
    expect(intents.length).toBe(3);
    const keys = intents.map((i) => i.key);
    expect(keys).toContain("mining-gas");
    expect(keys).toContain("mining-crystal");
    expect(keys).toContain("mining-ore");
  });

  it("replaces intents on repeated set", () => {
    store.setDockIntents(1, ["grinding", "pvp"]);
    store.setDockIntents(1, ["armada"]);
    const intents = store.getDockIntents(1);
    expect(intents.length).toBe(1);
    expect(intents[0].key).toBe("armada");
  });

  it("clears all intents with empty array", () => {
    store.setDockIntents(1, ["grinding"]);
    store.setDockIntents(1, []);
    expect(store.getDockIntents(1)).toEqual([]);
  });

  it("rejects intent assignment to nonexistent dock", () => {
    expect(() => store.setDockIntents(7, ["grinding"])).toThrow("Dock 7 not found");
  });

  it("rejects unknown intent key", () => {
    expect(() => store.setDockIntents(1, ["warp-field-resonance"])).toThrow("Unknown intent key");
  });

  it("intents appear in dock context", () => {
    store.setDockIntents(3, ["mining-gas", "mining-crystal"]);
    const dock = store.getDock(3);
    expect(dock!.intents.length).toBe(2);
    expect(dock!.intents[0].isBuiltin).toBe(true);
  });

  it("deleting a dock cascades to its intents", () => {
    store.setDockIntents(1, ["grinding", "pvp"]);
    store.deleteDock(1);
    // Can't query intents for deleted dock, but recreating shows clean state
    store.upsertDock(1, { label: "New" });
    expect(store.getDockIntents(1)).toEqual([]);
  });
});

// ─── Dock Ships (Rotation) ─────────────────────────────────────

describe("DockStore — Dock Ships", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    // Fleet store creates ships table; dock store needs it for FK refs
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);

    // Create test ships
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createShip({
      id: "franklin", name: "U.S.S. Franklin", tier: 3, shipClass: "Explorer",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createShip({
      id: "botany-bay", name: "Botany Bay", tier: 2, shipClass: "Survey",
      status: "ready", role: "mining", roleDetail: null, notes: null, importedFrom: null,
    });

    // Create test docks
    dockStore.upsertDock(1, { label: "Main Grinder" });
    dockStore.upsertDock(2, { label: "Hostile Swapper" });
    dockStore.upsertDock(3, { label: "Raw Mining" });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("adds a ship to a dock rotation", () => {
    const dockShip = dockStore.addDockShip(1, "kumari");
    expect(dockShip.dockNumber).toBe(1);
    expect(dockShip.shipId).toBe("kumari");
    expect(dockShip.shipName).toBe("Kumari");
    expect(dockShip.isActive).toBe(false);
    expect(dockShip.sortOrder).toBe(0);
  });

  it("adds a ship with notes", () => {
    const dockShip = dockStore.addDockShip(1, "kumari", { notes: "Primary grinder" });
    expect(dockShip.notes).toBe("Primary grinder");
  });

  it("auto-increments sort order within a dock", () => {
    const s1 = dockStore.addDockShip(2, "kumari");
    const s2 = dockStore.addDockShip(2, "franklin");
    expect(s1.sortOrder).toBe(0);
    expect(s2.sortOrder).toBe(1);
  });

  it("rejects duplicate ship in same dock", () => {
    dockStore.addDockShip(1, "kumari");
    expect(() => dockStore.addDockShip(1, "kumari")).toThrow("already assigned to dock 1");
  });

  it("allows same ship in different docks", () => {
    const d1 = dockStore.addDockShip(1, "kumari");
    const d2 = dockStore.addDockShip(2, "kumari");
    expect(d1.dockNumber).toBe(1);
    expect(d2.dockNumber).toBe(2);
  });

  it("rejects ship not in fleet roster", () => {
    expect(() => dockStore.addDockShip(1, "nonexistent-ship")).toThrow("not found in fleet roster");
  });

  it("rejects ship assignment to nonexistent dock", () => {
    expect(() => dockStore.addDockShip(7, "kumari")).toThrow("Dock 7 not found");
  });

  it("removes a ship from a dock", () => {
    dockStore.addDockShip(1, "kumari");
    expect(dockStore.removeDockShip(1, "kumari")).toBe(true);
    expect(dockStore.getDockShips(1)).toEqual([]);
  });

  it("returns false when removing non-assigned ship", () => {
    expect(dockStore.removeDockShip(1, "kumari")).toBe(false);
  });

  it("lists ships in a dock ordered by sort_order", () => {
    dockStore.addDockShip(2, "kumari");
    dockStore.addDockShip(2, "franklin");
    const ships = dockStore.getDockShips(2);
    expect(ships.length).toBe(2);
    expect(ships[0].shipId).toBe("kumari");
    expect(ships[1].shipId).toBe("franklin");
  });

  it("sets a ship as active (clears others)", () => {
    dockStore.addDockShip(2, "kumari");
    dockStore.addDockShip(2, "franklin");

    const updated = dockStore.updateDockShip(2, "franklin", { isActive: true });
    expect(updated!.isActive).toBe(true);

    // kumari should now be inactive
    const ships = dockStore.getDockShips(2);
    const kumari = ships.find((s) => s.shipId === "kumari");
    const franklin = ships.find((s) => s.shipId === "franklin");
    expect(kumari!.isActive).toBe(false);
    expect(franklin!.isActive).toBe(true);
  });

  it("deactivates a ship", () => {
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });
    dockStore.updateDockShip(1, "kumari", { isActive: false });
    const ships = dockStore.getDockShips(1);
    expect(ships[0].isActive).toBe(false);
  });

  it("updates sort order", () => {
    dockStore.addDockShip(2, "kumari");
    dockStore.addDockShip(2, "franklin");
    dockStore.updateDockShip(2, "franklin", { sortOrder: -1 });
    const ships = dockStore.getDockShips(2);
    // franklin (-1) should sort before kumari (0)
    expect(ships[0].shipId).toBe("franklin");
    expect(ships[1].shipId).toBe("kumari");
  });

  it("updates notes", () => {
    dockStore.addDockShip(1, "kumari");
    const updated = dockStore.updateDockShip(1, "kumari", { notes: "Best grinder" });
    expect(updated!.notes).toBe("Best grinder");
  });

  it("returns null when updating non-assigned ship", () => {
    expect(dockStore.updateDockShip(1, "kumari", { isActive: true })).toBeNull();
  });

  it("ships appear in dock context", () => {
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });
    const dock = dockStore.getDock(1);
    expect(dock!.ships.length).toBe(1);
    expect(dock!.ships[0].shipName).toBe("Kumari");
    expect(dock!.ships[0].isActive).toBe(true);
  });

  it("deleting a dock cascades to its ships", () => {
    dockStore.addDockShip(1, "kumari");
    dockStore.deleteDock(1);
    dockStore.upsertDock(1, { label: "New" });
    expect(dockStore.getDockShips(1)).toEqual([]);
  });
});

// ─── Diagnostics ────────────────────────────────────────────────

describe("DockStore — Diagnostics", () => {
  let store: DockStore;

  beforeEach(() => {
    store = createDockStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("counts entities correctly", () => {
    const counts = store.counts();
    expect(counts.intents).toBeGreaterThanOrEqual(21); // seed data
    expect(counts.docks).toBe(0);
    expect(counts.dockShips).toBe(0);
  });

  it("reports database path", () => {
    expect(store.getDbPath()).toBe(TEST_DB);
  });
});

// ─── Crew Presets ───────────────────────────────────────────────

describe("DockStore — Crew Presets", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);
    // Create test ships and officers
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createShip({
      id: "botany-bay", name: "Botany Bay", tier: 2, shipClass: "Survey",
      status: "ready", role: "mining", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createOfficer({ id: "kirk", name: "Kirk", rarity: "Epic", level: 50, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "spock", name: "Spock", rarity: "Epic", level: 45, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "mccoy", name: "McCoy", rarity: "Rare", level: 40, rank: "Lt Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "stonn", name: "Stonn", rarity: "Common", level: 30, rank: "Lieutenant", groupName: "TOS" });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a crew preset", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Main Grind Crew" });
    expect(preset.id).toBeGreaterThan(0);
    expect(preset.shipId).toBe("kumari");
    expect(preset.intentKey).toBe("grinding");
    expect(preset.presetName).toBe("Main Grind Crew");
    expect(preset.isDefault).toBe(false);
    expect(preset.shipName).toBe("Kumari");
    expect(preset.intentLabel).toBe("Hostile Grinding");
    expect(preset.members).toEqual([]);
  });

  it("creates a default preset and clears others", () => {
    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew A", isDefault: true });
    const p2 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew B", isDefault: true });
    // p2 should be default, p1 should have been cleared
    expect(p2.isDefault).toBe(true);
    const p1Refreshed = dockStore.getPreset(p1.id);
    expect(p1Refreshed!.isDefault).toBe(false);
  });

  it("rejects preset for nonexistent ship", () => {
    expect(() => dockStore.createPreset({ shipId: "nope", intentKey: "grinding", presetName: "x" }))
      .toThrow(/not found in fleet roster/);
  });

  it("rejects preset for nonexistent intent", () => {
    expect(() => dockStore.createPreset({ shipId: "kumari", intentKey: "nope", presetName: "x" }))
      .toThrow(/not found in catalog/);
  });

  it("rejects duplicate preset name for same ship+intent", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Same" });
    expect(() => dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Same" }))
      .toThrow(/already exists/);
  });

  it("allows same preset name for different ship or intent", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Alpha" });
    dockStore.createPreset({ shipId: "botany-bay", intentKey: "grinding", presetName: "Alpha" });
    dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "Alpha" });
    expect(dockStore.listPresets().length).toBe(3);
  });

  it("gets a preset by ID", () => {
    const created = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Test" });
    const preset = dockStore.getPreset(created.id);
    expect(preset).not.toBeNull();
    expect(preset!.presetName).toBe("Test");
  });

  it("returns null for nonexistent preset", () => {
    expect(dockStore.getPreset(999)).toBeNull();
  });

  it("lists presets unfiltered", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = dockStore.listPresets();
    expect(presets.length).toBe(2);
  });

  it("filters presets by shipId", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = dockStore.listPresets({ shipId: "kumari" });
    expect(presets.length).toBe(1);
    expect(presets[0].shipId).toBe("kumari");
  });

  it("filters presets by intentKey", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    const presets = dockStore.listPresets({ intentKey: "grinding" });
    expect(presets.length).toBe(1);
    expect(presets[0].intentKey).toBe("grinding");
  });

  it("filters presets by both shipId and intentKey", () => {
    dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.createPreset({ shipId: "kumari", intentKey: "pvp", presetName: "B" });
    const presets = dockStore.listPresets({ shipId: "kumari", intentKey: "grinding" });
    expect(presets.length).toBe(1);
  });

  it("updates a preset name", () => {
    const created = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Old" });
    const updated = dockStore.updatePreset(created.id, { presetName: "New" });
    expect(updated!.presetName).toBe("New");
  });

  it("updates isDefault flag", () => {
    const created = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    expect(created.isDefault).toBe(false);
    const updated = dockStore.updatePreset(created.id, { isDefault: true });
    expect(updated!.isDefault).toBe(true);
  });

  it("returns null when updating nonexistent preset", () => {
    expect(dockStore.updatePreset(999, { presetName: "x" })).toBeNull();
  });

  it("deletes a preset", () => {
    const created = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Del" });
    expect(dockStore.deletePreset(created.id)).toBe(true);
    expect(dockStore.getPreset(created.id)).toBeNull();
  });

  it("returns false when deleting nonexistent preset", () => {
    expect(dockStore.deletePreset(999)).toBe(false);
  });

  it("requires missing fields", () => {
    expect(() => dockStore.createPreset({ shipId: "", intentKey: "grinding", presetName: "x" }))
      .toThrow(/requires/);
  });
});

// ─── Crew Preset Members ────────────────────────────────────────

describe("DockStore — Crew Preset Members", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createOfficer({ id: "kirk", name: "Kirk", rarity: "Epic", level: 50, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "spock", name: "Spock", rarity: "Epic", level: 45, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "mccoy", name: "McCoy", rarity: "Rare", level: 40, rank: "Lt Commander", groupName: "TOS" });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("sets preset members", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    const members = dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
      { officerId: "mccoy", roleType: "bridge", slot: "officer_2" },
    ]);
    expect(members.length).toBe(3);
    expect(members[0].officerName).toBe("Kirk");
    expect(members[0].roleType).toBe("bridge");
    expect(members[0].slot).toBe("captain");
  });

  it("replaces members on repeated set", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
    ]);
    const members = dockStore.setPresetMembers(preset.id, [
      { officerId: "spock", roleType: "bridge", slot: "captain" },
    ]);
    expect(members.length).toBe(1);
    expect(members[0].officerName).toBe("Spock");
  });

  it("members appear in preset via getPreset", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);
    const full = dockStore.getPreset(preset.id);
    expect(full!.members.length).toBe(2);
  });

  it("rejects nonexistent preset", () => {
    expect(() => dockStore.setPresetMembers(999, [{ officerId: "kirk", roleType: "bridge" }]))
      .toThrow(/not found/);
  });

  it("rejects nonexistent officer", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    expect(() => dockStore.setPresetMembers(preset.id, [{ officerId: "nope", roleType: "bridge" }]))
      .toThrow(/not found in roster/);
  });

  it("rejects invalid roleType", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    expect(() => dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "invalid" as "bridge" },
    ])).toThrow(/Invalid roleType/);
  });

  it("clears members with empty array", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    dockStore.setPresetMembers(preset.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const members = dockStore.setPresetMembers(preset.id, []);
    expect(members.length).toBe(0);
  });

  it("deleting a preset cascades to members", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
    dockStore.setPresetMembers(preset.id, [{ officerId: "kirk", roleType: "bridge" }]);
    dockStore.deletePreset(preset.id);
    // Verify via counts
    const counts = dockStore.counts();
    expect(counts.presets).toBe(0);
    expect(counts.presetMembers).toBe(0);
  });
});

// ─── Officer Conflicts ──────────────────────────────────────────

describe("DockStore — Officer Conflicts", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createShip({
      id: "botany-bay", name: "Botany Bay", tier: 2, shipClass: "Survey",
      status: "ready", role: "mining", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createOfficer({ id: "kirk", name: "Kirk", rarity: "Epic", level: 50, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "spock", name: "Spock", rarity: "Epic", level: 45, rank: "Commander", groupName: "TOS" });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("returns empty when no conflicts", () => {
    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const conflicts = dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("detects officer appearing in multiple presets", () => {
    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const conflicts = dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].officerId).toBe("kirk");
    expect(conflicts[0].officerName).toBe("Kirk");
    expect(conflicts[0].appearances.length).toBe(2);
  });

  it("does not flag officers in same preset as conflicts", () => {
    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    dockStore.setPresetMembers(p1.id, [
      { officerId: "kirk", roleType: "bridge" },
      { officerId: "spock", roleType: "bridge" },
    ]);
    const conflicts = dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("resolves dock numbers for conflicting ships", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.addDockShip(1, "kumari");
    dockStore.upsertDock(2, { label: "Mining" });
    dockStore.addDockShip(2, "botany-bay");

    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);

    const conflicts = dockStore.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    const kumariAppearance = conflicts[0].appearances.find((a) => a.shipId === "kumari");
    expect(kumariAppearance!.dockNumbers).toContain(1);
    const botanyAppearance = conflicts[0].appearances.find((a) => a.shipId === "botany-bay");
    expect(botanyAppearance!.dockNumbers).toContain(2);
  });
});

// ─── Dock Briefing Builder ──────────────────────────────────────

describe("DockStore — Dock Briefing", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createShip({
      id: "botany-bay", name: "Botany Bay", tier: 2, shipClass: "Survey",
      status: "ready", role: "mining", roleDetail: null, notes: null, importedFrom: null,
    });
    fleetStore.createOfficer({ id: "kirk", name: "Kirk", rarity: "Epic", level: 50, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "spock", name: "Spock", rarity: "Epic", level: 45, rank: "Commander", groupName: "TOS" });
    fleetStore.createOfficer({ id: "mccoy", name: "McCoy", rarity: "Rare", level: 40, rank: "Lt Commander", groupName: "TOS" });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("returns empty briefing when no docks exist", () => {
    const briefing = dockStore.buildBriefing();
    expect(briefing.statusLines.length).toBe(0);
    expect(briefing.text).toBe("");
    expect(briefing.totalChars).toBe(0);
  });

  it("generates Tier 1 status lines", () => {
    dockStore.upsertDock(1, { label: "Main Grinder" });
    dockStore.setDockIntents(1, ["grinding"]);
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = dockStore.buildBriefing();
    expect(briefing.statusLines.length).toBe(1);
    expect(briefing.statusLines[0]).toContain("D1");
    expect(briefing.statusLines[0]).toContain('"Main Grinder"');
    expect(briefing.statusLines[0]).toContain("grinding");
    expect(briefing.statusLines[0]).toContain("Kumari (active)");
  });

  it("shows (none active) when ships exist but none active", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.addDockShip(1, "kumari");

    const briefing = dockStore.buildBriefing();
    expect(briefing.statusLines[0]).toContain("none active");
  });

  it("generates Tier 2 crew lines from presets", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.setDockIntents(1, ["grinding"]);
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });

    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Main Crew" });
    dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);

    const briefing = dockStore.buildBriefing();
    expect(briefing.crewLines.length).toBe(1);
    expect(briefing.crewLines[0]).toContain("Kirk(cpt)");
    expect(briefing.crewLines[0]).toContain("Spock");
  });

  it("shows model-suggest fallback when no preset crew", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.setDockIntents(1, ["grinding"]);
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = dockStore.buildBriefing();
    expect(briefing.crewLines[0]).toContain("model will suggest");
  });

  it("generates conflict lines", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.upsertDock(2, { label: "Mining" });
    dockStore.addDockShip(1, "kumari");
    dockStore.addDockShip(2, "botany-bay");

    const p1 = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
    const p2 = dockStore.createPreset({ shipId: "botany-bay", intentKey: "mining-gas", presetName: "B" });
    dockStore.setPresetMembers(p1.id, [{ officerId: "kirk", roleType: "bridge" }]);
    dockStore.setPresetMembers(p2.id, [{ officerId: "kirk", roleType: "bridge" }]);

    const briefing = dockStore.buildBriefing();
    expect(briefing.conflictLines.length).toBe(1);
    expect(briefing.conflictLines[0]).toContain("Kirk");
  });

  it("generates insight for single-ship docks", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.addDockShip(1, "kumari");

    const briefing = dockStore.buildBriefing();
    expect(briefing.insights.some((i) => i.includes("single point of failure"))).toBe(true);
  });

  it("generates insight for no-active-ship docks", () => {
    dockStore.upsertDock(1, { label: "Grinder" });
    dockStore.addDockShip(1, "kumari");
    dockStore.addDockShip(1, "botany-bay");

    const briefing = dockStore.buildBriefing();
    expect(briefing.insights.some((i) => i.includes("none marked active"))).toBe(true);
  });

  it("assembles text with all tiers", () => {
    dockStore.upsertDock(1, { label: "Main Grinder" });
    dockStore.setDockIntents(1, ["grinding"]);
    dockStore.addDockShip(1, "kumari");
    dockStore.updateDockShip(1, "kumari", { isActive: true });

    const briefing = dockStore.buildBriefing();
    expect(briefing.text).toContain("DRYDOCK STATUS");
    expect(briefing.text).toContain("ACTIVE CREW");
    expect(briefing.totalChars).toBeGreaterThan(0);
  });

  it("counts include presets and presetMembers", () => {
    const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Test" });
    dockStore.setPresetMembers(preset.id, [
      { officerId: "kirk", roleType: "bridge" },
    ]);
    const counts = dockStore.counts();
    expect(counts.presets).toBe(1);
    expect(counts.presetMembers).toBe(1);
  });
});

// ─── API Routes ─────────────────────────────────────────────────

import request from "supertest";
import { createApp, type AppState } from "../src/server/index.js";

// Mock hasCredentials since it checks the filesystem
import { vi } from "vitest";
vi.mock("../src/server/sheets.js", () => ({
  hasCredentials: vi.fn(() => false),
  fetchRoster: vi.fn(),
  fetchFleetData: vi.fn(),
  parseTabMapping: vi.fn(() => ({ Officers: "officers", Ships: "ships" })),
}));

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    geminiEngine: null,
    memoryService: null,
    settingsStore: null,
    sessionStore: null,
    fleetStore: null,
    dockStore: null,
    fleetData: null,
    rosterError: null,
    startupComplete: false,
    ...overrides,
  };
}

describe("Dock API Routes", () => {
  let dockStore: DockStore;
  let fleetStore: FleetStore;

  beforeEach(() => {
    fleetStore = createFleetStore(TEST_DB);
    dockStore = createDockStore(TEST_DB);
    // Create test ships for dock rotation tests
    fleetStore.createShip({
      id: "kumari", name: "Kumari", tier: 3, shipClass: "Interceptor",
      status: "ready", role: "combat", roleDetail: null, notes: null, importedFrom: null,
    });
  });

  afterEach(() => {
    dockStore.close();
    fleetStore.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  // ── Intents ─────────────────────────────────────────────

  describe("GET /api/fleet/intents", () => {
    it("returns all intents", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/intents");
      expect(res.status).toBe(200);
      expect(res.body.intents.length).toBeGreaterThanOrEqual(21);
      expect(res.body.count).toBeGreaterThanOrEqual(21);
    });

    it("filters by category", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/intents?category=mining");
      expect(res.status).toBe(200);
      expect(res.body.intents.every((i: { category: string }) => i.category === "mining")).toBe(true);
    });

    it("rejects invalid category", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/intents?category=bogus");
      expect(res.status).toBe(400);
    });

    it("returns 503 when dock store unavailable", async () => {
      const app = createApp(makeState());
      const res = await request(app).get("/api/fleet/intents");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /api/fleet/intents", () => {
    it("creates a custom intent", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/fleet/intents")
        .send({ key: "custom-scout", label: "Scouting", category: "custom" });
      expect(res.status).toBe(201);
      expect(res.body.key).toBe("custom-scout");
      expect(res.body.isBuiltin).toBe(false);
    });

    it("rejects missing fields", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/fleet/intents")
        .send({ key: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/fleet/intents/:key", () => {
    it("deletes a custom intent", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.createIntent({ key: "custom-del", label: "Del", category: "custom", description: null, icon: null });
      const res = await request(app).delete("/api/fleet/intents/custom-del");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("deleted");
    });

    it("rejects deleting builtin intent", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/fleet/intents/mining-gas");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/built-in/i);
    });
  });

  // ── Docks ───────────────────────────────────────────────

  describe("PUT /api/fleet/docks/:num", () => {
    it("creates a dock", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .put("/api/fleet/docks/1")
        .send({ label: "Main Grinder", priority: 3 });
      expect(res.status).toBe(200);
      expect(res.body.dockNumber).toBe(1);
      expect(res.body.label).toBe("Main Grinder");
    });

    it("rejects invalid dock number", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).put("/api/fleet/docks/0").send({ label: "Bad" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/fleet/docks", () => {
    it("lists docks with context", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      dockStore.upsertDock(2, { label: "Mining" });
      const res = await request(app).get("/api/fleet/docks");
      expect(res.status).toBe(200);
      expect(res.body.docks.length).toBe(2);
      expect(res.body.docks[0]).toHaveProperty("intents");
      expect(res.body.docks[0]).toHaveProperty("ships");
    });
  });

  describe("GET /api/fleet/docks/:num", () => {
    it("returns a dock with context", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app).get("/api/fleet/docks/1");
      expect(res.status).toBe(200);
      expect(res.body.label).toBe("Grinder");
    });

    it("returns 404 for nonexistent dock", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/docks/5");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/fleet/docks/:num", () => {
    it("deletes a dock", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Temp" });
      const res = await request(app).delete("/api/fleet/docks/1");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("deleted");
    });
  });

  // ── Dock Intents ────────────────────────────────────────

  describe("PUT /api/fleet/docks/:num/intents", () => {
    it("sets dock intents", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .put("/api/fleet/docks/1/intents")
        .send({ intents: ["grinding", "pvp"] });
      expect(res.status).toBe(200);
      expect(res.body.intents.length).toBe(2);
      expect(res.body.count).toBe(2);
    });

    it("rejects non-array intents", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .put("/api/fleet/docks/1/intents")
        .send({ intents: "grinding" });
      expect(res.status).toBe(400);
    });
  });

  // ── Dock Ships ──────────────────────────────────────────

  describe("POST /api/fleet/docks/:num/ships", () => {
    it("adds a ship to dock rotation", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .post("/api/fleet/docks/1/ships")
        .send({ shipId: "kumari" });
      expect(res.status).toBe(201);
      expect(res.body.shipId).toBe("kumari");
      expect(res.body.shipName).toBe("Kumari");
    });

    it("rejects missing shipId", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .post("/api/fleet/docks/1/ships")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/fleet/docks/:num/ships/:shipId", () => {
    it("sets a ship as active", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      dockStore.addDockShip(1, "kumari");
      const res = await request(app)
        .patch("/api/fleet/docks/1/ships/kumari")
        .send({ isActive: true });
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(true);
    });

    it("returns 404 for non-assigned ship", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app)
        .patch("/api/fleet/docks/1/ships/kumari")
        .send({ isActive: true });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/fleet/docks/:num/ships/:shipId", () => {
    it("removes a ship from dock", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      dockStore.addDockShip(1, "kumari");
      const res = await request(app).delete("/api/fleet/docks/1/ships/kumari");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("removed");
    });

    it("returns 404 for non-assigned ship", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/fleet/docks/1/ships/kumari");
      expect(res.status).toBe(404);
    });
  });

  // ── Crew Presets ────────────────────────────────────────

  describe("POST /api/fleet/presets", () => {
    it("creates a crew preset", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      const res = await request(app)
        .post("/api/fleet/presets")
        .send({ shipId: "kumari", intentKey: "grinding", presetName: "Grind Crew" });
      expect(res.status).toBe(201);
      expect(res.body.shipId).toBe("kumari");
      expect(res.body.presetName).toBe("Grind Crew");
      expect(res.body.members).toEqual([]);
    });

    it("rejects missing fields", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .post("/api/fleet/presets")
        .send({ shipId: "kumari" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/fleet/presets", () => {
    it("lists presets", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get("/api/fleet/presets");
      expect(res.status).toBe(200);
      expect(res.body.presets.length).toBe(1);
      expect(res.body.count).toBe(1);
    });

    it("filters by shipId", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get("/api/fleet/presets?shipId=kumari");
      expect(res.status).toBe(200);
      expect(res.body.presets.length).toBe(1);
    });
  });

  describe("GET /api/fleet/presets/:id", () => {
    it("returns a preset with members", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "A" });
      const res = await request(app).get(`/api/fleet/presets/${preset.id}`);
      expect(res.status).toBe(200);
      expect(res.body.presetName).toBe("A");
      expect(res.body.members).toEqual([]);
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/presets/999");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/fleet/presets/:id", () => {
    it("updates a preset", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Old" });
      const res = await request(app)
        .patch(`/api/fleet/presets/${preset.id}`)
        .send({ presetName: "New" });
      expect(res.status).toBe(200);
      expect(res.body.presetName).toBe("New");
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app)
        .patch("/api/fleet/presets/999")
        .send({ presetName: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/fleet/presets/:id", () => {
    it("deletes a preset", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Del" });
      const res = await request(app).delete(`/api/fleet/presets/${preset.id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("deleted");
    });

    it("returns 404 for nonexistent preset", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).delete("/api/fleet/presets/999");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/fleet/presets/:id/members", () => {
    it("sets preset members", async () => {
      fleetStore.createOfficer({ id: "kirk", name: "Kirk", rarity: "Epic", level: 50, rank: "Commander", groupName: "TOS" });
      const app = createApp(makeState({ dockStore, fleetStore }));
      const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/fleet/presets/${preset.id}/members`)
        .send({ members: [{ officerId: "kirk", roleType: "bridge", slot: "captain" }] });
      expect(res.status).toBe(200);
      expect(res.body.members.length).toBe(1);
      expect(res.body.members[0].officerName).toBe("Kirk");
    });

    it("rejects non-array members", async () => {
      const app = createApp(makeState({ dockStore, fleetStore }));
      const preset = dockStore.createPreset({ shipId: "kumari", intentKey: "grinding", presetName: "Crew" });
      const res = await request(app)
        .put(`/api/fleet/presets/${preset.id}/members`)
        .send({ members: "kirk" });
      expect(res.status).toBe(400);
    });
  });

  // ── Computed Endpoints ──────────────────────────────────

  describe("GET /api/fleet/docks/summary", () => {
    it("returns a dock briefing", async () => {
      const app = createApp(makeState({ dockStore }));
      dockStore.upsertDock(1, { label: "Grinder" });
      const res = await request(app).get("/api/fleet/docks/summary");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("statusLines");
      expect(res.body).toHaveProperty("text");
      expect(res.body).toHaveProperty("totalChars");
    });
  });

  describe("GET /api/fleet/docks/conflicts", () => {
    it("returns officer conflicts", async () => {
      const app = createApp(makeState({ dockStore }));
      const res = await request(app).get("/api/fleet/docks/conflicts");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("conflicts");
      expect(res.body).toHaveProperty("count");
    });
  });
});
