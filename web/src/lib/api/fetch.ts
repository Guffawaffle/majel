/**
 * apiFetch — Typed fetch wrapper for the Majel API.
 *
 * - Same-origin credentials on every request
 * - CSRF header: X-Requested-With: majel-client
 * - Content-Type: application/json (default, overridable)
 * - ADR-004 envelope unwrap: { data: T } → T
 * - 5xx sanitization: never exposes server internals
 * - Typed ApiError with status + detail
 *
 * Mirrors the vanilla client's apiFetch from api/_fetch.js.
 */

// ─── Error Type ─────────────────────────────────────────────

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ─── Helpers ────────────────────────────────────────────────

/** Accepted filter value types for query-string construction. */
type QsValue = string | number | boolean | undefined | null;

/** Build a query string from a filter object, omitting undefined/null values. */
export function qs(params: { [key: string]: QsValue }): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, QsValue][]) {
    if (v != null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** URI-encode a path segment. */
export function pathEncode(value: string | number): string {
  return encodeURIComponent(String(value));
}

// ─── Core Fetch ─────────────────────────────────────────────

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Requested-With": "majel-client",
};

/**
 * Typed API fetch. Unwraps the ADR-004 `{ data: T }` envelope.
 *
 * @param path  — API path (e.g. "/api/health")
 * @param opts  — Standard RequestInit overrides
 * @returns     — The unwrapped `data` field, typed as T
 * @throws ApiError on non-2xx responses
 */
export async function apiFetch<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
    ...(opts?.headers as Record<string, string> | undefined),
  };

  // Don't set Content-Type for requests without a body (GET, HEAD)
  const method = (opts?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    delete headers["Content-Type"];
  }

  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers,
  });

  // Parse JSON (gracefully fall back to empty object)
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (!res.ok) {
    if (res.status >= 500) {
      throw new ApiError(res.status, "Server error — please try again");
    }
    const errObj = body.error as Record<string, unknown> | undefined;
    const message = (errObj?.message as string) ?? res.statusText;
    throw new ApiError(res.status, message, errObj);
  }

  return body.data as T;
}

/**
 * Convenience: POST JSON body.
 */
export function apiPost<T = unknown>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/**
 * Convenience: PATCH JSON body.
 */
export function apiPatch<T = unknown>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

/**
 * Convenience: PUT JSON body.
 */
export function apiPut<T = unknown>(path: string, data: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/**
 * Convenience: DELETE (optionally with JSON body).
 */
export function apiDelete<T = unknown>(path: string, data?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "DELETE",
    ...(data !== undefined && { body: JSON.stringify(data) }),
  });
}
