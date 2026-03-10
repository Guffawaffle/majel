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
  toClaudeTools,
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

describe("toClaudeTools (ADR-041 Phase 2)", () => {
  const claudeTools = toClaudeTools(FLEET_TOOL_DECLARATIONS);

  it("produces the same number of tools as Gemini declarations", () => {
    expect(claudeTools.length).toBe(FLEET_TOOL_DECLARATIONS.length);
  });

  it("every tool has name, description, and input_schema", () => {
    for (const tool of claudeTools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description).toBeTypeOf("string");
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.properties).toBeDefined();
    }
  });

  it("tool names match between Gemini and Claude formats", () => {
    const geminiNames = FLEET_TOOL_DECLARATIONS.map((d: { name: string }) => d.name).sort();
    const claudeNames = claudeTools.map((t) => t.name).sort();
    expect(claudeNames).toEqual(geminiNames);
  });

  it("no-param tools get empty properties object", () => {
    const noParams = FLEET_TOOL_DECLARATIONS.filter((d: { parameters?: unknown }) => !d.parameters);
    expect(noParams.length).toBeGreaterThan(0); // sanity: at least one exists
    for (const decl of noParams) {
      const claude = claudeTools.find((c) => c.name === decl.name);
      expect(claude).toBeDefined();
      expect(claude!.input_schema.properties).toEqual({});
      expect(claude!.input_schema.required).toBeUndefined();
    }
  });

  it("parameter types are lowercase JSON Schema types", () => {
    const validTypes = new Set(["string", "number", "integer", "boolean", "array", "object"]);
    for (const tool of claudeTools) {
      for (const [key, prop] of Object.entries(tool.input_schema.properties)) {
        expect(
          validTypes.has(prop.type),
          `Tool "${tool.name}" param "${key}" has invalid type "${prop.type}"`,
        ).toBe(true);
      }
    }
  });

  it("required arrays are preserved", () => {
    const withRequired = FLEET_TOOL_DECLARATIONS.filter(
      (d: { parameters?: { required?: string[] } }) => d.parameters?.required?.length,
    );
    expect(withRequired.length).toBeGreaterThan(0); // sanity
    for (const decl of withRequired) {
      const claude = claudeTools.find((c) => c.name === decl.name);
      expect(claude).toBeDefined();
      expect(claude!.input_schema.required).toEqual(
        (decl.parameters as { required: string[] }).required,
      );
    }
  });

  it("descriptions are preserved", () => {
    for (const decl of FLEET_TOOL_DECLARATIONS) {
      const claude = claudeTools.find((c) => c.name === decl.name);
      expect(claude!.description).toBe(decl.description);
    }
  });
});
