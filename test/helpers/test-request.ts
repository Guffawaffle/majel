/**
 * test-request.ts — Supertest wrapper with CSRF header (ADR-023)
 *
 * All test HTTP requests that modify state (POST, PUT, PATCH, DELETE)
 * must include the X-Requested-With: majel-client header.
 *
 * Usage:
 *   import { testRequest } from './helpers/test-request.js';
 *   const res = await testRequest(app).post('/api/foo').send({ bar: 1 });
 */
import request from "supertest";
import type { Express } from "express";

type SuperTestAgent = ReturnType<typeof request>;

/**
 * Wraps supertest's request() to automatically add the CSRF header
 * on state-changing methods (POST, PUT, PATCH, DELETE).
 */
export function testRequest(app: Express): SuperTestAgent {
  const agent = request(app);

  // Proxy that intercepts .post(), .put(), .patch(), .delete()
  // and auto-sets the X-Requested-With header
  return new Proxy(agent, {
    get(target, prop: string) {
      const original = (target as any)[prop];
      if (typeof original !== "function") return original;

      if (["post", "put", "patch", "delete"].includes(prop)) {
        return (...args: any[]) => {
          const test = original.apply(target, args);
          return test.set("X-Requested-With", "majel-client");
        };
      }
      return original.bind(target);
    },
  });
}
