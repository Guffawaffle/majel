/**
 * fleet-tools/index.ts — Barrel & Dispatcher
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Re-exports public API (ToolContext, FLEET_TOOL_DECLARATIONS, executeFleetTool).
 * Contains the dispatcher that routes tool calls to read or mutation implementations.
 */

import { log } from "../../logger.js";
import type { ToolEnv } from "./declarations.js";
import { toolRegistry } from "./tool-registry.js";

// Re-export public surface
export { FLEET_TOOL_DECLARATIONS, type ToolEnv, type ToolContext, type ResolvedStores, type ToolContextFactory } from "./declarations.js";
export { toolRegistry } from "./tool-registry.js";
export { type ToolDef, type DepKey } from "./define-tool.js";

// ─── Dispatcher ─────────────────────────────────────────────

/**
 * Execute a fleet tool by name with the given arguments.
 *
 * Returns a plain object suitable for FunctionResponse.response.
 * Errors are caught and returned as { error: string } — never thrown —
 * so the model can gracefully inform the Admiral.
 */
export async function executeFleetTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  const startTime = Date.now();

  try {
    const result = await dispatchTool(name, args, ctx);
    const durationMs = Date.now() - startTime;
    log.gemini.debug({ tool: name, durationMs }, "tool:execute");
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log.gemini.warn({ tool: name, durationMs, err: message }, "tool:error");
    return { error: `Tool execution failed: ${message}` };
  }
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolEnv,
): Promise<object> {
  const tool = toolRegistry.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  return tool.run(args, ctx);
}
