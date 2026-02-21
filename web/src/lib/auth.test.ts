/**
 * auth.test.ts — Tests for auth store logic.
 *
 * Validates role hierarchy checks, fetchMe() behavior on
 * 401/error, and logout redirect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { User, Role } from "./types.js";

// We need to mock the API layer *before* importing auth.svelte.ts
// because auth imports from api/auth.ts at module level.
vi.mock("./api/auth.js", () => ({
  getMe: vi.fn(),
  postLogout: vi.fn(),
}));

vi.mock("./api/fetch.js", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

vi.mock("./cache/cache-store.svelte.js", () => ({
  clearCacheOnLogout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./cache/sync-queue.svelte.js", () => ({
  clearQueue: vi.fn(),
}));

import { getUser, isLoading, getError, hasRole, fetchMe, logout } from "./auth.svelte.js";
import { getMe, postLogout } from "./api/auth.js";
import { ApiError } from "./api/fetch.js";

const mockGetMe = vi.mocked(getMe);
const mockPostLogout = vi.mocked(postLogout);

// ─── Setup ──────────────────────────────────────────────────

const testUser: User = {
  id: "u1",
  email: "picard@enterprise.fed",
  displayName: "Jean-Luc Picard",
  role: "captain",
};

let locationHref = "";

beforeEach(() => {
  vi.restoreAllMocks();
  // Mock window.location.href (happy-dom)
  locationHref = "";
  Object.defineProperty(window, "location", {
    value: { ...window.location, href: "", hash: "" },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window.location, "href", {
    get: () => locationHref,
    set: (v: string) => { locationHref = v; },
    configurable: true,
  });
});

// ─── fetchMe ────────────────────────────────────────────────

describe("fetchMe", () => {
  it("sets user on successful API call", async () => {
    mockGetMe.mockResolvedValue(testUser);
    await fetchMe();
    expect(getUser()).toEqual(testUser);
    expect(isLoading()).toBe(false);
    expect(getError()).toBeNull();
  });

  it("redirects to /login when getMe returns null", async () => {
    mockGetMe.mockResolvedValue(null);
    await fetchMe();
    expect(getUser()).toBeNull();
    expect(locationHref).toBe("/login");
  });

  it("redirects to /login on 401 ApiError", async () => {
    mockGetMe.mockRejectedValue(new ApiError(401, "Unauthorized"));
    await fetchMe();
    expect(getUser()).toBeNull();
    expect(locationHref).toBe("/login");
  });

  it("sets error message on non-401 ApiError", async () => {
    mockGetMe.mockRejectedValue(new ApiError(500, "Server error — please try again"));
    await fetchMe();
    expect(getUser()).toBeNull();
    expect(getError()).toBe("Server error — please try again");
  });

  it("sets generic network error for non-ApiError failures", async () => {
    mockGetMe.mockRejectedValue(new Error("fetch failed"));
    await fetchMe();
    expect(getUser()).toBeNull();
    expect(getError()).toBe("Network error — is the Express server running?");
  });

  it("sets loading=false after completion", async () => {
    mockGetMe.mockResolvedValue(testUser);
    await fetchMe();
    expect(isLoading()).toBe(false);
  });
});

// ─── hasRole ────────────────────────────────────────────────

describe("hasRole", () => {
  beforeEach(async () => {
    // Set user to captain
    mockGetMe.mockResolvedValue(testUser);
    await fetchMe();
  });

  it("captain has ensign role (lower)", () => {
    expect(hasRole("ensign")).toBe(true);
  });

  it("captain has lieutenant role (lower)", () => {
    expect(hasRole("lieutenant")).toBe(true);
  });

  it("captain has captain role (equal)", () => {
    expect(hasRole("captain")).toBe(true);
  });

  it("captain does NOT have admiral role (higher)", () => {
    expect(hasRole("admiral")).toBe(false);
  });
});

describe("hasRole — no user", () => {
  it("returns false when no user is logged in", async () => {
    mockGetMe.mockRejectedValue(new ApiError(401, "Unauthorized"));
    await fetchMe();
    expect(hasRole("ensign")).toBe(false);
  });
});

// ─── logout ─────────────────────────────────────────────────

describe("logout", () => {
  it("calls postLogout API", async () => {
    mockPostLogout.mockResolvedValue(undefined);
    await logout();
    expect(mockPostLogout).toHaveBeenCalled();
  });

  it("redirects to / after logout", async () => {
    mockPostLogout.mockResolvedValue(undefined);
    await logout();
    expect(locationHref).toBe("/");
  });

  it("clears user state", async () => {
    // First log in
    mockGetMe.mockResolvedValue(testUser);
    await fetchMe();
    expect(getUser()).toEqual(testUser);

    // Then log out
    mockPostLogout.mockResolvedValue(undefined);
    await logout();
    expect(getUser()).toBeNull();
  });

  it("redirects even if postLogout throws", async () => {
    mockPostLogout.mockRejectedValue(new Error("network failure"));
    // try/finally re-throws, but the finally block still sets user=null and redirects
    await expect(logout()).rejects.toThrow("network failure");
    expect(locationHref).toBe("/");
    expect(getUser()).toBeNull();
  });
});
