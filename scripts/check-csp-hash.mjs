#!/usr/bin/env node
/**
 * check-csp-hash.mjs — Verify CSP import-map hash stays in sync
 *
 * The browser computes a SHA-256 hash of every inline <script> and checks it
 * against the CSP script-src directive. If the import map content changes
 * (even whitespace) without updating the hash in index.ts, the page breaks.
 *
 * Run: node scripts/check-csp-hash.mjs          (verify)
 *      node scripts/check-csp-hash.mjs --fix    (auto-update index.ts)
 *
 * Wired into: pre-commit hook, local-ci, lint script.
 */

import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

const HTML_PATH = "src/client/index.html";
const SERVER_PATH = "src/server/index.ts";

// 1. Extract import map content from HTML
const html = readFileSync(HTML_PATH, "utf8");
const mapMatch = html.match(/<script type="importmap">(.*?)<\/script>/s);
if (!mapMatch) {
  console.error("❌ No <script type=\"importmap\"> found in", HTML_PATH);
  process.exit(1);
}

const actualHash =
  "'sha256-" + createHash("sha256").update(mapMatch[1]).digest("base64") + "'";

// 2. Extract CSP hash from server
const server = readFileSync(SERVER_PATH, "utf8");
const cspMatch = server.match(/script-src\s+'self'\s+('sha256-[A-Za-z0-9+/=]+')/);
if (!cspMatch) {
  console.error("❌ No script-src sha256 hash found in", SERVER_PATH);
  process.exit(1);
}

const declaredHash = cspMatch[1];

// 3. Compare
if (actualHash === declaredHash) {
  console.log("✅ CSP import-map hash is in sync:", actualHash);
  process.exit(0);
}

// Mismatch!
if (process.argv.includes("--fix")) {
  const updated = server.replace(declaredHash, actualHash);
  writeFileSync(SERVER_PATH, updated);
  console.log("🔧 CSP hash updated in", SERVER_PATH);
  console.log("   old:", declaredHash);
  console.log("   new:", actualHash);
  process.exit(0);
}

console.error("❌ CSP import-map hash mismatch!");
console.error("   HTML content hash:", actualHash);
console.error("   index.ts declares:", declaredHash);
console.error("");
console.error("   The import map in", HTML_PATH, "changed but the CSP hash");
console.error("   in", SERVER_PATH, "was not updated. The browser will block");
console.error("   the import map and all module imports will fail.");
console.error("");
console.error("   Fix: run  node scripts/check-csp-hash.mjs --fix");
process.exit(1);
