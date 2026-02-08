/**
 * config.test.ts — Tests for unified configuration resolution (ADR-005 Phase 3)
 *
 * Tests the priority chain: user override → env var → default
 * Tests runtime re-resolution after settings changes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveConfig, bootstrapConfig } from "../src/server/config.js";
import { createSettingsStore, type SettingsStore } from "../src/server/settings.js";

// ─── Helpers ────────────────────────────────────────────────────

let tmpDir: string;
let store: SettingsStore;
let originalEnv: NodeJS.ProcessEnv;

function freshStore(): SettingsStore {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-config-test-"));
  const dbPath = path.join(tmpDir, "settings.db");
  return createSettingsStore(dbPath);
}

beforeEach(() => {
  // Save original env
  originalEnv = { ...process.env };
  store = freshStore();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore env
  process.env = originalEnv;
});

// ─── Bootstrap Config ───────────────────────────────────────────

describe("bootstrapConfig", () => {
  it("returns config without settings store", () => {
    const config = bootstrapConfig();
    expect(config).toBeDefined();
    expect(config.port).toBe(3000); // default
    expect(config.nodeEnv).toBeDefined();
    expect(config.isTest).toBe(true); // Running in vitest
  });

  it("reads env vars when settings store not available", () => {
    process.env.MAJEL_PORT = "8080";
    process.env.GEMINI_API_KEY = "test-api-key-from-env";
    
    const config = bootstrapConfig();
    expect(config.port).toBe(8080);
    expect(config.geminiApiKey).toBe("test-api-key-from-env");
  });
});

// ─── Resolution Priority Chain ──────────────────────────────────

describe("resolveConfig: priority chain", () => {
  it("uses default when no settings and no env", () => {
    delete process.env.MAJEL_PORT;
    delete process.env.PORT;
    
    const config = resolveConfig(store);
    expect(config.port).toBe(3000); // default from schema
  });

  it("prefers env var over default", () => {
    process.env.MAJEL_PORT = "5000";
    
    const config = resolveConfig(store);
    expect(config.port).toBe(5000);
  });

  it("prefers user setting over env var", () => {
    process.env.MAJEL_PORT = "5000";
    store.set("system.port", "9000");
    
    const config = resolveConfig(store);
    expect(config.port).toBe(9000); // user setting wins
  });

  it("resolves GEMINI_API_KEY from env", () => {
    process.env.GEMINI_API_KEY = "sk-test-key-123";
    
    const config = resolveConfig(store);
    expect(config.geminiApiKey).toBe("sk-test-key-123");
  });

  it("resolves GEMINI_API_KEY from user setting", () => {
    process.env.GEMINI_API_KEY = "env-key";
    store.set("model.apiKey", "user-key");
    
    const config = resolveConfig(store);
    expect(config.geminiApiKey).toBe("user-key"); // user setting wins
  });

  it("resolves spreadsheetId from env", () => {
    process.env.MAJEL_SPREADSHEET_ID = "spreadsheet-123";
    
    const config = resolveConfig(store);
    expect(config.spreadsheetId).toBe("spreadsheet-123");
  });

  it("resolves spreadsheetId from user setting", () => {
    process.env.MAJEL_SPREADSHEET_ID = "env-sheet";
    store.set("sheets.spreadsheetId", "user-sheet");
    
    const config = resolveConfig(store);
    expect(config.spreadsheetId).toBe("user-sheet");
  });

  it("resolves tabMapping from env", () => {
    process.env.MAJEL_TAB_MAPPING = "Officers:officers,Ships:ships";
    
    const config = resolveConfig(store);
    expect(config.tabMapping).toBe("Officers:officers,Ships:ships");
  });

  it("resolves tabMapping from user setting", () => {
    process.env.MAJEL_TAB_MAPPING = "env-mapping";
    store.set("sheets.tabMapping", "user-mapping");
    
    const config = resolveConfig(store);
    expect(config.tabMapping).toBe("user-mapping");
  });

  it("resolves sheetRange from env", () => {
    process.env.MAJEL_SHEET_RANGE = "Sheet1!A1:Z100";
    
    const config = resolveConfig(store);
    expect(config.sheetRange).toBe("Sheet1!A1:Z100");
  });

  it("resolves sheetRange from user setting", () => {
    process.env.MAJEL_SHEET_RANGE = "env-range";
    store.set("sheets.range", "user-range");
    
    const config = resolveConfig(store);
    expect(config.sheetRange).toBe("user-range");
  });
});

// ─── Runtime Re-Resolution ──────────────────────────────────────

describe("resolveConfig: runtime re-resolution", () => {
  it("reflects updated user settings when re-resolved", () => {
    store.set("system.port", "4000");
    const config1 = resolveConfig(store);
    expect(config1.port).toBe(4000);

    // Change setting
    store.set("system.port", "5000");
    const config2 = resolveConfig(store);
    expect(config2.port).toBe(5000);
  });

  it("reflects deleted user settings (falls back to env)", () => {
    process.env.MAJEL_PORT = "6000";
    store.set("system.port", "7000");
    
    const config1 = resolveConfig(store);
    expect(config1.port).toBe(7000);

    // Delete user override
    store.delete("system.port");
    const config2 = resolveConfig(store);
    expect(config2.port).toBe(6000); // falls back to env
  });

  it("reflects deleted user settings (falls back to default)", () => {
    delete process.env.MAJEL_PORT;
    delete process.env.PORT;
    store.set("system.port", "8000");
    
    const config1 = resolveConfig(store);
    expect(config1.port).toBe(8000);

    // Delete user override
    store.delete("system.port");
    const config2 = resolveConfig(store);
    expect(config2.port).toBe(3000); // falls back to default
  });

  it("supports multiple concurrent setting changes", () => {
    store.set("system.port", "4000");
    store.set("model.apiKey", "key-1");
    store.set("sheets.spreadsheetId", "sheet-1");
    
    const config1 = resolveConfig(store);
    expect(config1.port).toBe(4000);
    expect(config1.geminiApiKey).toBe("key-1");
    expect(config1.spreadsheetId).toBe("sheet-1");

    // Update all settings
    store.set("system.port", "5000");
    store.set("model.apiKey", "key-2");
    store.set("sheets.spreadsheetId", "sheet-2");
    
    const config2 = resolveConfig(store);
    expect(config2.port).toBe(5000);
    expect(config2.geminiApiKey).toBe("key-2");
    expect(config2.spreadsheetId).toBe("sheet-2");
  });
});

// ─── Environment Detection ──────────────────────────────────────

describe("resolveConfig: environment detection", () => {
  it("detects test environment", () => {
    process.env.NODE_ENV = "test";
    const config = resolveConfig(store);
    expect(config.nodeEnv).toBe("test");
    expect(config.isTest).toBe(true);
    expect(config.isDev).toBe(false);
  });

  it("detects vitest environment", () => {
    delete process.env.NODE_ENV;
    process.env.VITEST = "true";
    const config = resolveConfig(store);
    expect(config.isTest).toBe(true);
  });

  it("detects production environment", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    const config = resolveConfig(store);
    expect(config.nodeEnv).toBe("production");
    expect(config.isTest).toBe(false);
    expect(config.isDev).toBe(false);
  });

  it("defaults to development when NODE_ENV not set", () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    const config = resolveConfig(store);
    expect(config.nodeEnv).toBe("development");
    expect(config.isTest).toBe(false);
    expect(config.isDev).toBe(true);
  });
});

// ─── Logging Configuration ──────────────────────────────────────

describe("resolveConfig: logging", () => {
  it("uses silent log level in test", () => {
    process.env.NODE_ENV = "test";
    delete process.env.MAJEL_LOG_LEVEL;
    const config = resolveConfig(store);
    expect(config.logLevel).toBe("silent");
  });

  it("uses debug log level in dev", () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_LEVEL;
    const config = resolveConfig(store);
    expect(config.logLevel).toBe("debug");
  });

  it("uses info log level in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.MAJEL_LOG_LEVEL;
    delete process.env.VITEST;
    const config = resolveConfig(store);
    expect(config.logLevel).toBe("info");
  });

  it("respects explicit MAJEL_LOG_LEVEL", () => {
    process.env.MAJEL_LOG_LEVEL = "warn";
    const config = resolveConfig(store);
    expect(config.logLevel).toBe("warn");
  });

  it("enables pretty logs in dev by default", () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.MAJEL_LOG_PRETTY;
    const config = resolveConfig(store);
    expect(config.logPretty).toBe(true);
  });

  it("disables pretty logs in test", () => {
    process.env.NODE_ENV = "test";
    delete process.env.MAJEL_LOG_PRETTY;
    const config = resolveConfig(store);
    expect(config.logPretty).toBe(false);
  });

  it("respects explicit MAJEL_LOG_PRETTY=true in non-test env", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    process.env.MAJEL_LOG_PRETTY = "true";
    const config = resolveConfig(store);
    expect(config.logPretty).toBe(true);
  });

  it("respects explicit MAJEL_LOG_PRETTY=false", () => {
    process.env.MAJEL_LOG_PRETTY = "false";
    const config = resolveConfig(store);
    expect(config.logPretty).toBe(false);
  });
});

// ─── Lex Workspace Root ─────────────────────────────────────────

describe("resolveConfig: lex workspace", () => {
  it("uses LEX_WORKSPACE_ROOT from env when set", () => {
    process.env.LEX_WORKSPACE_ROOT = "/custom/workspace";
    const config = resolveConfig(store);
    expect(config.lexWorkspaceRoot).toBe("/custom/workspace");
  });

  it("falls back to cwd() when LEX_WORKSPACE_ROOT not set", () => {
    delete process.env.LEX_WORKSPACE_ROOT;
    const config = resolveConfig(store);
    expect(config.lexWorkspaceRoot).toBe(process.cwd());
  });
});

// ─── Type Safety ────────────────────────────────────────────────

describe("resolveConfig: type safety", () => {
  it("returns all required config fields", () => {
    const config = resolveConfig(store);
    
    // System
    expect(typeof config.port).toBe("number");
    expect(typeof config.nodeEnv).toBe("string");
    expect(typeof config.isTest).toBe("boolean");
    expect(typeof config.isDev).toBe("boolean");
    
    // Gemini
    expect(typeof config.geminiApiKey).toBe("string");
    
    // Sheets
    expect(typeof config.spreadsheetId).toBe("string");
    expect(typeof config.tabMapping).toBe("string");
    expect(typeof config.sheetRange).toBe("string");
    
    // Lex
    expect(typeof config.lexWorkspaceRoot).toBe("string");
    
    // Logging
    expect(typeof config.logLevel).toBe("string");
    expect(typeof config.logPretty).toBe("boolean");
  });

  it("parses port as number from string setting", () => {
    store.set("system.port", "4567");
    const config = resolveConfig(store);
    expect(config.port).toBe(4567);
    expect(typeof config.port).toBe("number");
  });
});
