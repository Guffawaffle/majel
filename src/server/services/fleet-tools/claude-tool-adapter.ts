/**
 * claude-tool-adapter.ts — Gemini → Claude tool declaration converter.
 *
 * ADR-041 Phase 2: Translates FLEET_TOOL_DECLARATIONS from Gemini's
 * OpenAPI 3.0 format (@google/genai FunctionDeclaration[]) to Anthropic's
 * Claude tool format (JSON Schema-based).
 */

import type { FunctionDeclaration } from "@google/genai";

// ─── Claude Tool Types ──────────────────────────────────────

export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: ClaudeJsonSchema;
}

export interface ClaudeJsonSchema {
  type: "object";
  properties: Record<string, ClaudePropertySchema>;
  required?: string[];
}

export interface ClaudePropertySchema {
  type: string;
  description?: string;
  items?: ClaudePropertySchema;
  properties?: Record<string, ClaudePropertySchema>;
  required?: string[];
}

// ─── Type Mapping ───────────────────────────────────────────

/** Map Gemini Type enum values (uppercase) to JSON Schema types (lowercase). */
const GEMINI_TO_JSON_SCHEMA: Record<string, string> = {
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
};

function mapType(geminiType: string): string {
  return GEMINI_TO_JSON_SCHEMA[geminiType] ?? "string";
}

// ─── Converter ──────────────────────────────────────────────

/**
 * Convert a single Gemini property schema to Claude JSON Schema format.
 * Handles nested objects and arrays recursively.
 */
function convertProperty(prop: Record<string, unknown>): ClaudePropertySchema {
  const result: ClaudePropertySchema = {
    type: mapType(String(prop.type ?? "STRING")),
  };
  if (prop.description) {
    result.description = String(prop.description);
  }
  // Array items
  if (result.type === "array" && prop.items) {
    result.items = convertProperty(prop.items as Record<string, unknown>);
  }
  // Nested object properties
  if (result.type === "object" && prop.properties) {
    const nested = prop.properties as Record<string, Record<string, unknown>>;
    result.properties = {};
    for (const [key, val] of Object.entries(nested)) {
      result.properties[key] = convertProperty(val);
    }
    if (prop.required) {
      result.required = prop.required as string[];
    }
  }
  return result;
}

/**
 * Convert Gemini FunctionDeclarations to Claude tool definitions.
 *
 * Tools with no parameters get an empty `{ type: "object", properties: {} }`.
 */
export function toClaudeTools(declarations: FunctionDeclaration[]): ClaudeToolDef[] {
  return declarations.map((decl) => {
    const tool: ClaudeToolDef = {
      name: decl.name!,
      description: decl.description ?? "",
      input_schema: { type: "object", properties: {} },
    };

    if (decl.parameters) {
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>> | undefined;

      if (props) {
        for (const [key, val] of Object.entries(props)) {
          tool.input_schema.properties[key] = convertProperty(val);
        }
      }
      if (params.required) {
        tool.input_schema.required = params.required as string[];
      }
    }

    return tool;
  });
}
