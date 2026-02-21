/**
 * ip-allowlist.test.ts — Unit tests for IP allowlist middleware (W17)
 *
 * Covers: parseAllowedIps validation, middleware allow/block behavior,
 * IPv4-mapped IPv6 handling, and empty-list passthrough.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIpAllowlist, parseAllowedIps } from "../src/server/ip-allowlist.js";

// ─── parseAllowedIps ────────────────────────────────────────────

describe("parseAllowedIps", () => {
  it("accepts valid IPv4 addresses", () => {
    expect(parseAllowedIps(["192.168.1.1", "10.0.0.1", "255.255.255.255"])).toEqual([
      "192.168.1.1", "10.0.0.1", "255.255.255.255",
    ]);
  });

  it("accepts valid IPv6 addresses", () => {
    expect(parseAllowedIps(["::1", "::ffff:192.168.1.1", "fe80::1"])).toEqual([
      "::1", "::ffff:192.168.1.1", "fe80::1",
    ]);
  });

  it("rejects invalid IP addresses", () => {
    expect(parseAllowedIps(["not-an-ip", "999.999.999.999", "abc.def.ghi.jkl"])).toEqual([]);
  });

  it("rejects IPs with octets > 255", () => {
    expect(parseAllowedIps(["192.168.1.256"])).toEqual([]);
  });

  it("skips empty strings and whitespace-only entries", () => {
    expect(parseAllowedIps(["", "  ", "192.168.1.1", ""])).toEqual(["192.168.1.1"]);
  });

  it("trims whitespace from valid entries", () => {
    expect(parseAllowedIps(["  10.0.0.1  "])).toEqual(["10.0.0.1"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseAllowedIps([])).toEqual([]);
  });
});

// ─── createIpAllowlist middleware ────────────────────────────────

describe("createIpAllowlist", () => {
  function mockReq(ip: string, path = "/api/test") {
    return { ip, path } as import("express").Request;
  }

  function mockRes() {
    const res: Record<string, unknown> = {};
    res.locals = { _requestId: "test", _startTime: Date.now() };
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    res.setHeader = vi.fn().mockReturnValue(res);
    return res as unknown as import("express").Response;
  }

  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
  });

  it("passes through when allowlist is empty (dev mode)", () => {
    const mw = createIpAllowlist([]);
    const req = mockReq("1.2.3.4");
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows a request from an allowlisted IP", () => {
    const mw = createIpAllowlist(["10.0.0.1"]);
    const req = mockReq("10.0.0.1");
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks a request from a non-allowlisted IP", () => {
    const mw = createIpAllowlist(["10.0.0.1"]);
    const req = mockReq("10.0.0.2");
    const res = mockRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("handles IPv4-mapped IPv6: allowlist has v4, req.ip is ::ffff:v4", () => {
    const mw = createIpAllowlist(["192.168.1.1"]);
    const req = mockReq("::ffff:192.168.1.1");
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("handles IPv4-mapped IPv6: allowlist has ::ffff:v4, req.ip is plain v4", () => {
    const mw = createIpAllowlist(["::ffff:10.0.0.1"]);
    const req = mockReq("10.0.0.1");
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("rejects invalid IPs in the allowlist gracefully", () => {
    const mw = createIpAllowlist(["not-valid", "10.0.0.1"]);
    const req = mockReq("10.0.0.1");
    const res = mockRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
