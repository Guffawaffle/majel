/**
 * tool-registry.test.ts — Registry coverage for defineTool (ADR-039 D7, Stage 2)
 *
 * Verifies:
 * - Every tool in FLEET_TOOL_DECLARATIONS is registered in the toolRegistry
 * - Every registered tool has a corresponding declaration
 * - No duplicate registrations (enforced at load time)
 * - Registry dispatch returns proper error for unknown tools
 * - ToolDef shape: every entry has name, deps array, and run function
 */

import { describe, it, expect } from "vitest";
import {
  FLEET_TOOL_DECLARATIONS,
  toolRegistry,
} from "../src/server/services/fleet-tools/index.js";
import type { ToolDef } from "../src/server/services/fleet-tools/define-tool.js";
import { ToolRegistry, defineTool } from "../src/server/services/fleet-tools/define-tool.js";

describe("ToolRegistry (ADR-039 Phase 10)", () => {
  const declaredNames = FLEET_TOOL_DECLARATIONS.map(
    (d: { name: string }) => d.name,
  );

  it("registers every tool declared in FLEET_TOOL_DECLARATIONS", () => {
    const missing = declaredNames.filter((n: string) => !toolRegistry.has(n));
    expect(missing, `Missing registry entries: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("has no registered tools without a matching declaration", () => {
    const extra = toolRegistry
      .names()
      .filter((n) => !declaredNames.includes(n));
    expect(extra, `Extra registry entries: ${extra.join(", ")}`).toEqual([]);
  });

  it("matches declaration count exactly", () => {
    expect(toolRegistry.size).toBe(FLEET_TOOL_DECLARATIONS.length);
  });

  it("every tool has a valid ToolDef shape", () => {
    for (const tool of toolRegistry.all()) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.deps)).toBe(true);
      expect(tool.run).toBeTypeOf("function");
    }
  });

  it("deps arrays contain only valid ResolvedStores keys", () => {
    const validKeys = new Set([
      "referenceStore",
      "overlayStore",
      "crewStore",
      "targetStore",
      "receiptStore",
      "researchStore",
      "inventoryStore",
      "userSettingsStore",
      "resourceDefs",
    ]);
    for (const tool of toolRegistry.all()) {
      for (const dep of tool.deps) {
        expect(
          validKeys.has(dep),
          `Tool "${tool.name}" declares unknown dep "${dep}"`,
        ).toBe(true);
      }
    }
  });

  it("duplicate registration throws", () => {
    const reg = new ToolRegistry();
    const tool = defineTool({
      name: "test_tool",
      deps: [],
      run: async () => ({}),
    });
    reg.register(tool);
    expect(() => reg.register(tool)).toThrow("Duplicate tool registration");
  });

  it("get() returns undefined for unknown tools", () => {
    expect(toolRegistry.get("nonexistent_tool")).toBeUndefined();
  });

  it("all() and names() have consistent length", () => {
    expect(toolRegistry.all().length).toBe(toolRegistry.names().length);
    expect(toolRegistry.all().length).toBe(toolRegistry.size);
  });
});
