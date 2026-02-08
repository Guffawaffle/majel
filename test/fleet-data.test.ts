/**
 * fleet-data.test.ts — Tests for the Fleet Data Model
 *
 * Pure functions, no external dependencies — should be 100% coverage.
 */

import { describe, it, expect } from "vitest";
import {
  rowsToCsv,
  buildSection,
  buildFleetData,
  hasFleetData,
  getSections,
  fleetDataSummary,
  DEFAULT_TAB_MAPPING,
  type FleetData,
  type FleetSection,
} from "../src/server/fleet-data.js";

// ─── rowsToCsv ──────────────────────────────────────────────────

describe("rowsToCsv", () => {
  it("serializes simple rows", () => {
    const rows = [
      ["Name", "Level"],
      ["Kirk", "50"],
    ];
    expect(rowsToCsv(rows)).toBe("Name,Level\nKirk,50");
  });

  it("quotes cells containing commas", () => {
    const rows = [["Name, Rank", "Level"]];
    expect(rowsToCsv(rows)).toBe('"Name, Rank",Level');
  });

  it("escapes double quotes", () => {
    const rows = [['He said "hello"', "ok"]];
    expect(rowsToCsv(rows)).toBe('"He said ""hello""",ok');
  });

  it("quotes cells containing newlines", () => {
    const rows = [["line1\nline2", "ok"]];
    expect(rowsToCsv(rows)).toBe('"line1\nline2",ok');
  });

  it("handles null/undefined cells", () => {
    const rows = [[null as unknown as string, undefined as unknown as string, "ok"]];
    expect(rowsToCsv(rows)).toBe(",,ok");
  });

  it("handles empty rows", () => {
    expect(rowsToCsv([])).toBe("");
    expect(rowsToCsv([[]])).toBe("");
  });
});

// ─── buildSection ───────────────────────────────────────────────

describe("buildSection", () => {
  it("builds a section with correct metadata", () => {
    const rows = [
      ["Name", "Level", "Rank"],
      ["Kirk", "50", "Captain"],
      ["Spock", "45", "Commander"],
    ];
    const section = buildSection("officers", "My Officers", "Officers", rows);

    expect(section.type).toBe("officers");
    expect(section.label).toBe("My Officers");
    expect(section.source).toBe("Officers");
    expect(section.rowCount).toBe(2); // excludes header
    expect(section.headers).toEqual(["Name", "Level", "Rank"]);
    expect(section.csv).toContain("Kirk,50,Captain");
    expect(section.rows).toBe(rows);
  });

  it("handles empty rows", () => {
    const section = buildSection("ships", "Ships", "Ships", []);
    expect(section.rowCount).toBe(0);
    expect(section.headers).toEqual([]);
    expect(section.csv).toBe("");
  });

  it("handles header-only (no data rows)", () => {
    const section = buildSection("officers", "Officers", "Officers", [["Name", "Level"]]);
    expect(section.rowCount).toBe(0);
    expect(section.headers).toEqual(["Name", "Level"]);
  });
});

// ─── buildFleetData ─────────────────────────────────────────────

describe("buildFleetData", () => {
  it("aggregates sections into FleetData", () => {
    const sections: FleetSection[] = [
      buildSection("officers", "Officers", "Officers", [
        ["Name"], ["Kirk"], ["Spock"],
      ]),
      buildSection("ships", "Ships", "Ships", [
        ["Ship", "Tier"], ["Enterprise", "5"],
      ]),
    ];

    const data = buildFleetData("spreadsheet-123", sections);

    expect(data.spreadsheetId).toBe("spreadsheet-123");
    expect(data.sections).toHaveLength(2);
    expect(data.totalChars).toBeGreaterThan(0);
    expect(data.fetchedAt).toBeTruthy();
    // Total chars should be sum of both section CSVs
    expect(data.totalChars).toBe(
      sections[0].csv.length + sections[1].csv.length
    );
  });

  it("handles empty sections array", () => {
    const data = buildFleetData("empty-sheet", []);
    expect(data.sections).toHaveLength(0);
    expect(data.totalChars).toBe(0);
  });
});

// ─── hasFleetData ───────────────────────────────────────────────

describe("hasFleetData", () => {
  it("returns false for null", () => {
    expect(hasFleetData(null)).toBe(false);
  });

  it("returns false for empty sections", () => {
    const data = buildFleetData("empty", []);
    expect(hasFleetData(data)).toBe(false);
  });

  it("returns true for data with content", () => {
    const section = buildSection("officers", "Officers", "Officers", [
      ["Name"], ["Kirk"],
    ]);
    const data = buildFleetData("sheet-1", [section]);
    expect(hasFleetData(data)).toBe(true);
  });

  it("returns false when sections exist but have no chars", () => {
    // Build a section with empty rows — csv will be ""
    const section = buildSection("officers", "Officers", "Officers", []);
    const data = buildFleetData("sheet-1", [section]);
    // totalChars = 0
    expect(hasFleetData(data)).toBe(false);
  });
});

// ─── getSections ────────────────────────────────────────────────

describe("getSections", () => {
  const officers = buildSection("officers", "Officers", "Officers", [
    ["Name"], ["Kirk"],
  ]);
  const ships = buildSection("ships", "Ships", "Ships", [
    ["Ship"], ["Enterprise"],
  ]);
  const custom = buildSection("custom", "Notes", "Notes", [
    ["Note"], ["Hey"],
  ]);
  const data = buildFleetData("sheet-1", [officers, ships, custom]);

  it("filters by officers", () => {
    const result = getSections(data, "officers");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Officers");
  });

  it("filters by ships", () => {
    const result = getSections(data, "ships");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Ships");
  });

  it("filters by custom", () => {
    const result = getSections(data, "custom");
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Notes");
  });

  it("returns empty for no matches", () => {
    const officersOnly = buildFleetData("s", [officers]);
    expect(getSections(officersOnly, "ships")).toHaveLength(0);
  });
});

// ─── fleetDataSummary ───────────────────────────────────────────

describe("fleetDataSummary", () => {
  it("builds a summary object", () => {
    const section = buildSection("officers", "Officers", "Officers", [
      ["Name", "Level"],
      ["Kirk", "50"],
      ["Spock", "45"],
    ]);
    const data = buildFleetData("sheet-1", [section]);
    const summary = fleetDataSummary(data);

    expect(summary.totalChars).toBeGreaterThan(0);
    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0]).toEqual({
      label: "Officers",
      type: "officers",
      rows: 2,
    });
  });
});

// ─── DEFAULT_TAB_MAPPING ────────────────────────────────────────

describe("DEFAULT_TAB_MAPPING", () => {
  it("maps common tab names to types", () => {
    expect(DEFAULT_TAB_MAPPING.Officers).toBe("officers");
    expect(DEFAULT_TAB_MAPPING.Roster).toBe("officers");
    expect(DEFAULT_TAB_MAPPING.Ships).toBe("ships");
  });
});
