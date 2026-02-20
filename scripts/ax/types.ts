/**
 * ax/types.ts — Shared type contracts for the Ax command-set.
 *
 * Every command returns an AxResult. The router emits it (stdout JSON)
 * and persists it (ax-last-run.json + ax-runs.ndjson).
 */

// ─── Core contract ──────────────────────────────────────────────

/** Structured result returned by every ax command. */
export interface AxResult {
  command: string;
  success: boolean;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  errors?: string[];
  hints?: string[];
}

/** Registerable ax command — pure function, no side effects. */
export interface AxCommand {
  name: string;
  description: string;
  run: (args: string[]) => Promise<AxResult>;
}

// ─── Domain types ───────────────────────────────────────────────

export interface TestFailure {
  file: string;
  test: string;
  error: string;
}

export interface TestResult {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: string;
  failures: TestFailure[];
}

export interface TypecheckError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface LintError {
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export interface CoverageFile {
  file: string;
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

export interface CiStepResult {
  step: string;
  success: boolean;
  durationMs: number;
  data: Record<string, unknown>;
}
