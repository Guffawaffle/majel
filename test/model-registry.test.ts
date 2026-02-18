/**
 * model-registry.test.ts — Gemini Model Registry Tests
 */

import { describe, it, expect } from "vitest";
import {
  getModelDef,
  resolveModelId,
  MODEL_REGISTRY,
  DEFAULT_MODEL,
} from "../src/server/services/gemini/model-registry.js";

describe("getModelDef", () => {
  it("returns definition for a known model", () => {
    const def = getModelDef("gemini-2.5-flash");
    expect(def).not.toBeNull();
    expect(def!.name).toBe("Gemini 2.5 Flash");
    expect(def!.thinking).toBe(true);
  });

  it("returns null for an unknown model", () => {
    expect(getModelDef("nonexistent-model")).toBeNull();
  });

  it("returns definition for every registered model", () => {
    for (const model of MODEL_REGISTRY) {
      expect(getModelDef(model.id)).toEqual(model);
    }
  });
});

describe("resolveModelId", () => {
  it("returns the model ID when valid", () => {
    expect(resolveModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("returns default for null", () => {
    expect(resolveModelId(null)).toBe(DEFAULT_MODEL);
  });

  it("returns default for undefined", () => {
    expect(resolveModelId(undefined)).toBe(DEFAULT_MODEL);
  });

  it("returns default for unknown model ID", () => {
    expect(resolveModelId("fake-model")).toBe(DEFAULT_MODEL);
  });

  it("returns default for empty string", () => {
    expect(resolveModelId("")).toBe(DEFAULT_MODEL);
  });
});
