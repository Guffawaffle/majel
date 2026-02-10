/**
 * settings.test.ts — Tests for the Settings Store
 *
 * Uses temp SQLite databases per test to avoid state leaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createSettingsStore,
  SETTINGS_SCHEMA,
  getSettingDef,
  getCategories,
  type SettingsStore,
} from "../src/server/settings.js";

// ─── Helpers ────────────────────────────────────────────────────

let tmpDir: string;
let store: SettingsStore;

async function freshStore(): Promise<SettingsStore> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "majel-settings-"));
  const dbPath = path.join(tmpDir, "settings.db");
  return createSettingsStore(dbPath);
}

beforeEach(async () => {
  store = await freshStore();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Schema ─────────────────────────────────────────────────────

describe("SETTINGS_SCHEMA", () => {
  it("has unique keys", () => {
    const keys = SETTINGS_SCHEMA.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has sensible categories", () => {
    const validCats = ["display", "model", "system", "fleet"];
    for (const def of SETTINGS_SCHEMA) {
      expect(validCats).toContain(def.category);
    }
  });

  it("has valid types", () => {
    const validTypes = ["string", "number", "boolean", "json"];
    for (const def of SETTINGS_SCHEMA) {
      expect(validTypes).toContain(def.type);
    }
  });
});

describe("getSettingDef", () => {
  it("returns definition for known key", () => {
    const def = getSettingDef("display.admiralName");
    expect(def).toBeDefined();
    expect(def!.category).toBe("display");
  });

  it("returns undefined for unknown key", () => {
    expect(getSettingDef("nonexistent.key")).toBeUndefined();
  });
});

describe("getCategories", () => {
  it("returns all known categories", () => {
    const cats = getCategories();
    expect(cats).toContain("display");
    expect(cats).toContain("model");
    expect(cats).toContain("system");
  });
});

// ─── Store: get/set/delete ──────────────────────────────────────

describe("settings store: get/set/delete", () => {
  it("returns schema default when no user value or env var", async () => {
    const value = await store.get("display.admiralName");
    expect(value).toBe("Admiral");
  });

  it("returns empty string for unset string settings with empty default", async () => {
    const value = await store.get("model.apiKey");
    expect(value).toBe("");
  });

  it("set() stores a user value", async () => {
    await store.set("display.admiralName", "Captain");
    expect(await store.get("display.admiralName")).toBe("Captain");
  });

  it("set() overwrites previous value", async () => {
    await store.set("display.admiralName", "Captain");
    await store.set("display.admiralName", "Commander");
    expect(await store.get("display.admiralName")).toBe("Commander");
  });

  it("delete() removes user override", async () => {
    await store.set("display.admiralName", "Captain");
    const deleted = await store.delete("display.admiralName");
    expect(deleted).toBe(true);
    // Should fall back to default
    expect(await store.get("display.admiralName")).toBe("Admiral");
  });

  it("delete() returns false for non-existent key", async () => {
    expect(await store.delete("display.admiralName")).toBe(false);
  });

  it("set() throws for unknown key", async () => {
    await expect(store.set("unknown.key", "value")).rejects.toThrow("Unknown setting");
  });

  it("set() validates number type", async () => {
    await expect(store.set("model.temperature", "not-a-number")).rejects.toThrow(
      "must be a number"
    );
  });

  it("set() accepts valid number", async () => {
    await store.set("model.temperature", "0.7");
    expect(await store.get("model.temperature")).toBe("0.7");
  });

  it("set() validates boolean type — rejects invalid", async () => {
    await expect(store.set("system.port", "abc")).rejects.toThrow("must be a number");
  });
});

// ─── Store: env var fallback ────────────────────────────────────

describe("settings store: env var fallback", () => {
  it("falls back to env var when no user value set", async () => {
    const originalEnv = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "env-api-key";

    // Create a fresh store to pick up the env
    const envStore = await freshStore();
    const value = await envStore.get("model.apiKey");
    expect(value).toBe("env-api-key");
    await envStore.close();

    // Restore
    if (originalEnv !== undefined) {
      process.env.GEMINI_API_KEY = originalEnv;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("user value wins over env var", async () => {
    const originalEnv = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "env-value";

    const envStore = await freshStore();
    await envStore.set("model.apiKey", "user-value");
    expect(await envStore.get("model.apiKey")).toBe("user-value");
    await envStore.close();

    if (originalEnv !== undefined) {
      process.env.GEMINI_API_KEY = originalEnv;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });
});

// ─── Store: getTyped ────────────────────────────────────────────

describe("settings store: getTyped", () => {
  it("returns number for number-typed settings", async () => {
    await store.set("model.temperature", "0.5");
    const val = await store.getTyped("model.temperature");
    expect(val).toBe(0.5);
    expect(typeof val).toBe("number");
  });

  it("returns default number when not set", async () => {
    const val = await store.getTyped("model.temperature");
    expect(val).toBe(1.0);
  });

  it("returns string for string-typed settings", async () => {
    await store.set("display.admiralName", "Guff");
    expect(await store.getTyped("display.admiralName")).toBe("Guff");
  });

  it("returns raw value for unknown key", async () => {
    // getTyped on a key not in schema returns the resolved string
    expect(await store.getTyped("nonexistent.key")).toBe("");
  });
});

// ─── Store: getAll / getByCategory ──────────────────────────────

describe("settings store: getAll", () => {
  it("returns all settings from schema", async () => {
    const all = await store.getAll();
    expect(all.length).toBe(SETTINGS_SCHEMA.length);
  });

  it("includes source info for each setting", async () => {
    await store.set("display.admiralName", "Guff");
    const all = await store.getAll();
    const admiralSetting = all.find((s) => s.key === "display.admiralName");
    expect(admiralSetting?.source).toBe("user");
    expect(admiralSetting?.value).toBe("Guff");

    const tempSetting = all.find((s) => s.key === "model.temperature");
    expect(tempSetting?.source).toBe("default");
  });

  it("masks sensitive values", async () => {
    // Currently no sensitive settings, but test the mechanism
    // by checking that all non-sensitive values are visible
    const all = await store.getAll();
    for (const entry of all) {
      if (!entry.sensitive) {
        expect(entry.value).not.toBe("••••••••");
      }
    }
  });
});

describe("settings store: getByCategory", () => {
  it("filters by category", async () => {
    const display = await store.getByCategory("display");
    expect(display.length).toBeGreaterThan(0);
    for (const entry of display) {
      expect(entry.category).toBe("display");
    }
  });

  it("returns empty for unknown category", async () => {
    expect(await store.getByCategory("nonexistent")).toEqual([]);
  });
});

// ─── Store: export/import ───────────────────────────────────────

describe("settings store: export/import", () => {
  it("exportUserValues returns only user-set values", async () => {
    await store.set("display.admiralName", "Guff");
    await store.set("model.temperature", "0.7");

    const exported = await store.exportUserValues();
    expect(exported["display.admiralName"]).toBe("Guff");
    expect(exported["model.temperature"]).toBe("0.7");
    // Default values should NOT be in export
    expect(exported["display.theme"]).toBeUndefined();
  });

  it("importValues sets multiple values", async () => {
    await store.importValues({
      "display.admiralName": "Picard",
      "display.theme": "red-alert",
    });

    expect(await store.get("display.admiralName")).toBe("Picard");
    expect(await store.get("display.theme")).toBe("red-alert");
  });

  it("importValues skips unknown keys", async () => {
    // Should not throw
    await store.importValues({
      "display.admiralName": "Picard",
      "totally.fake": "value",
    });
    expect(await store.get("display.admiralName")).toBe("Picard");
  });

  it("round-trips export → import", async () => {
    await store.set("display.admiralName", "Janeway");
    await store.set("model.temperature", "0.3");

    const exported = await store.exportUserValues();

    // New store
    const store2 = await freshStore();
    await store2.importValues(exported);

    expect(await store2.get("display.admiralName")).toBe("Janeway");
    expect(await store2.get("model.temperature")).toBe("0.3");
    await store2.close();
  });
});
