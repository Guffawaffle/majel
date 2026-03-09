/**
 * context-store.ts — AsyncLocalStorage for Request Correlation (ADR-039, D5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Provides a read-only convenience layer for logging and tracing correlation.
 * The RequestContext is stored in AsyncLocalStorage at the HTTP boundary and
 * can be retrieved anywhere in the call stack without explicit parameter threading.
 *
 * NOT used for:
 *   - Authorization decisions (use RequestContext parameter)
 *   - Tenant scoping (use readScope/writeScope)
 *   - Database identity (use DbScope)
 *
 * Usage:
 *   import { getRequestContext } from "./context-store.js";
 *   const ctx = getRequestContext();  // may be undefined outside requests
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./request-context.js";

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a callback with a RequestContext bound to AsyncLocalStorage.
 * Used by the context middleware to establish the ALS scope for each request.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(ctx, fn);
}

/**
 * Get the current RequestContext from AsyncLocalStorage.
 * Returns undefined when called outside a request scope (boot-time, background jobs).
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}
