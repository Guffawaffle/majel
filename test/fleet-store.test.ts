/**
 * fleet-store.test.ts — Fleet Management Data Layer Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createFleetStore,
  slugify,
  VALID_SHIP_STATUSES,
  type FleetStore,
  type ShipStatus,
} from "../src/server/fleet-store.js";
import type { FleetData, FleetSection } from "../src/server/fleet-data.js";

const TEST_DB = path.resolve(".test-fleet.db");

describe("slugify", () => {
  it("converts name to lowercase slug", () => {
    expect(slugify("USS Saladin")).toBe("uss-saladin");
  });

  it("handles special characters", () => {
    expect(slugify("D'Kora (Ferengi)")).toBe("d-kora-ferengi");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugify(" --test-- ")).toBe("test");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("FleetStore — Ships", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a ship with defaults", () => {
    const ship = store.createShip({
      id: "uss-enterprise",
      name: "USS Enterprise",
      tier: 5,
      shipClass: "Explorer",
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(ship.id).toBe("uss-enterprise");
    expect(ship.name).toBe("USS Enterprise");
    expect(ship.tier).toBe(5);
    expect(ship.status).toBe("ready");
    expect(ship.createdAt).toBeTruthy();
    expect(ship.updatedAt).toBeTruthy();
    expect(ship.statusChangedAt).toBeTruthy();
  });

  it("rejects invalid status on create", () => {
    expect(() =>
      store.createShip({
        id: "bad-ship",
        name: "Bad Ship",
        tier: null,
        shipClass: null,
        status: "invalid" as ShipStatus,
        role: null,
        roleDetail: null,
        notes: null,
        importedFrom: null,
      }),
    ).toThrow("Invalid ship status");
  });

  it("gets a ship by id", () => {
    store.createShip({
      id: "uss-discovery",
      name: "USS Discovery",
      tier: 4,
      shipClass: "Battleship",
      status: "deployed",
      role: "armada",
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });

    const ship = store.getShip("uss-discovery");
    expect(ship).not.toBeNull();
    expect(ship!.name).toBe("USS Discovery");
    expect(ship!.status).toBe("deployed");
    expect(ship!.crew).toEqual([]);
  });

  it("returns null for nonexistent ship", () => {
    expect(store.getShip("nope")).toBeNull();
  });

  it("lists all ships", () => {
    store.createShip({ id: "a-ship", name: "Alpha", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "b-ship", name: "Beta", tier: null, shipClass: null, status: "deployed", role: null, roleDetail: null, notes: null, importedFrom: null });

    const ships = store.listShips();
    expect(ships).toHaveLength(2);
    expect(ships[0].name).toBe("Alpha");
    expect(ships[1].name).toBe("Beta");
  });

  it("filters ships by status", () => {
    store.createShip({ id: "a-ship", name: "Alpha", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "b-ship", name: "Beta", tier: null, shipClass: null, status: "deployed", role: null, roleDetail: null, notes: null, importedFrom: null });

    const deployed = store.listShips({ status: "deployed" });
    expect(deployed).toHaveLength(1);
    expect(deployed[0].name).toBe("Beta");
  });

  it("filters ships by role", () => {
    store.createShip({ id: "a-ship", name: "Alpha", tier: null, shipClass: null, status: "ready", role: "mining", roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "b-ship", name: "Beta", tier: null, shipClass: null, status: "ready", role: "armada", roleDetail: null, notes: null, importedFrom: null });

    const miners = store.listShips({ role: "mining" });
    expect(miners).toHaveLength(1);
    expect(miners[0].name).toBe("Alpha");
  });

  it("updates ship fields", () => {
    store.createShip({ id: "s1", name: "Ship One", tier: 1, shipClass: "Scout", status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });

    const updated = store.updateShip("s1", { name: "Ship Uno", notes: "Renamed" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Ship Uno");
    expect(updated!.notes).toBe("Renamed");
  });

  it("tracks status changes", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.updateShip("s1", { status: "deployed" });

    const ship = store.getShip("s1");
    expect(ship!.status).toBe("deployed");
    expect(ship!.statusChangedAt).toBeTruthy();

    // Check log has the status change
    const logEntries = store.getLog({ shipId: "s1", action: "status_change" });
    expect(logEntries.length).toBeGreaterThan(0);
  });

  it("rejects invalid status on update", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    expect(() => store.updateShip("s1", { status: "bogus" as ShipStatus })).toThrow("Invalid ship status");
  });

  it("returns null when updating nonexistent ship", () => {
    expect(store.updateShip("nope", { name: "x" })).toBeNull();
  });

  it("deletes a ship", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    expect(store.deleteShip("s1")).toBe(true);
    expect(store.getShip("s1")).toBeNull();
  });

  it("returns false when deleting nonexistent ship", () => {
    expect(store.deleteShip("nope")).toBe(false);
  });
});

describe("FleetStore — Officers", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates an officer", () => {
    const officer = store.createOfficer({
      id: "kirk",
      name: "James T. Kirk",
      rarity: "epic",
      level: 60,
      rank: "Captain",
      groupName: "Command",
      importedFrom: null,
    });
    expect(officer.id).toBe("kirk");
    expect(officer.name).toBe("James T. Kirk");
    expect(officer.createdAt).toBeTruthy();
  });

  it("gets an officer with assignments", () => {
    store.createOfficer({ id: "spock", name: "Spock", rarity: "epic", level: 50, rank: null, groupName: null, importedFrom: null });
    const officer = store.getOfficer("spock");
    expect(officer).not.toBeNull();
    expect(officer!.assignments).toEqual([]);
  });

  it("returns null for nonexistent officer", () => {
    expect(store.getOfficer("nope")).toBeNull();
  });

  it("lists all officers", () => {
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: null, level: null, rank: null, groupName: "Command", importedFrom: null });
    store.createOfficer({ id: "spock", name: "Spock", rarity: null, level: null, rank: null, groupName: "Science", importedFrom: null });

    const officers = store.listOfficers();
    expect(officers).toHaveLength(2);
  });

  it("filters officers by group", () => {
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: null, level: null, rank: null, groupName: "Command", importedFrom: null });
    store.createOfficer({ id: "spock", name: "Spock", rarity: null, level: null, rank: null, groupName: "Science", importedFrom: null });

    const command = store.listOfficers({ groupName: "Command" });
    expect(command).toHaveLength(1);
    expect(command[0].name).toBe("Kirk");
  });

  it("filters unassigned officers", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.createOfficer({ id: "spock", name: "Spock", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.assignCrew("s1", "kirk", "bridge");

    const unassigned = store.listOfficers({ unassigned: true });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].name).toBe("Spock");
  });

  it("updates officer fields", () => {
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: "rare", level: 30, rank: null, groupName: null, importedFrom: null });
    const updated = store.updateOfficer("kirk", { level: 60, rarity: "epic" });
    expect(updated).not.toBeNull();
    expect(updated!.level).toBe(60);
    expect(updated!.rarity).toBe("epic");
  });

  it("returns null when updating nonexistent officer", () => {
    expect(store.updateOfficer("nope", { name: "x" })).toBeNull();
  });

  it("deletes an officer", () => {
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    expect(store.deleteOfficer("kirk")).toBe(true);
    expect(store.getOfficer("kirk")).toBeNull();
  });

  it("returns false when deleting nonexistent officer", () => {
    expect(store.deleteOfficer("nope")).toBe(false);
  });
});

describe("FleetStore — Crew Assignments", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
    store.createShip({ id: "enterprise", name: "USS Enterprise", tier: 5, shipClass: "Explorer", status: "deployed", role: "armada", roleDetail: null, notes: null, importedFrom: null });
    store.createOfficer({ id: "kirk", name: "Kirk", rarity: "epic", level: 60, rank: "Captain", groupName: "Command", importedFrom: null });
    store.createOfficer({ id: "spock", name: "Spock", rarity: "epic", level: 55, rank: "Commander", groupName: "Science", importedFrom: null });
    store.createOfficer({ id: "uhura", name: "Uhura", rarity: "rare", level: 40, rank: "Lieutenant", groupName: "Command", importedFrom: null });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("assigns an officer to a ship", () => {
    const assignment = store.assignCrew("enterprise", "kirk", "bridge", "captain");
    expect(assignment.shipId).toBe("enterprise");
    expect(assignment.officerId).toBe("kirk");
    expect(assignment.roleType).toBe("bridge");
    expect(assignment.slot).toBe("captain");
  });

  it("lists crew for a ship", () => {
    store.assignCrew("enterprise", "kirk", "bridge", "captain");
    store.assignCrew("enterprise", "spock", "bridge", "science");
    store.assignCrew("enterprise", "uhura", "specialist");

    const crew = store.getShipCrew("enterprise");
    expect(crew).toHaveLength(3);
    // Bridge first by ordering
    const names = crew.map((c) => c.officerName);
    expect(names).toContain("Kirk");
    expect(names).toContain("Spock");
    expect(names).toContain("Uhura");
  });

  it("filters crew by active role", () => {
    store.assignCrew("enterprise", "kirk", "bridge", "captain", "armada");
    store.assignCrew("enterprise", "spock", "bridge", "science", "mining");

    const armadaCrew = store.getShipCrew("enterprise", "armada");
    expect(armadaCrew).toHaveLength(1);
    expect(armadaCrew[0].officerName).toBe("Kirk");
  });

  it("shows assignments on officer get", () => {
    store.assignCrew("enterprise", "kirk", "bridge", "captain");
    const officer = store.getOfficer("kirk");
    expect(officer!.assignments).toHaveLength(1);
    expect(officer!.assignments[0].shipName).toBe("USS Enterprise");
  });

  it("shows crew on ship get", () => {
    store.assignCrew("enterprise", "kirk", "bridge");
    const ship = store.getShip("enterprise");
    expect(ship!.crew).toHaveLength(1);
    expect(ship!.crew[0].officerName).toBe("Kirk");
  });

  it("unassigns an officer from a ship", () => {
    store.assignCrew("enterprise", "kirk", "bridge");
    expect(store.unassignCrew("enterprise", "kirk")).toBe(true);
    expect(store.getShipCrew("enterprise")).toHaveLength(0);
  });

  it("returns false when unassigning nonexistent assignment", () => {
    expect(store.unassignCrew("enterprise", "kirk")).toBe(false);
  });

  it("throws when assigning to nonexistent ship", () => {
    expect(() => store.assignCrew("nope", "kirk", "bridge")).toThrow("Ship not found");
  });

  it("throws when assigning nonexistent officer", () => {
    expect(() => store.assignCrew("enterprise", "nope", "bridge")).toThrow("Officer not found");
  });

  it("cascades delete to assignments when ship deleted", () => {
    store.assignCrew("enterprise", "kirk", "bridge");
    store.deleteShip("enterprise");
    const officer = store.getOfficer("kirk");
    expect(officer!.assignments).toHaveLength(0);
  });

  it("cascades delete to assignments when officer deleted", () => {
    store.assignCrew("enterprise", "kirk", "bridge");
    store.deleteOfficer("kirk");
    const ship = store.getShip("enterprise");
    expect(ship!.crew).toHaveLength(0);
  });

  it("throws error when assigning bridge crew to multiple ships", () => {
    // Create another ship
    store.createShip({ id: "defiant", name: "USS Defiant", tier: 4, shipClass: "Battleship", status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    
    // Assign Kirk as bridge crew on Enterprise
    store.assignCrew("enterprise", "kirk", "bridge", "captain");
    
    // Try to assign Kirk as bridge crew on Defiant - should fail
    expect(() => store.assignCrew("defiant", "kirk", "bridge", "captain"))
      .toThrow(/already assigned as bridge crew/);
  });

  it("allows specialist crew on multiple ships", () => {
    // Create another ship
    store.createShip({ id: "defiant", name: "USS Defiant", tier: 4, shipClass: "Battleship", status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    
    // Assign Kirk as specialist crew on both ships - should work
    store.assignCrew("enterprise", "kirk", "specialist");
    expect(() => store.assignCrew("defiant", "kirk", "specialist")).not.toThrow();
  });

  it("allows reassigning bridge crew after unassignment", () => {
    // Create another ship
    store.createShip({ id: "defiant", name: "USS Defiant", tier: 4, shipClass: "Battleship", status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    
    // Assign Kirk as bridge crew on Enterprise
    store.assignCrew("enterprise", "kirk", "bridge", "captain");
    
    // Unassign Kirk from Enterprise
    store.unassignCrew("enterprise", "kirk");
    
    // Now assign Kirk as bridge crew on Defiant - should work
    expect(() => store.assignCrew("defiant", "kirk", "bridge", "captain")).not.toThrow();
  });
});

describe("FleetStore — Fleet Overview", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("returns fleet overview with empty data", () => {
    const overview = store.getFleetOverview();
    expect(overview.totalShips).toBe(0);
    expect(overview.totalOfficers).toBe(0);
    expect(overview.unassignedOfficers).toBe(0);
    expect(overview.crewFillRates.bridgeCrew).toBe(0);
    expect(overview.crewFillRates.specialistCrew).toBe(0);
    expect(overview.crewFillRates.totalAssignments).toBe(0);
    expect(overview.shipsByStatus).toEqual({
      deployed: 0,
      ready: 0,
      maintenance: 0,
      training: 0,
      reserve: 0,
      "awaiting-crew": 0,
    });
  });

  it("counts ships by status", () => {
    store.createShip({ id: "s1", name: "Ship 1", tier: null, shipClass: null, status: "deployed", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "s2", name: "Ship 2", tier: null, shipClass: null, status: "deployed", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "s3", name: "Ship 3", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "s4", name: "Ship 4", tier: null, shipClass: null, status: "maintenance", role: null, roleDetail: null, notes: null, importedFrom: null });

    const overview = store.getFleetOverview();
    expect(overview.totalShips).toBe(4);
    expect(overview.shipsByStatus.deployed).toBe(2);
    expect(overview.shipsByStatus.ready).toBe(1);
    expect(overview.shipsByStatus.maintenance).toBe(1);
    expect(overview.shipsByStatus.training).toBe(0);
  });

  it("counts unassigned officers", () => {
    store.createOfficer({ id: "o1", name: "Officer 1", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.createOfficer({ id: "o2", name: "Officer 2", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.createOfficer({ id: "o3", name: "Officer 3", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });

    const overview1 = store.getFleetOverview();
    expect(overview1.totalOfficers).toBe(3);
    expect(overview1.unassignedOfficers).toBe(3);

    // Assign one officer
    store.createShip({ id: "s1", name: "Ship 1", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.assignCrew("s1", "o1", "bridge");

    const overview2 = store.getFleetOverview();
    expect(overview2.totalOfficers).toBe(3);
    expect(overview2.unassignedOfficers).toBe(2);
  });

  it("counts crew fill rates by type", () => {
    store.createShip({ id: "s1", name: "Ship 1", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createOfficer({ id: "o1", name: "Officer 1", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.createOfficer({ id: "o2", name: "Officer 2", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.createOfficer({ id: "o3", name: "Officer 3", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });

    store.assignCrew("s1", "o1", "bridge", "captain");
    store.assignCrew("s1", "o2", "bridge", "science");
    store.assignCrew("s1", "o3", "specialist");

    const overview = store.getFleetOverview();
    expect(overview.crewFillRates.bridgeCrew).toBe(2);
    expect(overview.crewFillRates.specialistCrew).toBe(1);
    expect(overview.crewFillRates.totalAssignments).toBe(3);
  });
});

describe("FleetStore — Assignment Log", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("logs ship creation", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    const entries = store.getLog({ shipId: "s1" });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.action === "created")).toBe(true);
  });

  it("logs officer creation", () => {
    store.createOfficer({ id: "o1", name: "Officer", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    const entries = store.getLog({ officerId: "o1" });
    expect(entries.some((e) => e.action === "created")).toBe(true);
  });

  it("logs crew assignment and unassignment", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createOfficer({ id: "o1", name: "Officer", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });
    store.assignCrew("s1", "o1", "bridge");
    store.unassignCrew("s1", "o1");

    const entries = store.getLog();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("assigned");
    expect(actions).toContain("unassigned");
  });

  it("respects limit", () => {
    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "s2", name: "Ship2", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createShip({ id: "s3", name: "Ship3", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });

    const entries = store.getLog({ limit: 2 });
    expect(entries).toHaveLength(2);
  });
});

describe("FleetStore — Import", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  function makeFleetData(sections: FleetSection[]): FleetData {
    return {
      sections,
      raw: {},
      summary: `${sections.length} sections`,
    };
  }

  function makeSection(type: "ships" | "officers", label: string, headers: string[], rows: string[][]): FleetSection {
    return {
      label,
      type,
      headers,
      rows: [headers, ...rows],
      csv: "",
    };
  }

  it("imports ships from fleet data", () => {
    const data = makeFleetData([
      makeSection("ships", "My Ships", ["Name", "Tier", "Class"], [
        ["USS Enterprise", "5", "Explorer"],
        ["USS Discovery", "4", "Battleship"],
      ]),
    ]);

    const result = store.importFromFleetData(data);
    expect(result.ships).toBe(2);
    expect(result.officers).toBe(0);
    expect(result.skipped).toBe(0);

    const ships = store.listShips();
    expect(ships).toHaveLength(2);
    expect(ships.find((s) => s.name === "USS Enterprise")!.tier).toBe(5);
    expect(ships.find((s) => s.name === "USS Enterprise")!.importedFrom).toBe("My Ships");
  });

  it("imports officers from fleet data", () => {
    const data = makeFleetData([
      makeSection("officers", "Officers", ["Name", "Rarity", "Level", "Group"], [
        ["Kirk", "epic", "60", "Command"],
        ["Spock", "epic", "55", "Science"],
      ]),
    ]);

    const result = store.importFromFleetData(data);
    expect(result.officers).toBe(2);

    const officers = store.listOfficers();
    expect(officers).toHaveLength(2);
    expect(officers.find((o) => o.name === "Kirk")!.rarity).toBe("epic");
    expect(officers.find((o) => o.name === "Kirk")!.groupName).toBe("Command");
  });

  it("updates existing records on re-import (merge)", () => {
    // First import
    const data = makeFleetData([
      makeSection("ships", "Sheet1", ["Name", "Tier"], [
        ["USS Enterprise", "4"],
      ]),
    ]);
    store.importFromFleetData(data);

    // Re-import with updated tier
    const data2 = makeFleetData([
      makeSection("ships", "Sheet1", ["Name", "Tier"], [
        ["USS Enterprise", "5"],
      ]),
    ]);
    const result = store.importFromFleetData(data2);
    expect(result.ships).toBe(0); // Not created (already exists)
    expect(result.skipped).toBe(1); // Updated

    const ship = store.getShip("uss-enterprise");
    expect(ship!.tier).toBe(5);
  });

  it("preserves operational state on re-import", () => {
    // Import ship
    const data = makeFleetData([
      makeSection("ships", "Sheet1", ["Name", "Tier"], [
        ["USS Enterprise", "4"],
      ]),
    ]);
    store.importFromFleetData(data);

    // Set operational state
    store.updateShip("uss-enterprise", { status: "deployed", role: "armada", notes: "Flag ship" });

    // Re-import
    const data2 = makeFleetData([
      makeSection("ships", "Sheet1", ["Name", "Tier"], [
        ["USS Enterprise", "5"],
      ]),
    ]);
    store.importFromFleetData(data2);

    // Operational state preserved
    const ship = store.getShip("uss-enterprise");
    expect(ship!.status).toBe("deployed");
    expect(ship!.role).toBe("armada");
    expect(ship!.notes).toBe("Flag ship");
    expect(ship!.tier).toBe(5); // Updated from import
  });

  it("skips rows without a name", () => {
    const data = makeFleetData([
      makeSection("ships", "Sheet1", ["Name", "Tier"], [
        ["USS Enterprise", "4"],
        ["", "3"],
        ["USS Defiant", "2"],
      ]),
    ]);

    const result = store.importFromFleetData(data);
    expect(result.ships).toBe(2);
  });

  it("skips sections without a name column", () => {
    const data = makeFleetData([
      makeSection("ships", "Sheet1", ["Tier", "Class"], [
        ["4", "Explorer"],
      ]),
    ]);

    const result = store.importFromFleetData(data);
    expect(result.ships).toBe(0);
  });
});

describe("FleetStore — Diagnostics", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("reports db path", () => {
    expect(store.getDbPath()).toBe(TEST_DB);
  });

  it("reports counts", () => {
    expect(store.counts()).toEqual({
      ships: 0,
      officers: 0,
      assignments: 0,
      logEntries: 0,
    });

    store.createShip({ id: "s1", name: "Ship", tier: null, shipClass: null, status: "ready", role: null, roleDetail: null, notes: null, importedFrom: null });
    store.createOfficer({ id: "o1", name: "Officer", rarity: null, level: null, rank: null, groupName: null, importedFrom: null });

    const counts = store.counts();
    expect(counts.ships).toBe(1);
    expect(counts.officers).toBe(1);
    expect(counts.logEntries).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Data Segmentation Tests (Issue #15)
// ──────────────────────────────────────────────────────────────────

describe("FleetStore — Ship Segmentation", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates a ship with combat profile and grade", () => {
    const ship = store.createShip({
      id: "augur",
      name: "Augur",
      tier: 3,
      shipClass: "battleship",
      grade: 3,
      rarity: "epic",
      faction: "romulan",
      combatProfile: "triangle",
      specialtyLoop: null,
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(ship.grade).toBe(3);
    expect(ship.rarity).toBe("epic");
    expect(ship.faction).toBe("romulan");
    expect(ship.combatProfile).toBe("triangle");
    expect(ship.specialtyLoop).toBeNull();
  });

  it("creates a specialty ship with loop", () => {
    const ship = store.createShip({
      id: "vidar",
      name: "Vidar",
      tier: 4,
      shipClass: "explorer",
      grade: 3,
      rarity: "rare",
      faction: "neutral",
      combatProfile: "specialty",
      specialtyLoop: "borg",
      status: "deployed",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(ship.combatProfile).toBe("specialty");
    expect(ship.specialtyLoop).toBe("borg");
  });

  it("creates a non-combat ship", () => {
    const ship = store.createShip({
      id: "botany-bay",
      name: "Botany Bay",
      tier: 2,
      shipClass: "survey",
      grade: 2,
      rarity: "uncommon",
      faction: "neutral",
      combatProfile: "non_combat",
      specialtyLoop: null,
      status: "ready",
      role: "mining",
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(ship.combatProfile).toBe("non_combat");
    expect(ship.shipClass).toBe("survey");
  });

  it("defaults new fields to null when omitted", () => {
    const ship = store.createShip({
      id: "legacy-ship",
      name: "Legacy Ship",
      tier: null,
      shipClass: null,
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(ship.grade).toBeNull();
    expect(ship.rarity).toBeNull();
    expect(ship.faction).toBeNull();
    expect(ship.combatProfile).toBeNull();
    expect(ship.specialtyLoop).toBeNull();
  });

  it("persists and retrieves segmentation fields", () => {
    store.createShip({
      id: "enterprise",
      name: "Enterprise NX-01",
      tier: 5,
      shipClass: "explorer",
      grade: 4,
      rarity: "epic",
      faction: "neutral",
      combatProfile: "triangle",
      specialtyLoop: null,
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    const ship = store.getShip("enterprise");
    expect(ship!.grade).toBe(4);
    expect(ship!.rarity).toBe("epic");
    expect(ship!.faction).toBe("neutral");
    expect(ship!.combatProfile).toBe("triangle");
  });

  it("updates segmentation fields", () => {
    store.createShip({
      id: "augur",
      name: "Augur",
      tier: 3,
      shipClass: "battleship",
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });

    const updated = store.updateShip("augur", {
      grade: 3,
      rarity: "epic",
      faction: "romulan",
      combatProfile: "triangle",
    });
    expect(updated!.grade).toBe(3);
    expect(updated!.rarity).toBe("epic");
    expect(updated!.faction).toBe("romulan");
    expect(updated!.combatProfile).toBe("triangle");
  });

  it("rejects invalid combat profile", () => {
    expect(() =>
      store.createShip({
        id: "bad",
        name: "Bad",
        tier: null,
        shipClass: null,
        combatProfile: "invalid" as any,
        status: "ready",
        role: null,
        roleDetail: null,
        notes: null,
        importedFrom: null,
      }),
    ).toThrow("Invalid combat profile");
  });

  it("rejects invalid combat profile on update", () => {
    store.createShip({
      id: "s1",
      name: "Ship",
      tier: null,
      shipClass: null,
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });
    expect(() => store.updateShip("s1", { combatProfile: "bad" as any })).toThrow("Invalid combat profile");
  });

  it("lists ships and includes segmentation fields", () => {
    store.createShip({
      id: "augur",
      name: "Augur",
      tier: 3,
      shipClass: "battleship",
      grade: 3,
      combatProfile: "triangle",
      faction: "romulan",
      status: "ready",
      role: null,
      roleDetail: null,
      notes: null,
      importedFrom: null,
    });

    const ships = store.listShips();
    expect(ships[0].grade).toBe(3);
    expect(ships[0].combatProfile).toBe("triangle");
    expect(ships[0].faction).toBe("romulan");
  });
});

describe("FleetStore — Officer Affinities", () => {
  let store: FleetStore;

  beforeEach(() => {
    store = createFleetStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("creates an officer with affinity hints", () => {
    const officer = store.createOfficer({
      id: "pike",
      name: "Pike",
      rarity: "epic",
      level: 50,
      rank: "Captain",
      groupName: "TOS",
      classPreference: "any",
      activityAffinity: "pve",
      positionPreference: "captain",
      importedFrom: null,
    });
    expect(officer.classPreference).toBe("any");
    expect(officer.activityAffinity).toBe("pve");
    expect(officer.positionPreference).toBe("captain");
  });

  it("defaults affinity fields to null when omitted", () => {
    const officer = store.createOfficer({
      id: "legacy",
      name: "Legacy Officer",
      rarity: null,
      level: null,
      rank: null,
      groupName: null,
      importedFrom: null,
    });
    expect(officer.classPreference).toBeNull();
    expect(officer.activityAffinity).toBeNull();
    expect(officer.positionPreference).toBeNull();
  });

  it("persists and retrieves affinity fields", () => {
    store.createOfficer({
      id: "mariner",
      name: "Beckett Mariner",
      rarity: "epic",
      level: 45,
      rank: "Ensign",
      groupName: "LOWER DECKS CREW",
      classPreference: "any",
      activityAffinity: "pve",
      positionPreference: "below_deck",
      importedFrom: null,
    });
    const officer = store.getOfficer("mariner");
    expect(officer!.classPreference).toBe("any");
    expect(officer!.activityAffinity).toBe("pve");
    expect(officer!.positionPreference).toBe("below_deck");
  });

  it("updates affinity fields", () => {
    store.createOfficer({
      id: "kirk",
      name: "Kirk",
      rarity: "epic",
      level: 60,
      rank: "Captain",
      groupName: "TOS",
      importedFrom: null,
    });

    const updated = store.updateOfficer("kirk", {
      classPreference: "explorer",
      activityAffinity: "pvp",
      positionPreference: "captain",
    });
    expect(updated!.classPreference).toBe("explorer");
    expect(updated!.activityAffinity).toBe("pvp");
    expect(updated!.positionPreference).toBe("captain");
  });

  it("lists officers with affinity fields", () => {
    store.createOfficer({
      id: "pike",
      name: "Pike",
      rarity: "epic",
      level: 50,
      rank: "Captain",
      groupName: "TOS",
      classPreference: "any",
      activityAffinity: "pve",
      positionPreference: "captain",
      importedFrom: null,
    });

    const officers = store.listOfficers();
    expect(officers[0].classPreference).toBe("any");
    expect(officers[0].activityAffinity).toBe("pve");
    expect(officers[0].positionPreference).toBe("captain");
  });
});
