/**
 * network-status.test.ts — Unit tests for the online/offline store.
 *
 * ADR-032 Phase 3: Tests reactive online state detection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { getOnline } from "./network-status.svelte.js";

describe("network-status", () => {
  it("returns a boolean", () => {
    expect(typeof getOnline()).toBe("boolean");
  });

  it("defaults to true (navigator.onLine is true in test env)", () => {
    expect(getOnline()).toBe(true);
  });
});
