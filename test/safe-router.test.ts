/**
 * safe-router.test.ts — Tests for canonical async-safe router.
 *
 * Verifies that createSafeRouter:
 *   1. Catches async handler rejections → forwards to error middleware
 *   2. Catches sync throws → forwards to error middleware
 *   3. Passes normal sync/async handlers through unchanged
 *   4. Fires global error hooks on failure
 *   5. Wraps middleware (not just final handlers)
 *   6. All route files use createSafeRouter (architectural guard)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { readdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createSafeRouter, onRouteError, _resetHooks } from "../src/server/safe-router.js";
import { envelopeMiddleware, errorHandler, sendOk } from "../src/server/envelope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(envelopeMiddleware);
  return app;
}

afterEach(() => {
  _resetHooks();
});

// ─── Async Rejection Handling ───────────────────────────────

describe("createSafeRouter — async rejection handling", () => {
  it("catches rejected async GET handlers → 500 via errorHandler", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.get("/test", async (_req, _res) => {
      throw new Error("async kaboom");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("catches rejected async POST handlers", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.post("/test", async (_req, _res) => {
      throw new Error("post fail");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it("catches rejected async DELETE handlers", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.delete("/test/:id", async (_req, _res) => {
      throw new Error("delete fail");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).delete("/test/1");
    expect(res.status).toBe(500);
  });

  it("catches rejected async PATCH handlers", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.patch("/test/:id", async (_req, _res) => {
      throw new Error("patch fail");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).patch("/test/1").send({});
    expect(res.status).toBe(500);
  });

  it("catches rejected async PUT handlers", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.put("/test/:id", async (_req, _res) => {
      throw new Error("put fail");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).put("/test/1").send({});
    expect(res.status).toBe(500);
  });
});

// ─── Sync Throw Handling ────────────────────────────────────

describe("createSafeRouter — sync throw handling", () => {
  it("catches sync throws in handlers", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.get("/test", (_req, _res) => {
      throw new Error("sync kaboom");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

// ─── Normal Operation ───────────────────────────────────────

describe("createSafeRouter — normal operation", () => {
  it("passes successful async handlers through unchanged", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.get("/test", async (_req, res) => {
      sendOk(res, { message: "all good" });
    });
    app.use(router);

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("all good");
  });

  it("passes successful sync handlers through unchanged", async () => {
    const app = buildApp();
    const router = createSafeRouter();
    router.get("/test", (_req, res) => {
      sendOk(res, { sync: true });
    });
    app.use(router);

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.data.sync).toBe(true);
  });
});

// ─── Middleware Wrapping ────────────────────────────────────

describe("createSafeRouter — middleware wrapping", () => {
  it("catches async middleware failures before the handler", async () => {
    const app = buildApp();
    const router = createSafeRouter();

    const failingMiddleware = async (_req: express.Request, _res: express.Response, _next: express.NextFunction) => {
      throw new Error("middleware fail");
    };

    router.get("/test", failingMiddleware, async (_req, res) => {
      sendOk(res, { reached: true });
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it("allows passing middleware to next handler on success", async () => {
    const app = buildApp();
    const router = createSafeRouter();

    const passingMiddleware = async (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    };

    router.get("/test", passingMiddleware, async (_req, res) => {
      sendOk(res, { reached: true });
    });
    app.use(router);

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.data.reached).toBe(true);
  });
});

// ─── Global Error Hooks ─────────────────────────────────────

describe("createSafeRouter — global error hooks", () => {
  it("fires registered error hooks on async rejection", async () => {
    const hook = vi.fn();
    onRouteError(hook);

    const app = buildApp();
    const router = createSafeRouter();
    router.get("/boom", async (_req, _res) => {
      throw new Error("hook test");
    });
    app.use(router);
    app.use(errorHandler);

    await request(app).get("/boom");

    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hook test" }),
      expect.objectContaining({ method: "GET", path: "/boom" }),
    );
  });

  it("fires registered error hooks on sync throw", async () => {
    const hook = vi.fn();
    onRouteError(hook);

    const app = buildApp();
    const router = createSafeRouter();
    router.get("/sync-boom", (_req, _res) => {
      throw new Error("sync hook");
    });
    app.use(router);
    app.use(errorHandler);

    await request(app).get("/sync-boom");

    expect(hook).toHaveBeenCalledOnce();
    expect(hook.mock.calls[0][0].message).toBe("sync hook");
  });

  it("does not fire hooks on successful requests", async () => {
    const hook = vi.fn();
    onRouteError(hook);

    const app = buildApp();
    const router = createSafeRouter();
    router.get("/ok", async (_req, res) => {
      sendOk(res, {});
    });
    app.use(router);

    await request(app).get("/ok");
    expect(hook).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the hook", async () => {
    const hook = vi.fn();
    const unsub = onRouteError(hook);
    unsub();

    const app = buildApp();
    const router = createSafeRouter();
    router.get("/boom", async (_req, _res) => {
      throw new Error("should not reach hook");
    });
    app.use(router);
    app.use(errorHandler);

    await request(app).get("/boom");
    expect(hook).not.toHaveBeenCalled();
  });

  it("hook errors do not break error propagation", async () => {
    onRouteError(() => {
      throw new Error("hook itself fails");
    });

    const app = buildApp();
    const router = createSafeRouter();
    router.get("/boom", async (_req, _res) => {
      throw new Error("original error");
    });
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

// ─── Architectural Guard ────────────────────────────────────

describe("route files — architectural guard", () => {
  it("all route files use createSafeRouter (no bare Router())", () => {
    const routesDir = resolve(__dirname, "../src/server/routes");
    const routeFiles = readdirSync(routesDir).filter(f => f.endsWith(".ts"));

    const violations: string[] = [];
    for (const file of routeFiles) {
      const content = readFileSync(resolve(routesDir, file), "utf-8");
      // Check for bare Router() constructor (not createSafeRouter)
      if (/\bRouter\(\)/.test(content)) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });

  it("all route files import createSafeRouter", () => {
    const routesDir = resolve(__dirname, "../src/server/routes");
    const routeFiles = readdirSync(routesDir).filter(f => f.endsWith(".ts"));

    const missing: string[] = [];
    for (const file of routeFiles) {
      const content = readFileSync(resolve(routesDir, file), "utf-8");
      if (!content.includes("createSafeRouter")) {
        missing.push(file);
      }
    }

    expect(missing).toEqual([]);
  });
});
