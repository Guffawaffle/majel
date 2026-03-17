/**
 * game-enums.test.ts — Tests for web game-enum utilities
 */

import { describe, it, expect } from "vitest";
import { factionCss } from "./game-enums.js";

describe("factionCss", () => {
  it("returns federation class for Federation", () => {
    expect(factionCss("Federation")).toBe("faction-federation");
  });

  it("returns klingon class for Klingon", () => {
    expect(factionCss("Klingon")).toBe("faction-klingon");
  });

  it("returns romulan class for Romulan", () => {
    expect(factionCss("Romulan")).toBe("faction-romulan");
  });

  it("returns borg class for Borg", () => {
    expect(factionCss("Borg")).toBe("faction-borg");
  });

  it("maps Assimilated to borg", () => {
    expect(factionCss("Assimilated")).toBe("faction-borg");
  });

  it("is case-insensitive", () => {
    expect(factionCss("FEDERATION")).toBe("faction-federation");
    expect(factionCss("klingon")).toBe("faction-klingon");
  });

  it("returns independent for unknown factions", () => {
    expect(factionCss("Swarm")).toBe("faction-independent");
    expect(factionCss("Eclipse")).toBe("faction-independent");
    expect(factionCss("Rogue")).toBe("faction-independent");
  });

  it("returns independent for null/undefined", () => {
    expect(factionCss(null)).toBe("faction-independent");
    expect(factionCss(undefined)).toBe("faction-independent");
  });

  it("returns independent for empty string", () => {
    expect(factionCss("")).toBe("faction-independent");
  });
});
