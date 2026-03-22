/**
 * runtime-profile.test.ts — Tests for runtime profile model (ADR-050)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveProfile,
  resolveProviderMode,
  getProfileContract,
  validateProfile,
  printBootBanner,
  PROFILE_CONTRACTS,
  type ProfileContract,
} from "../src/server/runtime-profile.js";

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
});

// ─── Profile Resolution ─────────────────────────────────────────

describe("resolveProfile", () => {
  it("returns 'test' when VITEST=true (default test env)", () => {
    expect(resolveProfile()).toBe("test");
  });

  it("returns explicit MAJEL_PROFILE when set", () => {
    process.env.MAJEL_PROFILE = "dev_local";
    delete process.env.VITEST;
    expect(resolveProfile()).toBe("dev_local");
  });

  it("returns explicit MAJEL_PROFILE=cloud_prod", () => {
    process.env.MAJEL_PROFILE = "cloud_prod";
    expect(resolveProfile()).toBe("cloud_prod");
  });

  it("returns explicit MAJEL_PROFILE=test", () => {
    process.env.MAJEL_PROFILE = "test";
    expect(resolveProfile()).toBe("test");
  });

  it("ignores invalid MAJEL_PROFILE and infers from env", () => {
    process.env.MAJEL_PROFILE = "invalid_profile";
    // VITEST is still "true" in test runner
    expect(resolveProfile()).toBe("test");
  });

  it("infers test from NODE_ENV=test", () => {
    delete process.env.MAJEL_PROFILE;
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
    expect(resolveProfile()).toBe("test");
  });

  it("infers cloud_prod from NODE_ENV=production", () => {
    delete process.env.MAJEL_PROFILE;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    expect(resolveProfile()).toBe("cloud_prod");
  });

  it("infers dev_local when NODE_ENV=development", () => {
    delete process.env.MAJEL_PROFILE;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    expect(resolveProfile()).toBe("dev_local");
  });

  it("infers dev_local when NODE_ENV is unset", () => {
    delete process.env.MAJEL_PROFILE;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(resolveProfile()).toBe("dev_local");
  });
});

// ─── Provider Mode Resolution ───────────────────────────────────

describe("resolveProviderMode", () => {
  it("returns base mode for cloud_prod (no override)", () => {
    expect(resolveProviderMode("cloud_prod", "real")).toBe("real");
  });

  it("returns base mode for test (no override)", () => {
    expect(resolveProviderMode("test", "off")).toBe("off");
  });

  it("returns base mode for dev_local when no override set", () => {
    delete process.env.MAJEL_DEV_PROVIDER;
    expect(resolveProviderMode("dev_local", "stub")).toBe("stub");
  });

  it("overrides to real in dev_local", () => {
    process.env.MAJEL_DEV_PROVIDER = "real";
    expect(resolveProviderMode("dev_local", "stub")).toBe("real");
  });

  it("overrides to off in dev_local", () => {
    process.env.MAJEL_DEV_PROVIDER = "off";
    expect(resolveProviderMode("dev_local", "stub")).toBe("off");
  });

  it("ignores MAJEL_DEV_PROVIDER for cloud_prod", () => {
    process.env.MAJEL_DEV_PROVIDER = "stub";
    expect(resolveProviderMode("cloud_prod", "real")).toBe("real");
  });

  it("ignores invalid MAJEL_DEV_PROVIDER value", () => {
    process.env.MAJEL_DEV_PROVIDER = "invalid";
    expect(resolveProviderMode("dev_local", "stub")).toBe("stub");
  });
});

// ─── Profile Contracts ──────────────────────────────────────────

describe("PROFILE_CONTRACTS", () => {
  it("has contracts for all three profiles", () => {
    expect(PROFILE_CONTRACTS.dev_local).toBeDefined();
    expect(PROFILE_CONTRACTS.cloud_prod).toBeDefined();
    expect(PROFILE_CONTRACTS.test).toBeDefined();
  });

  it("dev_local: DB required, provider optional, auth disabled", () => {
    const c = PROFILE_CONTRACTS.dev_local;
    expect(c.invariants.requireDatabase).toBe(true);
    expect(c.invariants.requireProvider).toBe(false);
    expect(c.invariants.requireAuth).toBe(false);
    expect(c.capabilities.providerMode).toBe("stub");
    expect(c.capabilities.authEnforced).toBe(false);
    expect(c.capabilities.bootstrapAdmiral).toBe(true);
    expect(c.capabilities.devEndpoints).toBe(true);
    expect(c.capabilities.prettyLogs).toBe(true);
    expect(c.capabilities.gcpLogFormat).toBe(false);
  });

  it("cloud_prod: all required, no dev surfaces", () => {
    const c = PROFILE_CONTRACTS.cloud_prod;
    expect(c.invariants.requireDatabase).toBe(true);
    expect(c.invariants.requireProvider).toBe(true);
    expect(c.invariants.requireAuth).toBe(true);
    expect(c.capabilities.providerMode).toBe("real");
    expect(c.capabilities.authEnforced).toBe(true);
    expect(c.capabilities.bootstrapAdmiral).toBe(false);
    expect(c.capabilities.devEndpoints).toBe(false);
    expect(c.capabilities.gcpLogFormat).toBe(true);
  });

  it("test: nothing required, provider off", () => {
    const c = PROFILE_CONTRACTS.test;
    expect(c.invariants.requireDatabase).toBe(false);
    expect(c.invariants.requireProvider).toBe(false);
    expect(c.invariants.requireAuth).toBe(false);
    expect(c.capabilities.providerMode).toBe("off");
    expect(c.capabilities.authEnforced).toBe(false);
    expect(c.capabilities.devEndpoints).toBe(false);
    expect(c.capabilities.gcpLogFormat).toBe(false);
  });
});

// ─── getProfileContract ─────────────────────────────────────────

describe("getProfileContract", () => {
  it("returns contract with resolved provider mode", () => {
    process.env.MAJEL_DEV_PROVIDER = "real";
    const contract = getProfileContract("dev_local");
    expect(contract.capabilities.providerMode).toBe("real");
  });

  it("does not mutate the base PROFILE_CONTRACTS", () => {
    process.env.MAJEL_DEV_PROVIDER = "real";
    getProfileContract("dev_local");
    expect(PROFILE_CONTRACTS.dev_local.capabilities.providerMode).toBe("stub");
  });

  it("returns base mode when no override for non-dev_local profiles", () => {
    const contract = getProfileContract("cloud_prod");
    expect(contract.capabilities.providerMode).toBe("real");
  });
});

// ─── Validation ─────────────────────────────────────────────────

describe("validateProfile", () => {
  it("passes for test profile with minimal env", () => {
    const contract = PROFILE_CONTRACTS.test;
    expect(() => validateProfile("test", contract, {})).not.toThrow();
  });

  it("passes for dev_local with minimal env", () => {
    const contract = PROFILE_CONTRACTS.dev_local;
    expect(() => validateProfile("dev_local", contract, {})).not.toThrow();
  });

  it("fails for cloud_prod without DATABASE_URL", () => {
    const contract = PROFILE_CONTRACTS.cloud_prod;
    expect(() => validateProfile("cloud_prod", contract, {
      GEMINI_API_KEY: "key",
      MAJEL_ADMIN_TOKEN: "tok",
    })).toThrow("DATABASE_URL must be set");
  });

  it("fails for cloud_prod without GEMINI_API_KEY", () => {
    const contract = PROFILE_CONTRACTS.cloud_prod;
    expect(() => validateProfile("cloud_prod", contract, {
      DATABASE_URL: "postgres://x@localhost/x",
      MAJEL_ADMIN_TOKEN: "tok",
    })).toThrow("GEMINI_API_KEY must be set");
  });

  it("fails for cloud_prod without auth tokens", () => {
    const contract = PROFILE_CONTRACTS.cloud_prod;
    expect(() => validateProfile("cloud_prod", contract, {
      DATABASE_URL: "postgres://x@localhost/x",
      GEMINI_API_KEY: "key",
    })).toThrow("MAJEL_ADMIN_TOKEN or MAJEL_INVITE_SECRET");
  });

  it("passes for cloud_prod with all required env vars", () => {
    const contract = PROFILE_CONTRACTS.cloud_prod;
    expect(() => validateProfile("cloud_prod", contract, {
      DATABASE_URL: "postgres://x@localhost/x",
      GEMINI_API_KEY: "key",
      MAJEL_ADMIN_TOKEN: "tok",
    })).not.toThrow();
  });

  it("fails when dev_local has NODE_ENV=production", () => {
    const contract = PROFILE_CONTRACTS.dev_local;
    expect(() => validateProfile("dev_local", contract, {
      MAJEL_PROFILE: "dev_local",
      NODE_ENV: "production",
    })).toThrow("MAJEL_PROFILE=dev_local conflicts with NODE_ENV=production");
  });

  it("fails when cloud_prod has devEndpoints enabled (should never happen)", () => {
    const tampered: ProfileContract = {
      invariants: { ...PROFILE_CONTRACTS.cloud_prod.invariants },
      capabilities: { ...PROFILE_CONTRACTS.cloud_prod.capabilities, devEndpoints: true },
    };
    expect(() => validateProfile("cloud_prod", tampered, {
      DATABASE_URL: "postgres://x@localhost/x",
      GEMINI_API_KEY: "key",
      MAJEL_ADMIN_TOKEN: "tok",
    })).toThrow("devEndpoints capability is true in cloud_prod");
  });

  it("passes when cloud_prod auth uses MAJEL_INVITE_SECRET instead of token", () => {
    const contract = PROFILE_CONTRACTS.cloud_prod;
    expect(() => validateProfile("cloud_prod", contract, {
      DATABASE_URL: "postgres://x@localhost/x",
      GEMINI_API_KEY: "key",
      MAJEL_INVITE_SECRET: "secret",
    })).not.toThrow();
  });
});

// ─── Boot Banner ────────────────────────────────────────────────

describe("printBootBanner", () => {
  it("prints banner without throwing", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      printBootBanner("dev_local", PROFILE_CONTRACTS.dev_local, "postgres://majel:majel@localhost:5432/majel");
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some(l => l.includes("MAJEL"))).toBe(true);
      expect(logs.some(l => l.includes("dev_local"))).toBe(true);
      expect(logs.some(l => l.includes("stub"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  it("redacts database credentials in banner", () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      printBootBanner("dev_local", PROFILE_CONTRACTS.dev_local, "postgres://user:password@localhost:5432/db");
      const dbLine = logs.find(l => l.includes("Database"));
      expect(dbLine).toBeDefined();
      expect(dbLine).not.toContain("password");
      expect(dbLine).toContain("<redacted>");
    } finally {
      console.log = origLog;
    }
  });
});

// ─── Config Integration ─────────────────────────────────────────

describe("config integration", () => {
  it("bootstrapConfigSync includes profile and contract", async () => {
    const { bootstrapConfigSync } = await import("../src/server/config.js");
    const config = bootstrapConfigSync();
    expect(config.profile).toBe("test"); // Running under vitest
    expect(config.contract).toBeDefined();
    expect(config.contract.invariants).toBeDefined();
    expect(config.contract.capabilities).toBeDefined();
  });

  it("profile-derived isDev/isTest match profile", async () => {
    const { bootstrapConfigSync } = await import("../src/server/config.js");
    const config = bootstrapConfigSync();
    // Under vitest: profile = test → isTest = true, isDev = false
    expect(config.isTest).toBe(true);
    expect(config.isDev).toBe(false);
  });
});
