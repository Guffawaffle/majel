/**
 * cloud-auth.ts — Cloud auth token management (generate, validate, guard)
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  AX_MODE,
  AUTH_FILE,
  AUTH_TOKEN_BYTES,
  axOutput,
  humanError,
  humanLog,
} from "./cloud-cli.js";

// ─── Token Constants ────────────────────────────────────────────

const CLOUD_TOKEN_MIN_LENGTH = 32;
const CLOUD_TOKEN_PATTERN = /^[a-f0-9]{32,}$/i;

// ─── Functions ──────────────────────────────────────────────────

export function loadCloudToken(): string | null {
  if (process.env.MAJEL_CLOUD_TOKEN) return process.env.MAJEL_CLOUD_TOKEN;

  if (!existsSync(AUTH_FILE)) return null;

  try {
    const stats = statSync(AUTH_FILE);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      humanError(`\u26a0\ufe0f  .cloud-auth has permissions ${mode.toString(8)} \u2014 expected 600. Run: chmod 600 .cloud-auth`);
      return null;
    }
  } catch { return null; }

  try {
    const content = readFileSync(AUTH_FILE, "utf-8");
    const match = content.match(/^MAJEL_CLOUD_TOKEN=(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch { return null; }
}

export function requireWriteAuth(command: string): boolean {
  const token = loadCloudToken();
  if (!token || !CLOUD_TOKEN_PATTERN.test(token)) {
    const errors = !token
      ? ["Write auth required. Run `npm run cloud:init` to generate .cloud-auth token."]
      : [`Invalid cloud auth token (expected ${CLOUD_TOKEN_MIN_LENGTH}+ hex chars). Regenerate: npm run cloud:init -- --force`];
    if (AX_MODE) {
      console.log(JSON.stringify({
        command: `cloud:${command}`,
        success: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        data: {},
        errors,
        hints: ["For CI: set MAJEL_CLOUD_TOKEN environment variable"],
      }, null, 2));
    } else {
      humanError(`\ud83d\udd12 ${errors[0]}`);
      humanError("   Or set MAJEL_CLOUD_TOKEN env var for CI.");
    }
    return false;
  }
  return true;
}

export async function cmdInit(): Promise<void> {
  const start = Date.now();

  if (existsSync(AUTH_FILE) && !process.argv.includes("--force")) {
    const token = loadCloudToken();
    if (AX_MODE) {
      axOutput("init", start, { exists: true, valid: !!token }, {
        success: false,
        errors: [".cloud-auth already exists. Use --force to regenerate."],
      });
    } else {
      humanError("\u26a0\ufe0f  .cloud-auth already exists. Use --force to regenerate.");
    }
    return;
  }

  const token = randomBytes(AUTH_TOKEN_BYTES).toString("hex");
  const content = [
    "# Majel Cloud Auth Token",
    `# Generated: ${new Date().toISOString()}`,
    "# chmod 600 \u2014 do NOT commit this file",
    "#",
    "# This token gates mutating cloud commands (deploy, rollback, scale, etc.)",
    "# Set MAJEL_CLOUD_TOKEN env var for CI pipelines.",
    `MAJEL_CLOUD_TOKEN=${token}`,
    "",
  ].join("\n");

  writeFileSync(AUTH_FILE, content, { mode: 0o600 });

  if (AX_MODE) {
    axOutput("init", start, {
      file: ".cloud-auth",
      permissions: "600",
      tokenPreview: `${token.slice(0, 8)}...${token.slice(-8)}`,
    }, { hints: ["Mutating commands now require this token", "Set MAJEL_CLOUD_TOKEN env var for CI"] });
  } else {
    humanLog("\ud83d\udd10 Cloud auth initialized");
    humanLog("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    humanLog(`  File:   .cloud-auth (chmod 600, gitignored)`);
    humanLog(`  Token:  ${token.slice(0, 8)}...${token.slice(-8)}`);
    humanLog("\n  Mutating commands (deploy, rollback, scale, etc.) now require this token.");
    humanLog("  Set MAJEL_CLOUD_TOKEN env var for CI pipelines.");
  }
}
