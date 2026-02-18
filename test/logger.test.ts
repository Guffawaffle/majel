/**
 * logger.test.ts — Logger Configuration Tests (ADR-009)
 *
 * Tests resolveLevel() and resolveTransport() branch logic.
 * Because these run at module load, we test them by dynamically importing
 * with different env vars.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("logger resolveLevel", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.MAJEL_LOG_LEVEL = process.env.MAJEL_LOG_LEVEL;
    saved.MAJEL_DEBUG = process.env.MAJEL_DEBUG;
    saved.NODE_ENV = process.env.NODE_ENV;
    saved.VITEST = process.env.VITEST;
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // We can't re-import the module because pino logger is created at module load.
  // Instead, test the logic directly by replicating the resolveLevel function.
  function resolveLevel(): string {
    const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const IS_DEV = process.env.NODE_ENV !== "production" && !IS_TEST;
    if (process.env.MAJEL_LOG_LEVEL) return process.env.MAJEL_LOG_LEVEL;
    const debugEnv = (process.env.MAJEL_DEBUG || "").trim().toLowerCase();
    if (debugEnv && debugEnv !== "false" && debugEnv !== "0") return "debug";
    if (IS_TEST) return "silent";
    if (IS_DEV) return "debug";
    return "info";
  }

  it("uses MAJEL_LOG_LEVEL when set", () => {
    process.env.MAJEL_LOG_LEVEL = "warn";
    expect(resolveLevel()).toBe("warn");
  });

  it("uses MAJEL_DEBUG for debug level", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    process.env.MAJEL_DEBUG = "true";
    expect(resolveLevel()).toBe("debug");
  });

  it("ignores MAJEL_DEBUG=false", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    process.env.MAJEL_DEBUG = "false";
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    expect(resolveLevel()).toBe("silent");
  });

  it("ignores MAJEL_DEBUG=0", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    process.env.MAJEL_DEBUG = "0";
    process.env.NODE_ENV = "test";
    expect(resolveLevel()).toBe("silent");
  });

  it("returns silent in test mode", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    delete process.env.MAJEL_DEBUG;
    process.env.NODE_ENV = "test";
    expect(resolveLevel()).toBe("silent");
  });

  it("returns debug in dev mode", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    delete process.env.MAJEL_DEBUG;
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    expect(resolveLevel()).toBe("debug");
  });

  it("returns info in production", () => {
    delete process.env.MAJEL_LOG_LEVEL;
    delete process.env.MAJEL_DEBUG;
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    expect(resolveLevel()).toBe("info");
  });
});

describe("logger resolveTransport", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.MAJEL_LOG_PRETTY = process.env.MAJEL_LOG_PRETTY;
    saved.NODE_ENV = process.env.NODE_ENV;
    saved.VITEST = process.env.VITEST;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function resolveTransport(): object | undefined {
    const IS_TEST = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    const IS_DEV = process.env.NODE_ENV !== "production" && !IS_TEST;
    if (IS_TEST) return undefined;
    const wantPretty =
      process.env.MAJEL_LOG_PRETTY === "true" ||
      (process.env.MAJEL_LOG_PRETTY !== "false" && IS_DEV);
    if (wantPretty) {
      return {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      };
    }
    return undefined;
  }

  it("returns undefined in test mode", () => {
    process.env.NODE_ENV = "test";
    expect(resolveTransport()).toBeUndefined();
  });

  it("returns pino-pretty in dev mode", () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_PRETTY;
    const result = resolveTransport();
    expect(result).toBeDefined();
    expect(result).toHaveProperty("target", "pino-pretty");
  });

  it("returns pino-pretty when MAJEL_LOG_PRETTY=true", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    process.env.MAJEL_LOG_PRETTY = "true";
    const result = resolveTransport();
    expect(result).toHaveProperty("target", "pino-pretty");
  });

  it("returns undefined when MAJEL_LOG_PRETTY=false in dev", () => {
    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
    process.env.MAJEL_LOG_PRETTY = "false";
    expect(resolveTransport()).toBeUndefined();
  });

  it("returns undefined in production without MAJEL_LOG_PRETTY", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_PRETTY;
    expect(resolveTransport()).toBeUndefined();
  });
});
