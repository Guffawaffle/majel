/**
 * model-availability.test.ts — ADR-042 Resolver Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  resolveModelAvailability,
  resolveAllModelAvailability,
  parseModelOverrides,
} from "../src/server/services/model-availability.js";
import type { ModelOverrides, ProviderCapabilities } from "../src/server/services/model-availability.js";

// ─── Fixtures ─────────────────────────────────────────────────

const ALL_CAPABLE: ProviderCapabilities = { gemini: true, claude: true };
const GEMINI_ONLY: ProviderCapabilities = { gemini: true, claude: false };
const ADMIRAL = { isAdmiral: true };
const VISITOR = { isAdmiral: false };
const NO_OVERRIDES: ModelOverrides = {};

// ─── resolveModelAvailability ─────────────────────────────────

describe("resolveModelAvailability", () => {
  it("returns available for a stable Gemini model with no overrides", () => {
    const result = resolveModelAvailability("gemini-2.5-flash", ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    expect(result.available).toBe(true);
    expect(result.registryEnabled).toBe(true);
    expect(result.providerCapable).toBe(true);
    expect(result.roleAllowed).toBe(true);
    expect(result.adminEnabled).toBeNull();
    expect(result.effectiveReason).toBeUndefined();
  });

  it("returns unavailable for an unknown model", () => {
    const result = resolveModelAvailability("nonexistent-model", ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    expect(result.available).toBe(false);
    expect(result.effectiveReason).toBe("Unknown model");
  });

  it("returns unavailable for a preview model (defaultEnabled: false)", () => {
    const result = resolveModelAvailability("gemini-3-flash-preview", ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    expect(result.available).toBe(false);
    expect(result.registryEnabled).toBe(false);
    expect(result.providerCapable).toBe(true);
    expect(result.roleAllowed).toBe(true);
    expect(result.effectiveReason).toMatch(/not enabled by default/i);
  });

  it("admin override enables a preview model", () => {
    const overrides: ModelOverrides = {
      "gemini-3-flash-preview": { adminEnabled: true, reason: "Testing approved" },
    };
    const result = resolveModelAvailability("gemini-3-flash-preview", ADMIRAL, overrides, ALL_CAPABLE);
    expect(result.available).toBe(true);
    expect(result.registryEnabled).toBe(false);
    expect(result.adminEnabled).toBe(true);
  });

  it("admin override disables a stable model", () => {
    const overrides: ModelOverrides = {
      "gemini-2.5-flash": { adminEnabled: false, reason: "Degraded quality" },
    };
    const result = resolveModelAvailability("gemini-2.5-flash", ADMIRAL, overrides, ALL_CAPABLE);
    expect(result.available).toBe(false);
    expect(result.adminEnabled).toBe(false);
    expect(result.effectiveReason).toBe("Degraded quality");
  });

  it("returns unavailable for Claude when provider not configured", () => {
    const result = resolveModelAvailability("claude-haiku-4-5", ADMIRAL, NO_OVERRIDES, GEMINI_ONLY);
    expect(result.available).toBe(false);
    expect(result.providerCapable).toBe(false);
    expect(result.effectiveReason).toMatch(/vertex ai.*not configured/i);
  });

  it("Claude still unavailable by default even when provider is capable", () => {
    const result = resolveModelAvailability("claude-haiku-4-5", ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    expect(result.available).toBe(false);
    expect(result.registryEnabled).toBe(false);
    expect(result.providerCapable).toBe(true);
    expect(result.effectiveReason).toMatch(/not enabled by default/i);
  });

  it("Claude available when admin enables and provider is capable", () => {
    const overrides: ModelOverrides = {
      "claude-haiku-4-5": { adminEnabled: true, reason: "Quota approved" },
    };
    const result = resolveModelAvailability("claude-haiku-4-5", ADMIRAL, overrides, ALL_CAPABLE);
    expect(result.available).toBe(true);
  });

  it("Claude unavailable to non-admiral (role gate)", () => {
    const overrides: ModelOverrides = {
      "claude-haiku-4-5": { adminEnabled: true },
    };
    const result = resolveModelAvailability("claude-haiku-4-5", VISITOR, overrides, ALL_CAPABLE);
    expect(result.available).toBe(false);
    expect(result.roleAllowed).toBe(false);
    expect(result.effectiveReason).toMatch(/admiral/i);
  });

  it("provider capability takes precedence over admin override", () => {
    const overrides: ModelOverrides = {
      "claude-sonnet-4-6": { adminEnabled: true },
    };
    const result = resolveModelAvailability("claude-sonnet-4-6", ADMIRAL, overrides, GEMINI_ONLY);
    expect(result.available).toBe(false);
    expect(result.providerCapable).toBe(false);
    expect(result.adminEnabled).toBe(true);
  });

  it("visitor can see stable Gemini models (no roleGate)", () => {
    const result = resolveModelAvailability("gemini-2.5-flash", VISITOR, NO_OVERRIDES, ALL_CAPABLE);
    expect(result.available).toBe(true);
    expect(result.roleAllowed).toBe(true);
  });
});

// ─── resolveAllModelAvailability ──────────────────────────────

describe("resolveAllModelAvailability", () => {
  it("omits role-gated models for non-admiral", () => {
    const results = resolveAllModelAvailability(VISITOR, NO_OVERRIDES, ALL_CAPABLE);
    const ids = results.map((r) => r.model.id);
    expect(ids).not.toContain("claude-haiku-4-5");
    expect(ids).not.toContain("claude-sonnet-4-6");
    expect(ids).toContain("gemini-2.5-flash");
  });

  it("includes role-gated models for admiral", () => {
    const results = resolveAllModelAvailability(ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    const ids = results.map((r) => r.model.id);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("gemini-2.5-flash");
  });

  it("returns all 7 models for admiral with all providers capable", () => {
    const results = resolveAllModelAvailability(ADMIRAL, NO_OVERRIDES, ALL_CAPABLE);
    expect(results).toHaveLength(7);
  });

  it("returns 5 models for visitor (Claude excluded by roleGate)", () => {
    const results = resolveAllModelAvailability(VISITOR, NO_OVERRIDES, ALL_CAPABLE);
    expect(results).toHaveLength(5);
  });
});

// ─── parseModelOverrides ──────────────────────────────────────

describe("parseModelOverrides", () => {
  it("returns empty object for empty string", () => {
    expect(parseModelOverrides("")).toEqual({});
  });

  it("returns empty object for empty JSON object", () => {
    expect(parseModelOverrides("{}")).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseModelOverrides("not json")).toEqual({});
  });

  it("returns empty object for JSON array", () => {
    expect(parseModelOverrides("[]")).toEqual({});
  });

  it("parses valid overrides", () => {
    const input = JSON.stringify({
      "claude-haiku-4-5": { adminEnabled: true, reason: "Quota approved" },
      "gemini-3-flash-preview": { adminEnabled: false, reason: "Preview regression" },
    });
    const result = parseModelOverrides(input);
    expect(result["claude-haiku-4-5"]).toEqual({ adminEnabled: true, reason: "Quota approved" });
    expect(result["gemini-3-flash-preview"]).toEqual({ adminEnabled: false, reason: "Preview regression" });
  });

  it("ignores entries without adminEnabled boolean", () => {
    const input = JSON.stringify({
      "model-a": { adminEnabled: "yes" },
      "model-b": { reason: "no adminEnabled" },
      "model-c": { adminEnabled: true },
    });
    const result = parseModelOverrides(input);
    expect(result).not.toHaveProperty("model-a");
    expect(result).not.toHaveProperty("model-b");
    expect(result["model-c"]).toEqual({ adminEnabled: true });
  });

  it("omits reason if not a string", () => {
    const input = JSON.stringify({
      "model-a": { adminEnabled: true, reason: 42 },
    });
    const result = parseModelOverrides(input);
    expect(result["model-a"]).toEqual({ adminEnabled: true });
  });
});
