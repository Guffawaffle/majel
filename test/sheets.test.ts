/**
 * sheets.test.ts — Tests for Google Sheets integration.
 *
 * We can only unit-test hasCredentials(), parseTabMapping(), and the CSV
 * serialization logic without real Google OAuth. The OAuth flow and
 * fetchRoster/fetchFleetData are integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { parseTabMapping } from "../src/server/sheets.js";

// We need to mock fs before importing sheets, since it checks file existence at import time
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

describe("sheets", () => {
  describe("hasCredentials", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns true when credentials.json exists", async () => {
      const fsMock = vi.mocked(fs.existsSync);
      fsMock.mockReturnValue(true);

      // Dynamic import to pick up the mock
      const { hasCredentials } = await import("../src/server/sheets.js");
      expect(hasCredentials()).toBe(true);
    });

    it("returns false when credentials.json does not exist", async () => {
      const fsMock = vi.mocked(fs.existsSync);
      fsMock.mockReturnValue(false);

      const { hasCredentials } = await import("../src/server/sheets.js");
      expect(hasCredentials()).toBe(false);
    });
  });

  describe("parseTabMapping", () => {
    it("returns default mapping for undefined input", () => {
      const mapping = parseTabMapping(undefined);
      expect(mapping.Officers).toBe("officers");
      expect(mapping.Roster).toBe("officers");
      expect(mapping.Ships).toBe("ships");
    });

    it("returns default mapping for empty string", () => {
      const mapping = parseTabMapping("");
      expect(mapping).toHaveProperty("Officers");
    });

    it("returns default mapping for whitespace-only", () => {
      const mapping = parseTabMapping("   ");
      expect(mapping).toHaveProperty("Officers");
    });

    it("parses a simple mapping string", () => {
      const mapping = parseTabMapping("MyOfficers:officers,MyShips:ships");
      expect(mapping.MyOfficers).toBe("officers");
      expect(mapping.MyShips).toBe("ships");
      expect(Object.keys(mapping)).toHaveLength(2);
    });

    it("handles whitespace around entries", () => {
      const mapping = parseTabMapping(" Fleet Officers : officers , Big Ships : ships ");
      expect(mapping["Fleet Officers"]).toBe("officers");
      expect(mapping["Big Ships"]).toBe("ships");
    });

    it("maps unknown types to custom", () => {
      const mapping = parseTabMapping("Notes:notes,Research:research");
      expect(mapping.Notes).toBe("custom");
      expect(mapping.Research).toBe("custom");
    });

    it("handles valid custom type", () => {
      const mapping = parseTabMapping("MyNotes:custom");
      expect(mapping.MyNotes).toBe("custom");
    });

    it("ignores malformed entries", () => {
      const mapping = parseTabMapping("Good:officers,,BadEntry,Also:ships");
      expect(mapping.Good).toBe("officers");
      expect(mapping.Also).toBe("ships");
      expect(Object.keys(mapping)).toHaveLength(2);
    });

    it("returns default if all entries are malformed", () => {
      const mapping = parseTabMapping("nocolon,alsonocolon");
      expect(mapping).toHaveProperty("Officers");
    });
  });
});
