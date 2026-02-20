/**
 * Diagnostic API — system health, data summary, schema browser, query console.
 * All endpoints require admiral role.
 */

import { apiFetch, qs } from "./fetch.js";
import type {
  DiagnosticHealth,
  DiagnosticSchema,
  DiagnosticSummary,
  QueryResult,
} from "../types.js";

/** Fetch full diagnostic health report. */
export async function fetchDiagnosticHealth(): Promise<DiagnosticHealth> {
  return apiFetch<DiagnosticHealth>("/api/diagnostic");
}

/** Fetch data summary (reference + overlay counts, breakdowns, samples). */
export async function fetchDiagnosticSummary(): Promise<DiagnosticSummary> {
  return apiFetch<DiagnosticSummary>("/api/diagnostic/summary");
}

/** Fetch database schema (tables, columns, indexes, row counts). */
export async function fetchDiagnosticSchema(): Promise<DiagnosticSchema> {
  return apiFetch<DiagnosticSchema>("/api/diagnostic/schema");
}

/** Execute a read-only SQL query. */
export async function executeDiagnosticQuery(
  sql: string,
  limit = 200,
): Promise<QueryResult> {
  return apiFetch<QueryResult>(`/api/diagnostic/query${qs({ sql, limit })}`);
}
