#!/usr/bin/env node
/**
 * check-csp-hash.mjs — CSP compliance check (ADR-031 Phase 8)
 *
 * With the Svelte/Vite migration, there are no inline scripts (no import maps).
 * This script verifies that:
 *  1. CSP script-src does NOT contain any stale sha256 hashes
 *  2. Any style-src sha256 hash matches the actual inline <style> in web/index.html
 *
 * Wired into: pre-commit hook, local-ci, lint script.
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";

const SERVER_PATH = "src/server/index.ts";
const HTML_PATH = "web/index.html";

const server = readFileSync(SERVER_PATH, "utf8");

// 1. No stale script-src hashes
const hashMatch = server.match(/script-src\s+'self'\s+('sha256-[A-Za-z0-9+/=]+')/);

if (hashMatch) {
    console.error("❌ CSP script-src still contains an inline-script hash:", hashMatch[1]);
    console.error("   Svelte/Vite produces external bundles only — remove the hash.");
    process.exit(1);
}

console.log("✅ CSP script-src is clean (no inline-script hashes)");

// 2. Verify style-src hash matches actual inline <style> content
const styleHashMatch = server.match(/style-src\s+'self'\s+'sha256-([A-Za-z0-9+/=]+)'/);

if (styleHashMatch) {
    const cspHash = styleHashMatch[1];
    const html = readFileSync(HTML_PATH, "utf8");
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);

    if (!styleMatch) {
        console.error("❌ CSP style-src has a hash but web/index.html has no inline <style>");
        process.exit(1);
    }

    const actualHash = createHash("sha256").update(styleMatch[1], "utf8").digest("base64");

    if (cspHash !== actualHash) {
        console.error("❌ CSP style-src hash is stale");
        console.error("   CSP hash:    sha256-" + cspHash);
        console.error("   Actual hash: sha256-" + actualHash);
        console.error("   Run: npm run fix:csp  (or update the hash in src/server/index.ts)");
        process.exit(1);
    }

    console.log("✅ CSP style-src hash matches inline <style> content");
} else {
    console.log("ℹ  No style-src hash in CSP (none required)");
}

process.exit(0);
