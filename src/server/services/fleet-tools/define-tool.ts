/**
 * define-tool.ts — Declaration-Driven Tool Registration (ADR-039 D7, Stage 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Each fleet tool declares its name, store dependencies, and run function
 * via `defineTool()`. The `ToolRegistry` replaces the switch-based dispatcher
 * with map lookup and makes the dependency graph of every tool explicit.
 *
 * Tools that require no store dependencies use `deps: []`.
 */

import type { ResolvedStores, ToolEnv } from "./declarations.js";

// ─── Types ──────────────────────────────────────────────────

/** Key of a store dependency available in ResolvedStores. */
export type DepKey = keyof ResolvedStores;

/**
 * A fully self-describing tool definition.
 *
 * `deps` declares which stores the tool actually reads or writes.
 * `run` receives the raw args dict and the full ToolEnv.
 */
export interface ToolDef {
  readonly name: string;
  readonly deps: readonly DepKey[];
  run(args: Record<string, unknown>, env: ToolEnv): Promise<object>;
}

/**
 * Create a typed tool definition.
 * Identity function — exists for readability and future compile-time validation.
 */
export function defineTool(def: ToolDef): ToolDef {
  return def;
}

// ─── Registry ───────────────────────────────────────────────

/**
 * Map-based tool registry. Replaces the giant switch statement in the dispatcher.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  /** Register a tool definition. Throws if the name is already taken. */
  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. */
  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  /** Check whether a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** All registered tool names. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** All registered tool definitions. */
  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
