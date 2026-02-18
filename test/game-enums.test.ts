/**
 * game-enums.test.ts — STFC Game Enum Utility Tests
 */

import { describe, it, expect } from "vitest";
import { hullTypeLabel, officerClassLabel } from "../src/server/services/game-enums.js";

describe("hullTypeLabel", () => {
  it("returns null for null input", () => {
    expect(hullTypeLabel(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(hullTypeLabel(undefined)).toBeNull();
  });

  it("returns label for known hull type", () => {
    expect(hullTypeLabel(0)).toBe("Destroyer");
    expect(hullTypeLabel(1)).toBe("Survey");
    expect(hullTypeLabel(3)).toBe("Battleship");
  });

  it("returns null for unknown hull type", () => {
    expect(hullTypeLabel(999)).toBeNull();
  });
});

describe("officerClassLabel", () => {
  it("returns null for null input", () => {
    expect(officerClassLabel(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(officerClassLabel(undefined)).toBeNull();
  });

  it("returns label for known class", () => {
    expect(officerClassLabel(1)).toBe("Command");
    expect(officerClassLabel(2)).toBe("Science");
    expect(officerClassLabel(3)).toBe("Engineering");
  });

  it("returns null for unknown class", () => {
    expect(officerClassLabel(99)).toBeNull();
  });
});
