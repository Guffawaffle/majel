/**
 * middleware.test.ts — Tests for ADR-005 Phase 4 operability middleware.
 *
 * Tests:
 * - Request ID present on all responses
 * - Oversized bodies rejected with correct error code
 * - Timeout fires and returns 504 with error envelope
 * - Unhandled errors caught and wrapped with request ID
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { testRequest } from "./helpers/test-request.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { 
  envelopeMiddleware, 
  errorHandler, 
  createTimeoutMiddleware, 
  ErrorCode,
  asyncHandler,
  sendOk,
} from "../src/server/envelope.js";

// ─── Request ID Tests ───────────────────────────────────────────

describe("Request ID middleware", () => {
  it("attaches a unique request ID to every response header", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res1 = await testRequest(app).get("/test");
    const res2 = await testRequest(app).get("/test");

    expect(res1.headers["x-request-id"]).toBeDefined();
    expect(res2.headers["x-request-id"]).toBeDefined();
    expect(res1.headers["x-request-id"]).not.toBe(res2.headers["x-request-id"]);
  });

  it("includes request ID in response meta", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/test", (_req, res) => {
      res.json({
        ok: true,
        data: { test: true },
        meta: {
          requestId: res.locals._requestId,
          timestamp: new Date().toISOString(),
          durationMs: 0,
        },
      });
    });

    const res = await testRequest(app).get("/test");
    const requestId = res.headers["x-request-id"];
    expect(res.body.meta.requestId).toBe(requestId);
  });

  it("request ID is a valid UUID v4", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await testRequest(app).get("/test");
    const requestId = res.headers["x-request-id"] as string;
    
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(requestId).toMatch(uuidV4Regex);
  });
});

// ─── Body Limits Tests ──────────────────────────────────────────

describe("Body limits middleware", () => {
  it("accepts payloads under 100kb", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(envelopeMiddleware);
    app.post("/test", (req, res) => res.json({ received: req.body }));

    // ~50kb payload
    const payload = { data: "x".repeat(50 * 1024) };
    const res = await testRequest(app).post("/test").send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received.data).toBe(payload.data);
  });

  it("rejects payloads over 100kb with 413", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(envelopeMiddleware);
    app.post("/test", (req, res) => res.json({ received: req.body }));
    app.use(errorHandler);

    // ~150kb payload (over limit)
    const payload = { data: "x".repeat(150 * 1024) };
    const res = await testRequest(app).post("/test").send(payload);

    expect(res.status).toBe(413);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("error response includes request ID on payload too large", async () => {
    const app = express();
    app.use(envelopeMiddleware);
    app.use(express.json({ limit: "100kb" }));
    app.post("/test", (req, res) => res.json({ received: req.body }));
    app.use(errorHandler);

    const payload = { data: "x".repeat(150 * 1024) };
    const res = await testRequest(app).post("/test").send(payload);

    expect(res.status).toBe(413);
    expect(res.body.meta.requestId).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(res.body.meta.requestId);
  });
});

// ─── Timeout Middleware Tests ───────────────────────────────────

describe("Timeout middleware", () => {
  it("allows requests that complete before timeout", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/fast", createTimeoutMiddleware(1000), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 100));
      res.json({ ok: true, data: { completed: true } });
    });

    const res = await testRequest(app).get("/fast");
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(true);
  });

  it("returns 504 when request exceeds timeout", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/slow", createTimeoutMiddleware(100), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 500));
      // Don't try to respond after timeout
      if (!res.headersSent) {
        res.json({ ok: true, data: { completed: true } });
      }
    });

    const res = await testRequest(app).get("/slow");
    expect(res.status).toBe(504);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe(ErrorCode.REQUEST_TIMEOUT);
    expect(res.body.error.message).toContain("timeout");
  });

  it("timeout response includes request ID", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/slow", createTimeoutMiddleware(100), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 500));
      if (!res.headersSent) {
        res.json({ ok: true });
      }
    });

    const res = await testRequest(app).get("/slow");
    expect(res.status).toBe(504);
    expect(res.body.meta.requestId).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(res.body.meta.requestId);
  });

  it("does not send timeout response if handler already responded", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/race", createTimeoutMiddleware(500), async (_req, res) => {
      // Respond immediately
      res.json({ ok: true, data: { fast: true } });
      // Then wait (timeout should not fire)
      await new Promise((r) => setTimeout(r, 600));
    });

    const res = await testRequest(app).get("/race");
    expect(res.status).toBe(200);
    expect(res.body.data.fast).toBe(true);
  });

  it("different routes can have different timeouts", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    
    app.get("/quick", createTimeoutMiddleware(200), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 50));
      res.json({ ok: true, data: { route: "quick" } });
    });
    
    app.get("/patient", createTimeoutMiddleware(1000), async (_req, res) => {
      await new Promise((r) => setTimeout(r, 100));
      res.json({ ok: true, data: { route: "patient" } });
    });

    const quickRes = await testRequest(app).get("/quick");
    expect(quickRes.status).toBe(200);
    expect(quickRes.body.data.route).toBe("quick");

    const patientRes = await testRequest(app).get("/patient");
    expect(patientRes.status).toBe(200);
    expect(patientRes.body.data.route).toBe("patient");
  });
});

// ─── Error Handler Tests ────────────────────────────────────────

describe("Error handler middleware", () => {
  it("catches unhandled errors and wraps in envelope", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/error", (_req, _res) => {
      throw new Error("Something went wrong");
    });
    app.use(errorHandler);

    const res = await testRequest(app).get("/error");
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(res.body.error.message).toBe("Something went wrong");
  });

  it("error response includes request ID", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/error", (_req, _res) => {
      throw new Error("Test error");
    });
    app.use(errorHandler);

    const res = await testRequest(app).get("/error");
    expect(res.body.meta.requestId).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(res.body.meta.requestId);
  });

  it("respects custom status codes from errors", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/error", (_req, _res) => {
      const err = new Error("Not found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    app.use(errorHandler);

    const res = await testRequest(app).get("/error");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Not found");
  });

  it("handles errors with statusCode property", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/error", (_req, _res) => {
      const err = new Error("Unauthorized") as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    });
    app.use(errorHandler);

    const res = await testRequest(app).get("/error");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Unauthorized");
  });

  it("does not send error if headers already sent (e.g., after timeout)", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/timeout-then-error", createTimeoutMiddleware(100), asyncHandler(async (_req, _res) => {
      await new Promise((r) => setTimeout(r, 200));
      throw new Error("This should not be sent");
    }));
    app.use(errorHandler);

    const res = await testRequest(app).get("/timeout-then-error");
    // Should get timeout response, not error
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe(ErrorCode.REQUEST_TIMEOUT);
  });

  it("handles async errors in route handlers", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/async-error", asyncHandler(async (_req, _res) => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("Async failure");
    }));
    app.use(errorHandler);

    const res = await testRequest(app).get("/async-error");
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Async failure");
  });

  it("includes duration in error response meta", async () => {
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    app.get("/error", asyncHandler(async (_req, _res) => {
      await new Promise((r) => setTimeout(r, 50));
      throw new Error("Test");
    }));
    app.use(errorHandler);

    const res = await testRequest(app).get("/error");
    expect(res.body.meta.durationMs).toBeGreaterThan(40);
    expect(res.body.meta.timestamp).toBeDefined();
  });
});

// ─── Integration Tests ──────────────────────────────────────────

describe("Middleware integration", () => {
  it("all middleware work together correctly", async () => {
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    app.use(envelopeMiddleware);
    
    // Use the production sendOk() path — not a hand-rolled res.json()
    app.post("/api/process", createTimeoutMiddleware(500), (req, res) => {
      sendOk(res, { processed: req.body });
    });
    
    app.use(errorHandler);

    const payload = { message: "test data" };
    const res = await testRequest(app).post("/api/process").send(payload);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.processed.message).toBe("test data");
    expect(res.body.meta.requestId).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(res.body.meta.requestId);
    // Verify duration is computed (non-negative number) — don't assert wall-clock
    // precision. Date.now() is not monotonic; NTP corrections can push it backward,
    // which caused the original flake (durationMs: -530).
    expect(res.body.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("request ID is consistent across middleware chain", async () => {
    const requestIds: string[] = [];
    
    const app = express();
    app.use(express.json());
    app.use(envelopeMiddleware);
    
    // Custom middleware to capture request ID
    app.use((req: Request, res: Response, next: NextFunction) => {
      requestIds.push(res.locals._requestId);
      next();
    });
    
    app.get("/test", (_req, res) => {
      requestIds.push(res.locals._requestId);
      throw new Error("Capture ID in error");
    });
    
    app.use(errorHandler);

    const res = await testRequest(app).get("/test");
    
    // All captured IDs should be the same
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[0]).toBe(res.body.meta.requestId);
  });
});
