/**
 * ax/runner.ts — Shared plumbing for ax commands.
 *
 * Provides process execution, result construction, result emission,
 * and arg helpers. Commands import from here — never from each other.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AxResult } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the project root. */
export const ROOT = resolve(__dirname, "../..");

// ─── Arg helpers ────────────────────────────────────────────────

/** Extract a --name=value flag from args. */
export function getFlag(args: string[], name: string): string | undefined {
  const flag = args.find(a => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=").slice(1).join("=");

  const exactIndex = args.findIndex(a => a === `--${name}`);
  if (exactIndex >= 0) {
    const next = args[exactIndex + 1];
    if (next && !next.startsWith("--")) return next;
  }

  return undefined;
}

/** Check for a boolean --name flag in args. */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

// ─── Result construction ────────────────────────────────────────

/** Build an AxResult without emitting it. */
export function makeResult(
  cmd: string,
  start: number,
  data: Record<string, unknown>,
  opts?: { success?: boolean; errors?: string[]; hints?: string[] },
): AxResult {
  const result: AxResult = {
    command: `ax:${cmd}`,
    success: opts?.success ?? true,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    data,
  };
  if (opts?.errors?.length) result.errors = opts.errors;
  if (opts?.hints?.length) result.hints = opts.hints;
  return result;
}

// ─── Result emission ────────────────────────────────────────────

/** Emit result to stdout (JSON) and persist to disk. */
export function emitResult(result: AxResult): void {
  console.log(JSON.stringify(result, null, 2));
  try {
    const logsDir = join(ROOT, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "ax-last-run.json"), JSON.stringify(result, null, 2) + "\n");
    appendFileSync(join(logsDir, "ax-runs.ndjson"), JSON.stringify(result) + "\n");
  } catch { /* best-effort — never break the command */ }
}

// ─── Process execution ──────────────────────────────────────────

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a command synchronously and capture stdout/stderr/exitCode. */
export function runCapture(
  cmd: string,
  cmdArgs: string[],
  _opts?: { ignoreExit?: boolean },
): CaptureResult {
  const spawnOpts: ExecFileSyncOptions = {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 600_000,    // 10 min
    maxBuffer: 50 * 1024 * 1024, // 50 MB
  };
  try {
    const stdout = execFileSync(cmd, cmdArgs, spawnOpts) as string;
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr ?? ""),
        exitCode: typeof e.status === "number" ? e.status : 1,
      };
    }
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

// ─── Utilities ──────────────────────────────────────────────────

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
