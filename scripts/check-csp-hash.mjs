#!/usr/bin/env node
/**
 * check-csp-hash.mjs — CSP compliance check (ADR-031 Phase 8)
 *
 * With the Svelte/Vite migration, there are no inline scripts (no import maps).
 * This script verifies that the CSP in index.ts does NOT contain any stale
 * sha256 hashes, confirming the "script-src 'self'" policy is clean.
 *
 * Wired into: pre-commit hook, local-ci, lint script.
 */

import { readFileSync } from "fs";

const SERVER_PATH = "src/server/index.ts";

const server = readFileSync(SERVER_PATH, "utf8");
const hashMatch = server.match(/script-src\s+'self'\s+('sha256-[A-Za-z0-9+/=]+')/);

if (hashMatch) {
    console.error("❌ CSP script-src still contains an inline-script hash:", hashMatch[1]);
    console.error("   Svelte/Vite produces external bundles only — remove the hash.");
    process.exit(1);
}

console.log("✅ CSP script-src is clean (no inline-script hashes)");
process.exit(0);
