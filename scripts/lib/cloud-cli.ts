/**
 * cloud-cli.ts — Shared CLI infrastructure for Majel cloud operations
 *
 * Constants, types, shell execution helpers, and structured output.
 */

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AxCommandOutput } from "../../src/shared/ax.js";

// ─── Path Resolution ────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const ROOT = resolve(__dirname, "../..");

// ─── GCP Constants ──────────────────────────────────────────────

export const PROJECT = "smartergpt-majel";
export const REGION = "us-central1";
export const SERVICE = "majel";
export const REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT}/${SERVICE}`;
export const IMAGE = `${REGISTRY}/${SERVICE}:latest`;
export const CLOUD_SQL_INSTANCE = `${PROJECT}:${REGION}:majel-pg`;

export const AUTH_FILE = resolve(ROOT, ".cloud-auth");
export const AUTH_TOKEN_BYTES = 32; // 64 hex chars

// ─── Types ──────────────────────────────────────────────────────

export type AuthTier = "open" | "read" | "write";

export interface CommandArgDef {
  name: string;
  type: string;
  default?: string;
  description: string;
}

export interface CommandDef {
  fn: () => Promise<void>;
  tier: AuthTier;
  description: string;
  alias: string;
  args?: CommandArgDef[];
}

export interface DeploySmokeCheck {
  name: string;
  path: string;
  expectedStatus: number[];
  actualStatus: number | null;
  pass: boolean;
  error?: string;
}

export interface AuthorizedNetworkEntry {
  name?: string;
  value?: string;
  expirationTime?: string;
}

// ─── AX Mode State ──────────────────────────────────────────────

export let AX_MODE = false;

export function setAxMode(value: boolean): void {
  AX_MODE = value;
}

// ─── Helpers ────────────────────────────────────────────────────

export function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function axOutput(command: string, start: number, data: Record<string, unknown>, opts?: { errors?: string[]; hints?: string[]; success?: boolean }): void {
  const output: AxCommandOutput = {
    command: `cloud:${command}`,
    success: opts?.success ?? true,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    data,
  };
  if (opts?.errors?.length) output.errors = opts.errors;
  if (opts?.hints?.length) output.hints = opts.hints;
  console.log(JSON.stringify(output, null, 2));
}

/** Shell-split supporting single/double quotes and backslash escaping. */
export function shellSplit(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < cmd.length; index += 1) {
    const ch = cmd[index] ?? "";

    if (ch === "\\") {
      const next = cmd[index + 1];
      if (next != null) {
        current += next;
        index += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if ((ch === "'" || ch === '"')) {
      if (quote === null) {
        quote = ch;
        continue;
      }
      if (quote === ch) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (/\s/.test(ch) && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote !== null) {
    throw new Error(`Unterminated quote (${quote}) in command: ${cmd}`);
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Shell-safe command runner. Splits a command string into [program, ...args] and uses execFileSync to avoid shell injection. */
export function run(cmd: string, opts?: { silent?: boolean; capture?: boolean }): string {
  const parts = shellSplit(cmd);
  const [program, ...args] = parts;
  try {
    const result = execFileSync(program, args, {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: opts?.capture ? ["pipe", "pipe", "pipe"] : (opts?.silent ? ["pipe", "pipe", "pipe"] : "inherit"),
      timeout: 300_000, // 5 min max
    });
    return typeof result === "string" ? result.trim() : "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!AX_MODE && !opts?.silent) {
      console.error(`\u274c Command failed: ${program} ${args.join(" ")}`);
      console.error(msg);
    }
    throw err;
  }
}

export function runCapture(cmd: string): string {
  return run(cmd, { capture: true });
}

export function gcloud(args: string, opts?: { silent?: boolean; capture?: boolean }): string {
  return run(`gcloud ${args}`, opts);
}

export function gcloudCapture(args: string): string {
  return gcloud(args, { capture: true });
}

export function gcloudJson<T = unknown>(args: string): T {
  const raw = gcloudCapture(`${args} --format=json`);
  return JSON.parse(raw) as T;
}

export function humanLog(msg: string): void {
  if (!AX_MODE) console.log(msg);
}

export function humanError(msg: string): void {
  if (!AX_MODE) console.error(msg);
}

export function ensureGcloud(): boolean {
  try {
    runCapture("which gcloud");
    return true;
  } catch {
    if (AX_MODE) {
      console.log(JSON.stringify({
        command: `cloud:${process.argv.slice(2).find(a => !a.startsWith("--")) ?? "unknown"}`,
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        data: {},
        errors: ["gcloud CLI not found on PATH"],
        hints: [
          "Install: https://cloud.google.com/sdk/docs/install",
          "Or run from a machine with gcloud configured",
        ],
      }, null, 2));
    } else {
      humanError("\u274c gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install");
    }
    return false;
  }
}

export function getFlagValue(args: string[], name: string): string | undefined {
  const key = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === key) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) return next;
      return "";
    }
    if (arg.startsWith(`${key}=`)) {
      return arg.slice(key.length + 1);
    }
  }
  return undefined;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export { spawn };
