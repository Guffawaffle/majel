/**
 * fetch.test.ts — Tests for the API fetch wrapper
 *
 * Validates ADR-004 envelope unwrapping, error handling,
 * CSRF header injection, and 5xx sanitization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, apiPost, apiPatch, apiDelete, ApiError, qs, pathEncode } from "./fetch.js";

// ─── Helpers ────────────────────────────────────────────────

function mockFetch(response: Partial<Response> & { body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    statusText: response.statusText ?? "OK",
    json: vi.fn().mockResolvedValue(response.body ?? {}),
    headers: new Headers(),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── qs() ───────────────────────────────────────────────────

describe("qs", () => {
  it("builds query string from object", () => {
    expect(qs({ page: 1, limit: 10 })).toBe("?page=1&limit=10");
  });

  it("returns empty string when no values", () => {
    expect(qs({})).toBe("");
  });

  it("skips null and undefined values", () => {
    expect(qs({ a: "1", b: null, c: undefined })).toBe("?a=1");
  });

  it("skips empty string values", () => {
    expect(qs({ a: "", b: "hello" })).toBe("?b=hello");
  });

  it("converts booleans to strings", () => {
    expect(qs({ active: true })).toBe("?active=true");
  });
});

// ─── pathEncode() ───────────────────────────────────────────

describe("pathEncode", () => {
  it("encodes special characters", () => {
    expect(pathEncode("hello world")).toBe("hello%20world");
  });

  it("converts numbers to strings", () => {
    expect(pathEncode(42)).toBe("42");
  });

  it("encodes slashes", () => {
    expect(pathEncode("a/b")).toBe("a%2Fb");
  });
});

// ─── apiFetch() — success cases ─────────────────────────────

describe("apiFetch", () => {
  it("unwraps ADR-004 envelope — returns data field", async () => {
    mockFetch({ ok: true, status: 200, body: { data: { name: "Aria" } } });
    const result = await apiFetch<{ name: string }>("/api/test");
    expect(result).toEqual({ name: "Aria" });
  });

  it("sends CSRF header on all requests", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiFetch("/api/test");
    expect(fn).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      headers: expect.objectContaining({ "X-Requested-With": "majel-client" }),
    }));
  });

  it("sends credentials: same-origin", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiFetch("/api/test");
    expect(fn).toHaveBeenCalledWith("/api/test", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("removes Content-Type for GET requests", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiFetch("/api/test");
    const headers = fn.mock.calls[0][1].headers;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("includes Content-Type for POST requests", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiFetch("/api/test", { method: "POST", body: JSON.stringify({}) });
    const headers = fn.mock.calls[0][1].headers;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ─── apiFetch() — error cases ───────────────────────────────

describe("apiFetch — errors", () => {
  it("throws ApiError with message from envelope on 4xx", async () => {
    mockFetch({
      ok: false, status: 400, statusText: "Bad Request",
      body: { error: { message: "Email is required" } },
    });

    await expect(apiFetch("/api/auth/signup")).rejects.toThrow(ApiError);
    await expect(apiFetch("/api/auth/signup")).rejects.toThrow("Email is required");
  });

  it("sanitizes 5xx errors to generic message", async () => {
    mockFetch({
      ok: false, status: 500, statusText: "Internal Server Error",
      body: { error: { message: "ECONNREFUSED 127.0.0.1:5432" } },
    });

    try {
      await apiFetch("/api/health");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).message).toBe("Server error — please try again");
      expect((e as ApiError).status).toBe(500);
    }
  });

  it("handles non-JSON error responses gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: vi.fn().mockRejectedValue(new Error("not JSON")),
      headers: new Headers(),
    }));

    await expect(apiFetch("/api/test")).rejects.toThrow("Server error — please try again");
  });

  it("sets status on ApiError", async () => {
    mockFetch({
      ok: false, status: 403, statusText: "Forbidden",
      body: { error: { message: "Access denied" } },
    });

    try {
      await apiFetch("/api/test");
    } catch (e) {
      expect((e as ApiError).status).toBe(403);
    }
  });
});

// ─── Convenience methods ────────────────────────────────────

describe("apiPost", () => {
  it("sends POST with JSON body", async () => {
    const fn = mockFetch({ ok: true, body: { data: { id: "1" } } });
    const result = await apiPost("/api/chat", { message: "hello" });
    expect(result).toEqual({ id: "1" });
    expect(fn.mock.calls[0][1].method).toBe("POST");
    expect(fn.mock.calls[0][1].body).toBe('{"message":"hello"}');
  });
});

describe("apiPatch", () => {
  it("sends PATCH with JSON body", async () => {
    const fn = mockFetch({ ok: true, body: { data: { ok: true } } });
    await apiPatch("/api/settings", { key: "value" });
    expect(fn.mock.calls[0][1].method).toBe("PATCH");
  });
});

describe("apiDelete", () => {
  it("sends DELETE with optional body", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiDelete("/api/sessions/123", { reason: "cleanup" });
    expect(fn.mock.calls[0][1].method).toBe("DELETE");
    expect(fn.mock.calls[0][1].body).toBe('{"reason":"cleanup"}');
  });

  it("sends DELETE without body when none provided", async () => {
    const fn = mockFetch({ ok: true, body: { data: {} } });
    await apiDelete("/api/sessions/123");
    expect(fn.mock.calls[0][1].method).toBe("DELETE");
    expect(fn.mock.calls[0][1].body).toBeUndefined();
  });
});
