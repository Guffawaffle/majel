/**
 * config.test.ts — Tests for unified configuration resolution (ADR-005 Phase 3)
 *
 * Tests the priority chain: user override → env var → default
 * Tests runtime re-resolution after settings changes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import { resolveConfig, bootstrapConfigSync } from "../src/server/config.js";
import { createSettingsStore, type SettingsStore } from "../src/server/settings.js";
import { createTestPool, cleanDatabase, type Pool } from "./helpers/pg-test.js";

// ─── Helpers ────────────────────────────────────────────────────

let pool: Pool;
let store: SettingsStore;
let originalEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Save original env
  originalEnv = { ...process.env };
  await cleanDatabase(pool);
  store = await createSettingsStore(pool);
});

afterEach(async () => {
  // Restore env
  process.env = originalEnv;
});

// ─── Bootstrap Config ───────────────────────────────────────────

describe("bootstrapConfigSync", () => {
  it("returns config without settings store", () => {
    const config = bootstrapConfigSync();
    expect(config).toBeDefined();
    expect(config.port).toBe(3000); // default
    expect(config.nodeEnv).toBeDefined();
    expect(config.isTest).toBe(true); // Running in vitest
  });

  it("reads env vars when settings store not available", () => {
    process.env.MAJEL_PORT = "8080";
    process.env.GEMINI_API_KEY = "test-api-key-from-env";
    
    const config = bootstrapConfigSync();
    expect(config.port).toBe(8080);
    expect(config.geminiApiKey).toBe("test-api-key-from-env");
  });
});

// ─── Resolution Priority Chain ──────────────────────────────────

describe("resolveConfig: priority chain", () => {
  it("uses default when no settings and no env", async () => {
    delete process.env.MAJEL_PORT;
    delete process.env.PORT;
    
    const config = await resolveConfig(store);
    expect(config.port).toBe(3000); // default from schema
  });

  it("prefers env var over default", async () => {
    process.env.MAJEL_PORT = "5000";
    
    const config = await resolveConfig(store);
    expect(config.port).toBe(5000);
  });

  it("prefers user setting over env var", async () => {
    process.env.MAJEL_PORT = "5000";
    await store.set("system.port", "9000");
    
    const config = await resolveConfig(store);
    expect(config.port).toBe(9000); // user setting wins
  });

  it("resolves GEMINI_API_KEY from env", async () => {
    process.env.GEMINI_API_KEY = "sk-test-key-123";
    
    const config = await resolveConfig(store);
    expect(config.geminiApiKey).toBe("sk-test-key-123");
  });

  it("resolves GEMINI_API_KEY from user setting", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    await store.set("model.apiKey", "user-key");
    
    const config = await resolveConfig(store);
    expect(config.geminiApiKey).toBe("user-key"); // user setting wins
  });
});

// ─── Runtime Re-Resolution ──────────────────────────────────────

describe("resolveConfig: runtime re-resolution", () => {
  it("reflects updated user settings when re-resolved", async () => {
    await store.set("system.port", "4000");
    const config1 = await resolveConfig(store);
    expect(config1.port).toBe(4000);

    // Change setting
    await store.set("system.port", "5000");
    const config2 = await resolveConfig(store);
    expect(config2.port).toBe(5000);
  });

  it("reflects deleted user settings (falls back to env)", async () => {
    process.env.MAJEL_PORT = "6000";
    await store.set("system.port", "7000");
    
    const config1 = await resolveConfig(store);
    expect(config1.port).toBe(7000);

    // Delete user override
    await store.delete("system.port");
    const config2 = await resolveConfig(store);
    expect(config2.port).toBe(6000); // falls back to env
  });

  it("reflects deleted user settings (falls back to default)", async () => {
    delete process.env.MAJEL_PORT;
    delete process.env.PORT;
    await store.set("system.port", "8000");
    
    const config1 = await resolveConfig(store);
    expect(config1.port).toBe(8000);

    // Delete user override
    await store.delete("system.port");
    const config2 = await resolveConfig(store);
    expect(config2.port).toBe(3000); // falls back to default
  });

  it("supports multiple concurrent setting changes", async () => {
    await store.set("system.port", "4000");
    await store.set("model.apiKey", "key-1");
    
    const config1 = await resolveConfig(store);
    expect(config1.port).toBe(4000);
    expect(config1.geminiApiKey).toBe("key-1");

    // Update all settings
    await store.set("system.port", "5000");
    await store.set("model.apiKey", "key-2");
    
    const config2 = await resolveConfig(store);
    expect(config2.port).toBe(5000);
    expect(config2.geminiApiKey).toBe("key-2");
  });
});

// ─── Environment Detection ──────────────────────────────────────

describe("resolveConfig: environment detection", () => {
  it("detects test environment", async () => {
    process.env.NODE_ENV = "test";
    const config = await resolveConfig(store);
    expect(config.nodeEnv).toBe("test");
    expect(config.isTest).toBe(true);
    expect(config.isDev).toBe(false);
  });

  it("detects vitest environment", async () => {
    delete process.env.NODE_ENV;
    process.env.VITEST = "true";
    const config = await resolveConfig(store);
    expect(config.isTest).toBe(true);
  });

  it("detects production environment", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    const config = await resolveConfig(store);
    expect(config.nodeEnv).toBe("production");
    expect(config.isTest).toBe(false);
    expect(config.isDev).toBe(false);
  });

  it("defaults to development when NODE_ENV not set", async () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    const config = await resolveConfig(store);
    expect(config.nodeEnv).toBe("development");
    expect(config.isTest).toBe(false);
    expect(config.isDev).toBe(true);
  });
});

// ─── Logging Configuration ──────────────────────────────────────

describe("resolveConfig: logging", () => {
  it("uses silent log level in test", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.MAJEL_LOG_LEVEL;
    const config = await resolveConfig(store);
    expect(config.logLevel).toBe("silent");
  });

  it("uses debug log level in dev", async () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_LEVEL;
    const config = await resolveConfig(store);
    expect(config.logLevel).toBe("debug");
  });

  it("uses info log level in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.MAJEL_LOG_LEVEL;
    delete process.env.VITEST;
    const config = await resolveConfig(store);
    expect(config.logLevel).toBe("info");
  });

  it("respects explicit MAJEL_LOG_LEVEL", async () => {
    process.env.MAJEL_LOG_LEVEL = "warn";
    const config = await resolveConfig(store);
    expect(config.logLevel).toBe("warn");
  });

  it("enables pretty logs in dev by default", async () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_PRETTY;
    const config = await resolveConfig(store);
    expect(config.logPretty).toBe(true);
  });

  it("disables pretty logs in test", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.MAJEL_LOG_PRETTY;
    const config = await resolveConfig(store);
    expect(config.logPretty).toBe(false);
  });

  it("respects explicit MAJEL_LOG_PRETTY=true in non-test env", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    process.env.MAJEL_LOG_PRETTY = "true";
    const config = await resolveConfig(store);
    expect(config.logPretty).toBe(true);
  });

  it("respects explicit MAJEL_LOG_PRETTY=false", async () => {
    process.env.MAJEL_LOG_PRETTY = "false";
    const config = await resolveConfig(store);
    expect(config.logPretty).toBe(false);
  });
});

// ─── Lex Workspace Root ─────────────────────────────────────────

describe("resolveConfig: lex workspace", () => {
  it("uses LEX_WORKSPACE_ROOT from env when set", async () => {
    process.env.LEX_WORKSPACE_ROOT = "/custom/workspace";
    const config = await resolveConfig(store);
    expect(config.lexWorkspaceRoot).toBe("/custom/workspace");
  });

  it("falls back to cwd() when LEX_WORKSPACE_ROOT not set", async () => {
    delete process.env.LEX_WORKSPACE_ROOT;
    const config = await resolveConfig(store);
    expect(config.lexWorkspaceRoot).toBe(process.cwd());
  });
});

// ─── Type Safety ────────────────────────────────────────────────

describe("resolveConfig: type safety", () => {
  it("returns all required config fields", async () => {
    const config = await resolveConfig(store);
    
    // System
    expect(typeof config.port).toBe("number");
    expect(typeof config.nodeEnv).toBe("string");
    expect(typeof config.isTest).toBe("boolean");
    expect(typeof config.isDev).toBe("boolean");
    
    // Gemini
    expect(typeof config.geminiApiKey).toBe("string");
    
    // Lex
    expect(typeof config.lexWorkspaceRoot).toBe("string");
    
    // Logging
    expect(typeof config.logLevel).toBe("string");
    expect(typeof config.logPretty).toBe("boolean");
  });

  it("parses port as number from string setting", async () => {
    await store.set("system.port", "4567");
    const config = await resolveConfig(store);
    expect(config.port).toBe(4567);
    expect(typeof config.port).toBe("number");
  });
});

// ─── No process.env Outside Config ─────────────────────────────

describe("config isolation", () => {
  it("no process.env reads outside config.ts and allowed files", async () => {
    // This test uses grep to verify no unauthorized process.env usage
    const { execSync } = await import("node:child_process");
    
    try {
      // Search for process.env in src/ excluding allowed files
      // Allowed: config.ts, logger.ts (bootstrap), gemini.ts (test detection), 
      //          settings.ts (internal resolution), memory.ts (Lex API contract),
      //          db.ts (DATABASE_URL fallback), rate-limit.ts (test skip),
      //          email.ts (production detection + BASE_URL),
      //          routes/auth.ts (dev-verify guard)
      const result = execSync(
        'grep -rn "process\\.env" --include="*.ts" src/ | ' +
        'grep -v "src/server/config.ts" | ' +
        'grep -v "src/server/logger.ts" | ' +
        'grep -v "src/server/gemini.ts" | ' +
        'grep -v "src/server/settings.ts" | ' +
        'grep -v "src/server/memory.ts" | ' +
        'grep -v "src/server/db.ts" | ' +
        'grep -v "src/server/rate-limit.ts" | ' +
        'grep -v "src/server/email.ts" | ' +
        'grep -v "src/server/routes/auth.ts"',
        { encoding: 'utf-8', cwd: path.resolve(__dirname, '..') }
      );
      
      // If grep found matches, fail the test
      expect.fail(`Found unauthorized process.env usage:\n${result}`);
    } catch (err: any) {
      // grep exits with code 1 when no matches found - this is what we want
      if (err.status === 1) {
        expect(true).toBe(true); // Pass - no unauthorized usage
      } else {
        throw err; // Actual error
      }
    }
  });
});
