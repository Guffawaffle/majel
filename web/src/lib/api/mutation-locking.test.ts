import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    runLockedMutationMock: vi.fn(async (opts: { mutate: () => Promise<unknown> }) => opts.mutate()),
    apiFetchMock: vi.fn(),
    apiDeleteMock: vi.fn(),
  };
});

vi.mock("./mutation.js", () => ({
  runLockedMutation: mocks.runLockedMutationMock,
}));

vi.mock("./fetch.js", () => ({
  apiFetch: mocks.apiFetchMock,
  apiDelete: mocks.apiDeleteMock,
  pathEncode: (value: string | number) => encodeURIComponent(String(value)),
  qs: (params: Record<string, string | number | boolean | null | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") s.set(k, String(v));
    }
    const q = s.toString();
    return q ? `?${q}` : "";
  },
}));

import { sendChat } from "./chat.js";
import { deleteSession } from "./sessions.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("API modules use locked mutation route", () => {
  it("sendChat routes through runLockedMutation with per-session lock key", async () => {
    mocks.apiFetchMock.mockResolvedValueOnce({ ok: true });

    await sendChat("session-123", "hello");

    expect(mocks.runLockedMutationMock).toHaveBeenCalledTimes(1);
    expect(mocks.runLockedMutationMock).toHaveBeenCalledWith(expect.objectContaining({
      label: "Send chat message",
      lockKey: "chat:session-123",
      mutate: expect.any(Function),
    }));
    expect(mocks.apiFetchMock).toHaveBeenCalledWith("/api/chat", expect.objectContaining({
      method: "POST",
      headers: { "X-Session-Id": "session-123" },
    }));
  });

  it("deleteSession routes through runLockedMutation with per-session lock key", async () => {
    mocks.apiDeleteMock.mockResolvedValueOnce(undefined);

    const ok = await deleteSession("abc");

    expect(ok).toBe(true);
    expect(mocks.runLockedMutationMock).toHaveBeenCalledTimes(1);
    expect(mocks.runLockedMutationMock).toHaveBeenCalledWith(expect.objectContaining({
      label: "Delete session abc",
      lockKey: "session:abc",
      mutate: expect.any(Function),
    }));
    expect(mocks.apiDeleteMock).toHaveBeenCalledWith("/api/sessions/abc");
  });
});
