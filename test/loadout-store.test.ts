/**
 * loadout-store.test.ts — Loadout Architecture Data Layer Tests (ADR-022 Phase 1)
 *
 * Integration tests against live PostgreSQL (docker-compose).
 * Replaces dock-store.test.ts.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  createLoadoutStore,
  VALID_INTENT_CATEGORIES,
  type LoadoutStore,
} from "../src/server/loadout-store.js";
import { createReferenceStore, type ReferenceStore } from "../src/server/reference-store.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

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

// ═══════════════════════════════════════════════════════════════
// Intent Catalog
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Intent Catalog", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
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
  });

  it("rejects custom intent with invalid category", async () => {
    await expect(
      store.createIntent({ key: "bad-cat", label: "Bad", category: "nonexistent" as never, description: null, icon: null }),
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
    ).rejects.toThrow();
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

// ═══════════════════════════════════════════════════════════════
// Loadout CRUD
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Loadout CRUD", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedShip(refStore, "bb", "Botany Bay", "Survey", 4);
  });

  it("creates a basic loadout", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    expect(loadout.id).toBeGreaterThan(0);
    expect(loadout.shipId).toBe("vidar");
    expect(loadout.name).toBe("Borg Loop");
    expect(loadout.priority).toBe(0);
    expect(loadout.isActive).toBe(true);
    expect(loadout.intentKeys).toEqual([]);
    expect(loadout.tags).toEqual([]);
    expect(loadout.members).toEqual([]);
    expect(loadout.shipName).toBe("Vi'Dar");
  });

  it("creates a loadout with all optional fields", async () => {
    const loadout = await store.createLoadout({
      shipId: "kumari",
      name: "Punch Up",
      priority: 5,
      isActive: false,
      intentKeys: ["grinding", "pvp"],
      tags: ["daily", "combat"],
      notes: "Kirk/Spock/McCoy combo",
    });
    expect(loadout.priority).toBe(5);
    expect(loadout.isActive).toBe(false);
    expect(loadout.intentKeys).toEqual(["grinding", "pvp"]);
    expect(loadout.tags).toEqual(["daily", "combat"]);
    expect(loadout.notes).toBe("Kirk/Spock/McCoy combo");
  });

  it("rejects loadout with missing ship", async () => {
    await expect(store.createLoadout({ shipId: "nonexistent", name: "Bad" }))
      .rejects.toThrow("Ship not found");
  });

  it("rejects loadout with missing name", async () => {
    await expect(store.createLoadout({ shipId: "vidar", name: "" }))
      .rejects.toThrow("requires shipId and name");
  });

  it("enforces UNIQUE(ship_id, name)", async () => {
    await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await expect(store.createLoadout({ shipId: "vidar", name: "Borg Loop" }))
      .rejects.toThrow("already exists");
  });

  it("allows same name on different ships", async () => {
    const a = await store.createLoadout({ shipId: "vidar", name: "Daily Grind" });
    const b = await store.createLoadout({ shipId: "kumari", name: "Daily Grind" });
    expect(a.id).not.toBe(b.id);
  });

  it("gets a loadout by id", async () => {
    const created = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    const fetched = await store.getLoadout(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Borg Loop");
    expect(fetched!.shipName).toBe("Vi'Dar");
  });

  it("returns null for nonexistent loadout", async () => {
    expect(await store.getLoadout(9999)).toBeNull();
  });

  it("lists all loadouts", async () => {
    await store.createLoadout({ shipId: "vidar", name: "Borg Loop", priority: 3 });
    await store.createLoadout({ shipId: "kumari", name: "Punch", priority: 5 });
    await store.createLoadout({ shipId: "bb", name: "Gas Mining" });
    const all = await store.listLoadouts();
    expect(all.length).toBe(3);
    // Ordered by priority DESC
    expect(all[0].name).toBe("Punch");
    expect(all[1].name).toBe("Borg Loop");
  });

  it("filters loadouts by shipId", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.createLoadout({ shipId: "kumari", name: "B" });
    const filtered = await store.listLoadouts({ shipId: "vidar" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].shipId).toBe("vidar");
  });

  it("filters loadouts by intentKey", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A", intentKeys: ["grinding"] });
    await store.createLoadout({ shipId: "kumari", name: "B", intentKeys: ["mining-gas"] });
    await store.createLoadout({ shipId: "bb", name: "C", intentKeys: ["grinding", "pvp"] });
    const filtered = await store.listLoadouts({ intentKey: "grinding" });
    expect(filtered.length).toBe(2);
    expect(filtered.every((l) => l.intentKeys.includes("grinding"))).toBe(true);
  });

  it("filters loadouts by tag", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A", tags: ["daily"] });
    await store.createLoadout({ shipId: "kumari", name: "B", tags: ["weekly"] });
    const filtered = await store.listLoadouts({ tag: "daily" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].tags).toContain("daily");
  });

  it("filters loadouts by active status", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A", isActive: true });
    await store.createLoadout({ shipId: "kumari", name: "B", isActive: false });
    const active = await store.listLoadouts({ active: true });
    expect(active.length).toBe(1);
    expect(active[0].isActive).toBe(true);
  });

  it("updates loadout metadata", async () => {
    const created = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    const updated = await store.updateLoadout(created.id, {
      name: "Borg Daily",
      priority: 10,
      isActive: false,
      intentKeys: ["grinding-eclipse"],
      tags: ["borg", "daily"],
      notes: "Updated notes",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Borg Daily");
    expect(updated!.priority).toBe(10);
    expect(updated!.isActive).toBe(false);
    expect(updated!.intentKeys).toEqual(["grinding-eclipse"]);
    expect(updated!.tags).toEqual(["borg", "daily"]);
    expect(updated!.notes).toBe("Updated notes");
  });

  it("returns null when updating nonexistent loadout", async () => {
    expect(await store.updateLoadout(9999, { name: "Nope" })).toBeNull();
  });

  it("rejects update that violates UNIQUE constraint", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A" });
    const b = await store.createLoadout({ shipId: "vidar", name: "B" });
    await expect(store.updateLoadout(b.id, { name: "A" })).rejects.toThrow("already exists");
  });

  it("deletes a loadout", async () => {
    const created = await store.createLoadout({ shipId: "vidar", name: "Temp" });
    expect(await store.deleteLoadout(created.id)).toBe(true);
    expect(await store.getLoadout(created.id)).toBeNull();
  });

  it("returns false when deleting nonexistent loadout", async () => {
    expect(await store.deleteLoadout(9999)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Loadout Members
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Loadout Members", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedOfficer(refStore, "5of11", "5 of 11", "Epic", "Borg");
    await seedOfficer(refStore, "7of11", "7 of 11", "Rare", "Borg");
    await seedOfficer(refStore, "8of11", "8 of 11", "Rare", "Borg");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  });

  it("sets crew members on a loadout", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    const members = await store.setLoadoutMembers(loadout.id, [
      { officerId: "5of11", roleType: "bridge", slot: "captain" },
      { officerId: "7of11", roleType: "bridge", slot: "officer_1" },
      { officerId: "8of11", roleType: "below_deck" },
    ]);
    expect(members.length).toBe(3);
    expect(members[0].officerId).toBe("5of11");
    expect(members[0].roleType).toBe("bridge");
    expect(members[0].slot).toBe("captain");
  });

  it("replaces members on subsequent set call", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "5of11", roleType: "bridge", slot: "captain" },
    ]);
    const newMembers = await store.setLoadoutMembers(loadout.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);
    expect(newMembers.length).toBe(2);
    expect(newMembers[0].officerId).toBe("kirk");

    // Verify old members are gone
    const fetched = await store.getLoadout(loadout.id);
    expect(fetched!.members.length).toBe(2);
    expect(fetched!.members.map((m) => m.officerId)).not.toContain("5of11");
  });

  it("members appear on getLoadout", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "5of11", roleType: "bridge", slot: "captain" },
      { officerId: "7of11", roleType: "bridge" },
    ]);
    const fetched = await store.getLoadout(loadout.id);
    expect(fetched!.members.length).toBe(2);
    expect(fetched!.members[0].officerName).toBe("5 of 11");
  });

  it("rejects member with nonexistent officer", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await expect(
      store.setLoadoutMembers(loadout.id, [{ officerId: "nonexistent", roleType: "bridge" }]),
    ).rejects.toThrow("Officer not found");
  });

  it("rejects member on nonexistent loadout", async () => {
    await expect(
      store.setLoadoutMembers(9999, [{ officerId: "kirk", roleType: "bridge" }]),
    ).rejects.toThrow("Loadout not found");
  });

  it("allows empty members (clear crew)", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "5of11", roleType: "bridge" },
    ]);
    const cleared = await store.setLoadoutMembers(loadout.id, []);
    expect(cleared.length).toBe(0);
    const fetched = await store.getLoadout(loadout.id);
    expect(fetched!.members.length).toBe(0);
  });

  it("cascades members on loadout delete", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "5of11", roleType: "bridge" },
    ]);
    await store.deleteLoadout(loadout.id);
    // Members should be gone (can't query directly, but counts should reflect)
    const c = await store.counts();
    expect(c.loadoutMembers).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Dock CRUD (simplified metadata slots)
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Docks", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
  });

  it("creates a dock via upsert", async () => {
    const dock = await store.upsertDock(1, { label: "Main Grinder" });
    expect(dock.dockNumber).toBe(1);
    expect(dock.label).toBe("Main Grinder");
    expect(dock.createdAt).toBeTruthy();
  });

  it("updates an existing dock via upsert", async () => {
    await store.upsertDock(1, { label: "Grinder" });
    const updated = await store.upsertDock(1, { label: "Main Grinder" });
    expect(updated.label).toBe("Main Grinder");
  });

  it("rejects non-positive dock number", async () => {
    await expect(store.upsertDock(0, { label: "Bad" })).rejects.toThrow("positive integer");
    await expect(store.upsertDock(-1, { label: "Bad" })).rejects.toThrow("positive integer");
  });

  it("lists all docks", async () => {
    await store.upsertDock(1, { label: "Grinder" });
    await store.upsertDock(3, { label: "Mining" });
    const docks = await store.listDocks();
    expect(docks.length).toBe(2);
    expect(docks[0].dockNumber).toBe(1);
    expect(docks[1].dockNumber).toBe(3);
    // Assignment is null when no plan items
    expect(docks[0].assignment).toBeNull();
  });

  it("gets a single dock", async () => {
    await store.upsertDock(2, { label: "Hostile Swapper", notes: "PvE grind" });
    const dock = await store.getDock(2);
    expect(dock).not.toBeNull();
    expect(dock!.label).toBe("Hostile Swapper");
    expect(dock!.notes).toBe("PvE grind");
    expect(dock!.assignment).toBeNull();
  });

  it("returns null for nonexistent dock", async () => {
    expect(await store.getDock(99)).toBeNull();
  });

  it("deletes a dock", async () => {
    await store.upsertDock(1, { label: "Temp" });
    expect(await store.deleteDock(1)).toBe(true);
    expect(await store.getDock(1)).toBeNull();
  });

  it("returns false when deleting nonexistent dock", async () => {
    expect(await store.deleteDock(99)).toBe(false);
  });

  it("dock shows assignment when plan item is assigned", async () => {
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.upsertDock(1, { label: "Grinder" });
    await store.createPlanItem({
      intentKey: "grinding",
      label: "Daily Grind",
      loadoutId: loadout.id,
      dockNumber: 1,
    });
    const dock = await store.getDock(1);
    expect(dock!.assignment).not.toBeNull();
    expect(dock!.assignment!.label).toBe("Daily Grind");
    expect(dock!.assignment!.loadoutName).toBe("Borg Loop");
    expect(dock!.assignment!.shipName).toBe("Vi'Dar");
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Items
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Plan Items", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "mccoy", "McCoy", "Epic", "TOS");
  });

  it("creates a plan item with loadout + dock", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.upsertDock(1, { label: "Grinder" });
    const item = await store.createPlanItem({
      intentKey: "grinding",
      label: "Daily Grind",
      loadoutId: loadout.id,
      dockNumber: 1,
      priority: 5,
    });
    expect(item.id).toBeGreaterThan(0);
    expect(item.intentKey).toBe("grinding");
    expect(item.label).toBe("Daily Grind");
    expect(item.loadoutId).toBe(loadout.id);
    expect(item.dockNumber).toBe(1);
    expect(item.priority).toBe(5);
    expect(item.isActive).toBe(true);
    expect(item.intentLabel).toBe("Hostile Grinding");
    expect(item.loadoutName).toBe("Borg Loop");
    expect(item.shipName).toBe("Vi'Dar");
    expect(item.dockLabel).toBe("Grinder");
  });

  it("creates an away team plan item (no loadout, no dock)", async () => {
    const item = await store.createPlanItem({
      intentKey: "away-team",
      label: "Crit Mining Away",
    });
    expect(item.loadoutId).toBeNull();
    expect(item.dockNumber).toBeNull();
    expect(item.awayMembers).toEqual([]);
  });

  it("rejects plan item with nonexistent loadout", async () => {
    await expect(store.createPlanItem({ loadoutId: 9999 }))
      .rejects.toThrow("Loadout not found");
  });

  it("rejects plan item with nonexistent dock", async () => {
    await expect(store.createPlanItem({ dockNumber: 99 }))
      .rejects.toThrow("Dock not found");
  });

  it("rejects plan item with nonexistent intent", async () => {
    await expect(store.createPlanItem({ intentKey: "nonexistent" }))
      .rejects.toThrow("Intent not found");
  });

  it("gets a plan item by id", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },
    ]);
    await store.upsertDock(1, { label: "Slot" });
    const created = await store.createPlanItem({
      intentKey: "grinding",
      loadoutId: loadout.id,
      dockNumber: 1,
      label: "Grind",
    });
    const fetched = await store.getPlanItem(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.label).toBe("Grind");
    expect(fetched!.members.length).toBe(1);
    expect(fetched!.members[0].officerName).toBe("Kirk");
  });

  it("returns null for nonexistent plan item", async () => {
    expect(await store.getPlanItem(9999)).toBeNull();
  });

  it("lists all plan items", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ label: "Item 1", loadoutId: loadout.id, dockNumber: 1, priority: 5 });
    await store.createPlanItem({ label: "Item 2", intentKey: "away-team" });
    const items = await store.listPlanItems();
    expect(items.length).toBe(2);
    // Ordered by priority DESC
    expect(items[0].label).toBe("Item 1");
  });

  it("filters plan items by active status", async () => {
    await store.createPlanItem({ label: "Active", isActive: true });
    await store.createPlanItem({ label: "Inactive", isActive: false });
    const active = await store.listPlanItems({ active: true });
    expect(active.length).toBe(1);
    expect(active[0].label).toBe("Active");
  });

  it("filters plan items by dock", async () => {
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ label: "On D1", dockNumber: 1 });
    await store.createPlanItem({ label: "On D2", dockNumber: 2 });
    const filtered = await store.listPlanItems({ dockNumber: 1 });
    expect(filtered.length).toBe(1);
    expect(filtered[0].label).toBe("On D1");
  });

  it("filters plan items by intent", async () => {
    await store.createPlanItem({ label: "Grind", intentKey: "grinding" });
    await store.createPlanItem({ label: "Mine", intentKey: "mining-gas" });
    const filtered = await store.listPlanItems({ intentKey: "grinding" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].label).toBe("Grind");
  });

  it("updates a plan item", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    const created = await store.createPlanItem({ label: "Test", dockNumber: 1, loadoutId: loadout.id });
    const updated = await store.updatePlanItem(created.id, {
      label: "Updated",
      dockNumber: 2,
      priority: 10,
      isActive: false,
      notes: "Reassigned",
    });
    expect(updated!.label).toBe("Updated");
    expect(updated!.dockNumber).toBe(2);
    expect(updated!.priority).toBe(10);
    expect(updated!.isActive).toBe(false);
    expect(updated!.notes).toBe("Reassigned");
  });

  it("can nullify dock and loadout on plan item", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    const created = await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Full" });
    const updated = await store.updatePlanItem(created.id, {
      loadoutId: null,
      dockNumber: null,
    });
    expect(updated!.loadoutId).toBeNull();
    expect(updated!.dockNumber).toBeNull();
  });

  it("returns null when updating nonexistent plan item", async () => {
    expect(await store.updatePlanItem(9999, { label: "Nope" })).toBeNull();
  });

  it("rejects update with nonexistent references", async () => {
    const item = await store.createPlanItem({ label: "Test" });
    await expect(store.updatePlanItem(item.id, { loadoutId: 9999 }))
      .rejects.toThrow("Loadout not found");
    await expect(store.updatePlanItem(item.id, { dockNumber: 99 }))
      .rejects.toThrow("Dock not found");
    await expect(store.updatePlanItem(item.id, { intentKey: "nonexistent" }))
      .rejects.toThrow("Intent not found");
  });

  it("deletes a plan item", async () => {
    const item = await store.createPlanItem({ label: "Temp" });
    expect(await store.deletePlanItem(item.id)).toBe(true);
    expect(await store.getPlanItem(item.id)).toBeNull();
  });

  it("returns false when deleting nonexistent plan item", async () => {
    expect(await store.deletePlanItem(9999)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Away Members
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Plan Away Members", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedOfficer(refStore, "tpring", "T'Pring", "Epic", "SNW");
    await seedOfficer(refStore, "helvia", "Helvia", "Rare", "Rom");
    await seedOfficer(refStore, "joaquin", "Joaquin", "Epic", "Aug");
  });

  it("sets away team officers on a plan item", async () => {
    const item = await store.createPlanItem({ label: "Crit Mining Away", intentKey: "away-team" });
    const members = await store.setPlanAwayMembers(item.id, ["tpring", "helvia", "joaquin"]);
    expect(members.length).toBe(3);
    expect(members[0].officerId).toBe("tpring");
    expect(members[0].planItemId).toBe(item.id);
  });

  it("replaces away members on subsequent set", async () => {
    const item = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(item.id, ["tpring", "helvia"]);
    const newMembers = await store.setPlanAwayMembers(item.id, ["joaquin"]);
    expect(newMembers.length).toBe(1);
    expect(newMembers[0].officerId).toBe("joaquin");

    // Verify via getPlanItem
    const fetched = await store.getPlanItem(item.id);
    expect(fetched!.awayMembers.length).toBe(1);
  });

  it("away members appear on getPlanItem", async () => {
    const item = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(item.id, ["tpring", "helvia"]);
    const fetched = await store.getPlanItem(item.id);
    expect(fetched!.awayMembers.length).toBe(2);
    expect(fetched!.awayMembers[0].officerName).toBe("T'Pring");
  });

  it("rejects away member with nonexistent officer", async () => {
    const item = await store.createPlanItem({ label: "Away" });
    await expect(store.setPlanAwayMembers(item.id, ["nonexistent"]))
      .rejects.toThrow("Officer not found");
  });

  it("rejects away members on nonexistent plan item", async () => {
    await expect(store.setPlanAwayMembers(9999, ["tpring"]))
      .rejects.toThrow("Plan item not found");
  });

  it("allows empty away members (clear team)", async () => {
    const item = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(item.id, ["tpring"]);
    const cleared = await store.setPlanAwayMembers(item.id, []);
    expect(cleared.length).toBe(0);
  });

  it("cascades away members on plan item delete", async () => {
    const item = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(item.id, ["tpring", "helvia"]);
    await store.deletePlanItem(item.id);
    const c = await store.counts();
    expect(c.awayMembers).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Officer Conflicts
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Officer Conflicts", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "tpring", "T'Pring", "Epic", "SNW");
  });

  it("returns empty when no conflicts", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.setLoadoutMembers(loadoutB.id, [{ officerId: "spock", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "B" });
    const conflicts = await store.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("detects officer conflict across loadouts in plan", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.setLoadoutMembers(loadoutB.id, [{ officerId: "kirk", roleType: "bridge" }]); // same officer!
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "Plan A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "Plan B" });
    const conflicts = await store.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].officerId).toBe("kirk");
    expect(conflicts[0].officerName).toBe("Kirk");
    expect(conflicts[0].appearances.length).toBe(2);
  });

  it("detects officer conflict between loadout and away team", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.setLoadoutMembers(loadout.id, [{ officerId: "tpring", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Dock Plan" });
    const awayItem = await store.createPlanItem({ label: "Away Team", intentKey: "away-team" });
    await store.setPlanAwayMembers(awayItem.id, ["tpring"]);

    const conflicts = await store.getOfficerConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].officerId).toBe("tpring");
    expect(conflicts[0].appearances.some((a) => a.source === "loadout")).toBe(true);
    expect(conflicts[0].appearances.some((a) => a.source === "away_team")).toBe(true);
  });

  it("ignores inactive plan items in conflict detection", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.setLoadoutMembers(loadoutB.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "Active", isActive: true });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "Inactive", isActive: false });
    const conflicts = await store.getOfficerConflicts();
    expect(conflicts.length).toBe(0);
  });

  it("detects multiple conflicting officers", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [
      { officerId: "kirk", roleType: "bridge" },
      { officerId: "spock", roleType: "bridge" },
    ]);
    await store.setLoadoutMembers(loadoutB.id, [
      { officerId: "kirk", roleType: "bridge" },
      { officerId: "spock", roleType: "bridge" },
    ]);
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "B" });
    const conflicts = await store.getOfficerConflicts();
    expect(conflicts.length).toBe(2);
    const ids = conflicts.map((c) => c.officerId).sort();
    expect(ids).toEqual(["kirk", "spock"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Plan Validation
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Plan Validation", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  });

  it("valid plan returns valid=true", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.setLoadoutMembers(loadoutB.id, [{ officerId: "spock", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "B" });

    const validation = await store.validatePlan();
    expect(validation.valid).toBe(true);
    expect(validation.dockConflicts.length).toBe(0);
    expect(validation.officerConflicts.length).toBe(0);
    expect(validation.unassignedLoadouts.length).toBe(0);
  });

  it("detects dock over-assignment", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.upsertDock(1, { label: "D1" });
    // Both on dock 1!
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "Plan A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 1, label: "Plan B" });

    const validation = await store.validatePlan();
    expect(validation.valid).toBe(false);
    expect(validation.dockConflicts.length).toBe(1);
    expect(validation.dockConflicts[0].dockNumber).toBe(1);
    expect(validation.dockConflicts[0].planItemIds.length).toBe(2);
  });

  it("detects officer conflicts in validation", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.setLoadoutMembers(loadoutA.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.setLoadoutMembers(loadoutB.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.upsertDock(2, { label: "D2" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "A" });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 2, label: "B" });

    const validation = await store.validatePlan();
    expect(validation.valid).toBe(false);
    expect(validation.officerConflicts.length).toBe(1);
  });

  it("detects unassigned plan items (no loadout, no away team)", async () => {
    await store.createPlanItem({ label: "Empty Item" });
    const validation = await store.validatePlan();
    expect(validation.valid).toBe(false);
    expect(validation.unassignedLoadouts.length).toBe(1);
  });

  it("detects loadout without dock (warning)", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.createPlanItem({ loadoutId: loadout.id, label: "No Dock" });
    const validation = await store.validatePlan();
    expect(validation.unassignedDocks.length).toBe(1);
    expect(validation.warnings.some((w) => w.includes("no dock assigned"))).toBe(true);
  });

  it("empty plan is valid", async () => {
    const validation = await store.validatePlan();
    expect(validation.valid).toBe(true);
    expect(validation.warnings.length).toBe(0);
  });

  it("inactive plan items don't cause dock conflicts", async () => {
    const loadoutA = await store.createLoadout({ shipId: "vidar", name: "A" });
    const loadoutB = await store.createLoadout({ shipId: "kumari", name: "B" });
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loadoutA.id, dockNumber: 1, label: "Active", isActive: true });
    await store.createPlanItem({ loadoutId: loadoutB.id, dockNumber: 1, label: "Paused", isActive: false });
    const validation = await store.validatePlan();
    expect(validation.dockConflicts.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// findLoadoutsForIntent
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — findLoadoutsForIntent", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
  });

  it("finds loadouts tagged with an intent", async () => {
    await store.createLoadout({ shipId: "vidar", name: "Borg", intentKeys: ["grinding-eclipse"] });
    await store.createLoadout({ shipId: "kumari", name: "Punch", intentKeys: ["grinding", "pvp"] });
    const found = await store.findLoadoutsForIntent("grinding");
    expect(found.length).toBe(1);
    expect(found[0].name).toBe("Punch");
  });

  it("returns empty when no loadouts match", async () => {
    await store.createLoadout({ shipId: "vidar", name: "A", intentKeys: ["mining-gas"] });
    const found = await store.findLoadoutsForIntent("pvp");
    expect(found.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Cascade Previews
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Cascade Previews", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
  });

  it("previews loadout deletion impact", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "kirk", roleType: "bridge" },
      { officerId: "spock", roleType: "bridge" },
    ]);
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Daily Grind" });

    const preview = await store.previewDeleteLoadout(loadout.id);
    expect(preview.memberCount).toBe(2);
    expect(preview.planItems.length).toBe(1);
    expect(preview.planItems[0].label).toBe("Daily Grind");
    expect(preview.planItems[0].dockNumber).toBe(1);
  });

  it("previews dock deletion impact", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "A" });
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Item 1" });
    await store.createPlanItem({ dockNumber: 1, label: "Item 2" });

    const preview = await store.previewDeleteDock(1);
    expect(preview.planItems.length).toBe(2);
  });

  it("previews officer deletion impact", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Crew" });
    await store.setLoadoutMembers(loadout.id, [
      { officerId: "kirk", roleType: "bridge" },
    ]);
    const awayItem = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(awayItem.id, ["kirk"]);

    const preview = await store.previewDeleteOfficer("kirk");
    expect(preview.loadoutMemberships.length).toBe(1);
    expect(preview.loadoutMemberships[0].loadoutName).toBe("Crew");
    expect(preview.awayMemberships.length).toBe(1);
    expect(preview.awayMemberships[0].planItemId).toBe(awayItem.id);
  });

  it("empty preview for unused officer", async () => {
    const preview = await store.previewDeleteOfficer("spock");
    expect(preview.loadoutMemberships.length).toBe(0);
    expect(preview.awayMemberships.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Counts
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Counts", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
  });

  it("reports table counts", async () => {
    const c = await store.counts();
    expect(c.intents).toBeGreaterThanOrEqual(21); // seed intents
    expect(c.loadouts).toBe(0);
    expect(c.loadoutMembers).toBe(0);
    expect(c.docks).toBe(0);
    expect(c.planItems).toBe(0);
    expect(c.awayMembers).toBe(0);
  });

  it("counts increment correctly", async () => {
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Test" });
    await store.setLoadoutMembers(loadout.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    const item = await store.createPlanItem({ label: "Test", dockNumber: 1 });
    await store.setPlanAwayMembers(item.id, ["kirk"]);

    const c = await store.counts();
    expect(c.loadouts).toBe(1);
    expect(c.loadoutMembers).toBe(1);
    expect(c.docks).toBe(1);
    expect(c.planItems).toBe(1);
    expect(c.awayMembers).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases & Integration
// ═══════════════════════════════════════════════════════════════

describe("LoadoutStore — Edge Cases", () => {
  let store: LoadoutStore;
  let refStore: ReferenceStore;

  beforeEach(async () => {
    await cleanDatabase(pool);
    refStore = await createReferenceStore(pool);
    store = await createLoadoutStore(pool);
    await seedShip(refStore, "vidar", "Vi'Dar", "Explorer");
    await seedShip(refStore, "kumari", "Kumari", "Interceptor");
    await seedShip(refStore, "bb", "Botany Bay", "Survey", 4);
    await seedOfficer(refStore, "kirk", "Kirk", "Epic", "TOS");
    await seedOfficer(refStore, "spock", "Spock", "Epic", "TOS");
    await seedOfficer(refStore, "mccoy", "McCoy", "Epic", "TOS");
    await seedOfficer(refStore, "tpring", "T'Pring", "Epic", "SNW");
  });

  it("loadout delete nullifies plan_items.loadout_id (ON DELETE SET NULL)", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.upsertDock(1, { label: "D1" });
    const item = await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Grind" });
    await store.deleteLoadout(loadout.id);
    const fetched = await store.getPlanItem(item.id);
    expect(fetched!.loadoutId).toBeNull();
    expect(fetched!.loadoutName).toBeNull();
  });

  it("dock delete nullifies plan_items.dock_number (ON DELETE SET NULL)", async () => {
    await store.upsertDock(1, { label: "D1" });
    const item = await store.createPlanItem({ dockNumber: 1, label: "Item" });
    await store.deleteDock(1);
    const fetched = await store.getPlanItem(item.id);
    expect(fetched!.dockNumber).toBeNull();
    expect(fetched!.dockLabel).toBeNull();
  });

  it("ship delete cascades to loadouts and plan items", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Borg Loop" });
    await store.setLoadoutMembers(loadout.id, [{ officerId: "kirk", roleType: "bridge" }]);
    await store.upsertDock(1, { label: "D1" });
    await store.createPlanItem({ loadoutId: loadout.id, dockNumber: 1, label: "Grind" });
    // Delete the ship from reference store (CASCADE to loadouts → loadout_members)
    await refStore.deleteShip("vidar");
    const c = await store.counts();
    expect(c.loadouts).toBe(0);
    expect(c.loadoutMembers).toBe(0);
  });

  it("officer delete cascades to loadout_members and away_members", async () => {
    const loadout = await store.createLoadout({ shipId: "vidar", name: "Crew" });
    await store.setLoadoutMembers(loadout.id, [{ officerId: "kirk", roleType: "bridge" }]);
    const awayItem = await store.createPlanItem({ label: "Away" });
    await store.setPlanAwayMembers(awayItem.id, ["kirk"]);
    await refStore.deleteOfficer("kirk");
    const c = await store.counts();
    expect(c.loadoutMembers).toBe(0);
    expect(c.awayMembers).toBe(0);
  });

  it("full scenario: 4 docks, multiple loadouts, away team, conflicts", async () => {
    // Create loadouts
    const borgLoop = await store.createLoadout({ shipId: "vidar", name: "Borg Loop", priority: 3, intentKeys: ["grinding-eclipse"] });
    const kumariPunch = await store.createLoadout({ shipId: "kumari", name: "Kumari Punch", priority: 5, intentKeys: ["grinding", "pvp"] });
    const bbGas = await store.createLoadout({ shipId: "bb", name: "BB Gas", priority: 2, intentKeys: ["mining-gas"] });

    // Crew them up
    await store.setLoadoutMembers(borgLoop.id, [{ officerId: "kirk", roleType: "bridge", slot: "captain" }]);
    await store.setLoadoutMembers(kumariPunch.id, [
      { officerId: "kirk", roleType: "bridge", slot: "captain" },  // conflict with Borg Loop!
      { officerId: "spock", roleType: "bridge", slot: "officer_1" },
    ]);
    await store.setLoadoutMembers(bbGas.id, [
      { officerId: "tpring", roleType: "bridge", slot: "captain" },
      { officerId: "mccoy", roleType: "bridge", slot: "officer_1" },
    ]);

    // Create docks
    await store.upsertDock(1, { label: "Main Grinder" });
    await store.upsertDock(2, { label: "Borg Slot" });
    await store.upsertDock(3, { label: "Mining Slot" });
    await store.upsertDock(4, { label: "Spare" });

    // Create plan
    await store.createPlanItem({ loadoutId: kumariPunch.id, dockNumber: 1, intentKey: "grinding", label: "Daily Grind", priority: 10 });
    await store.createPlanItem({ loadoutId: borgLoop.id, dockNumber: 2, intentKey: "grinding-eclipse", label: "Borg Daily", priority: 8 });
    await store.createPlanItem({ loadoutId: bbGas.id, dockNumber: 3, intentKey: "mining-gas", label: "Gas Mining", priority: 5 });

    // Away team
    const awayItem = await store.createPlanItem({ intentKey: "away-team", label: "Crit Mining Away", priority: 3 });
    await store.setPlanAwayMembers(awayItem.id, ["tpring", "mccoy"]);

    // Validate
    const validation = await store.validatePlan();

    // Kirk is on both Kumari Punch and Borg Loop (dock 1 and dock 2)
    expect(validation.officerConflicts.length).toBeGreaterThanOrEqual(1);
    const kirkConflict = validation.officerConflicts.find((c) => c.officerId === "kirk");
    expect(kirkConflict).toBeDefined();
    expect(kirkConflict!.appearances.length).toBe(2);

    // T'Pring is on BB Gas (dock 3) AND crit mining away team
    const tpringConflict = validation.officerConflicts.find((c) => c.officerId === "tpring");
    expect(tpringConflict).toBeDefined();

    // McCoy too — on BB Gas and away team
    const mccoyConflict = validation.officerConflicts.find((c) => c.officerId === "mccoy");
    expect(mccoyConflict).toBeDefined();

    // No dock conflicts (each dock has one item)
    expect(validation.dockConflicts.length).toBe(0);

    // Check counts
    const c = await store.counts();
    expect(c.loadouts).toBe(3);
    expect(c.docks).toBe(4);
    expect(c.planItems).toBe(4);
    expect(c.awayMembers).toBe(2);

    // Dock 4 should be empty
    const dock4 = await store.getDock(4);
    expect(dock4!.assignment).toBeNull();

    // Dock 1 should show Kumari Punch
    const dock1 = await store.getDock(1);
    expect(dock1!.assignment).not.toBeNull();
    expect(dock1!.assignment!.loadoutName).toBe("Kumari Punch");
    expect(dock1!.assignment!.shipName).toBe("Kumari");
  });
});
