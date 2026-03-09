/**
 * test-context-builder.ts — Test Builder for RequestContext (ADR-039, D8)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Builder pattern for constructing RequestContext instances in tests.
 * Avoids production-divergent test subclasses while allowing per-test
 * overrides of individual fields.
 *
 * Usage:
 *   const ctx = new TestContextBuilder()
 *     .withUser("user-123")
 *     .withRoles("admiral")
 *     .withPool(testPool)
 *     .build();
 */

import pino from "pino";
import type { Pool } from "./db.js";
import { RequestContext } from "./request-context.js";

/**
 * Builder for constructing RequestContext instances in tests.
 *
 * Defaults:
 *   - userId: "test-user"
 *   - tenantId: same as userId
 *   - roles: ["ensign"]
 *   - requestId: "test-request-<counter>"
 *   - log: silent pino logger
 *   - pool: must be provided (no default — tests must be explicit about DB)
 */
export class TestContextBuilder {
  private static counter = 0;

  private userId = "test-user";
  private tenantId: string | undefined;
  private roles: string[] = ["ensign"];
  private requestId: string | undefined;
  private pool: Pool | undefined;
  private startedAtMs: number | undefined;

  withUser(userId: string): this {
    this.userId = userId;
    return this;
  }

  withTenant(tenantId: string): this {
    this.tenantId = tenantId;
    return this;
  }

  withRoles(...roles: string[]): this {
    this.roles = roles;
    return this;
  }

  withRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }

  withPool(pool: Pool): this {
    this.pool = pool;
    return this;
  }

  withStartedAtMs(ms: number): this {
    this.startedAtMs = ms;
    return this;
  }

  build(): RequestContext {
    if (!this.pool) {
      throw new Error("TestContextBuilder: pool is required — call .withPool(pool) before .build()");
    }

    TestContextBuilder.counter++;

    return new RequestContext({
      identity: {
        requestId: this.requestId ?? `test-request-${TestContextBuilder.counter}`,
        userId: this.userId,
        tenantId: this.tenantId ?? this.userId,
        roles: this.roles,
      },
      log: pino({ level: "silent" }),
      pool: this.pool,
      startedAtMs: this.startedAtMs,
    });
  }
}
