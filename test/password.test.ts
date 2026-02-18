/**
 * password.test.ts — Password Hashing & Validation Tests (ADR-019)
 */

import { describe, it, expect } from "vitest";
import {
  validatePassword,
  hashPassword,
  verifyPassword,
  timingSafeCompare,
} from "../src/server/services/password.js";

describe("validatePassword", () => {
  it("rejects non-string input", () => {
    const result = validatePassword(123 as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("string");
  });

  it("rejects password shorter than 15 chars", () => {
    const result = validatePassword("short");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("at least 15");
  });

  it("rejects password longer than 128 chars", () => {
    const result = validatePassword("a".repeat(129));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("at most 128");
  });

  it("accepts a valid 15-char password", () => {
    expect(validatePassword("a".repeat(15)).valid).toBe(true);
  });

  it("accepts a valid 128-char password", () => {
    expect(validatePassword("a".repeat(128)).valid).toBe(true);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("hashes and verifies a correct password", async () => {
    const pw = "my-secure-password-123";
    const hash = await hashPassword(pw);
    expect(typeof hash).toBe("string");
    expect(hash).toContain("argon2id");
    expect(await verifyPassword(pw, hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-password!!");
    expect(await verifyPassword("wrong-password!!", hash)).toBe(false);
  });

  it("returns false for invalid hash format", async () => {
    expect(await verifyPassword("anything-at-all!", "not-a-valid-hash")).toBe(false);
  });
});

describe("timingSafeCompare", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeCompare("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeCompare("hello", "world")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeCompare("short", "longer-string")).toBe(false);
  });
});
