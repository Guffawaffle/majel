/**
 * router.test.ts — Tests for hash-based router logic.
 *
 * Verifies view registry, redirect aliases, getViewDef(),
 * navigate(), and getCurrentView().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { views, getViewDef, navigate, getCurrentView, getCurrentViewDef } from "./router.svelte.js";

// ─── View Registry ──────────────────────────────────────────

describe("views registry", () => {
  it("registers 8 views", () => {
    expect(views).toHaveLength(8);
  });

  it("has chat as the first view", () => {
    expect(views[0].name).toBe("chat");
  });

  it("each view has required fields", () => {
    for (const v of views) {
      expect(v.name).toBeTruthy();
      expect(v.icon).toBeTruthy();
      expect(v.title).toBeTruthy();
      expect(v.subtitle).toBeTruthy();
    }
  });

  it("admiral and diagnostics views are gated", () => {
    const gated = views.filter((v) => v.gate);
    expect(gated).toHaveLength(2);
    expect(gated.map((v) => v.name)).toContain("admiral");
    expect(gated.map((v) => v.name)).toContain("diagnostics");
  });

  it("only admiral views are gated (no other gate values)", () => {
    for (const v of views) {
      if (v.gate) expect(v.gate).toBe("admiral");
    }
  });
});

// ─── getViewDef ─────────────────────────────────────────────

describe("getViewDef", () => {
  it("returns ViewDef for known view", () => {
    const def = getViewDef("chat");
    expect(def).toBeDefined();
    expect(def!.name).toBe("chat");
    expect(def!.title).toBe("Chat");
  });

  it("returns undefined for unknown view", () => {
    expect(getViewDef("nonexistent")).toBeUndefined();
  });

  it("returns fleet view", () => {
    expect(getViewDef("fleet")?.title).toBe("Fleet");
  });

  it("returns crews view (workshop)", () => {
    expect(getViewDef("crews")?.title).toBe("Workshop");
  });
});

// ─── navigate + getCurrentView ──────────────────────────────

describe("navigate", () => {
  beforeEach(() => {
    // Reset to default view
    navigate("chat");
  });

  it("changes currentView to the requested view", () => {
    navigate("fleet");
    expect(getCurrentView()).toBe("fleet");
  });

  it("updates the hash", () => {
    navigate("catalog");
    expect(window.location.hash).toBe("#/catalog");
  });

  it("resolves redirect: admin → admiral", () => {
    navigate("admin");
    expect(getCurrentView()).toBe("admiral");
  });

  it("resolves redirect: drydock → crews", () => {
    navigate("drydock");
    expect(getCurrentView()).toBe("crews");
  });

  it("resolves redirect: crew-builder → crews", () => {
    navigate("crew-builder");
    expect(getCurrentView()).toBe("crews");
  });

  it("resolves redirect: fleet-ops → plan", () => {
    navigate("fleet-ops");
    expect(getCurrentView()).toBe("plan");
  });

  it("ignores unknown view names", () => {
    navigate("chat");
    navigate("doesnotexist");
    expect(getCurrentView()).toBe("chat");
  });
});

// ─── getCurrentViewDef ──────────────────────────────────────

describe("getCurrentViewDef", () => {
  it("returns full ViewDef for the current view", () => {
    navigate("diagnostics");
    const def = getCurrentViewDef();
    expect(def.name).toBe("diagnostics");
    expect(def.title).toBe("Diagnostics");
    expect(def.gate).toBe("admiral");
  });

  it("defaults to chat view", () => {
    navigate("chat");
    expect(getCurrentViewDef().name).toBe("chat");
  });
});
