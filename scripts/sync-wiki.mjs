#!/usr/bin/env node
/**
 * @deprecated Replaced by gamedata-ingest.ts (#55).
 * Wiki sync has been fully removed. Use POST /api/catalog/sync instead (reads from data/raw-officers.json).
 *
 * sync-wiki.mjs — CLI wrapper for Majel Wiki Sync (DEPRECATED)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Triggers a wiki data sync via the Majel API.
 * Equivalent to clicking "Sync Wiki Data" in the UI.
 *
 * Usage:
 *   node scripts/sync-wiki.mjs [options]
 *
 * Options:
 *   --officers-only   Sync only officers
 *   --ships-only      Sync only ships
 *   --api-url <url>   Majel API base (default: http://localhost:3000)
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  DATA ATTRIBUTION                                              │
 * │                                                                │
 * │  Star Trek: Fleet Command Wiki (Fandom)                        │
 * │  https://star-trek-fleet-command.fandom.com/wiki/Officers      │
 * │  https://star-trek-fleet-command.fandom.com/wiki/Ships          │
 * │                                                                │
 * │  Wiki text is licensed under CC BY-SA 3.0 by its contributors  │
 * │  https://creativecommons.org/licenses/by-sa/3.0/               │
 * │                                                                │
 * │  This tool does NOT bundle or redistribute wiki data.          │
 * │  Data flows: Wiki → User → Local database (never committed).   │
 * │  See ADR-013 for full legal/ethical analysis.                  │
 * └─────────────────────────────────────────────────────────────────┘
 */

const args = process.argv.slice(2);
const apiUrlIdx = args.indexOf("--api-url");
const API_BASE = apiUrlIdx >= 0 ? args[apiUrlIdx + 1] : "http://localhost:3000";
const officersOnly = args.includes("--officers-only");
const shipsOnly = args.includes("--ships-only");

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: node scripts/sync-wiki.mjs [options]

Triggers a wiki data sync via the running Majel server.
Fetches Officers + Ships from STFC Fandom Wiki Special:Export.

Options:
  --officers-only   Sync only officers
  --ships-only      Sync only ships
  --api-url <url>   Majel API base (default: http://localhost:3000)
`);
    process.exit(0);
}

async function main() {
    console.log("┌─────────────────────────────────────────────────────┐");
    console.log("│  Majel Wiki Sync                                    │");
    console.log("│  Data: STFC Fandom Wiki (CC BY-SA 3.0)             │");
    console.log("└─────────────────────────────────────────────────────┘");
    console.log();

    // Check server is running
    try {
        const health = await fetch(`${API_BASE}/api/health`);
        if (!health.ok) throw new Error(`status ${health.status}`);
    } catch {
        console.error(`✘ Cannot reach Majel API at ${API_BASE}`);
        console.error("  Make sure the server is running: npm run dev\n");
        process.exit(1);
    }

    console.log(`Syncing from wiki via ${API_BASE}...`);
    if (officersOnly) console.log("  Mode: officers only");
    else if (shipsOnly) console.log("  Mode: ships only");
    else console.log("  Mode: officers + ships");
    console.log();

    const body = {
        consent: true,
        officers: !shipsOnly,
        ships: !officersOnly,
    };

    const res = await fetch(`${API_BASE}/api/catalog/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const env = await res.json();

    if (!res.ok) {
        console.error(`✘ Sync failed: ${env.error?.message || res.statusText}`);
        process.exit(1);
    }

    const d = env.data;

    if (d.officers && body.officers) {
        console.log("Officers:");
        console.log(`  Parsed:  ${d.officers.parsed}`);
        console.log(`  Created: ${d.officers.created}`);
        console.log(`  Updated: ${d.officers.updated}`);
        if (d.provenance?.officers?.revisionId) {
            console.log(`  Rev:     ${d.provenance.officers.revisionId} @ ${d.provenance.officers.revisionTimestamp}`);
        }
        console.log();
    }

    if (d.ships && body.ships) {
        console.log("Ships:");
        console.log(`  Parsed:  ${d.ships.parsed}`);
        console.log(`  Created: ${d.ships.created}`);
        console.log(`  Updated: ${d.ships.updated}`);
        if (d.provenance?.ships?.revisionId) {
            console.log(`  Rev:     ${d.provenance.ships.revisionId} @ ${d.provenance.ships.revisionTimestamp}`);
        }
        console.log();
    }

    console.log("✔ Wiki sync complete.");
}

main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
});
