#!/usr/bin/env node
/**
 * ingest-wiki-officers.mjs — STFC Wiki Officer Ingest Utility
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Parses officer data from the STFC Fandom Wiki and upserts into Majel's
 * fleet store via the local REST API.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  DATA ATTRIBUTION                                              │
 * │                                                                │
 * │  Officer data sourced from the Star Trek: Fleet Command Wiki   │
 * │  https://star-trek-fleet-command.fandom.com/wiki/Officers      │
 * │                                                                │
 * │  Wiki text is licensed under CC BY-SA 3.0 by its contributors  │
 * │  https://creativecommons.org/licenses/by-sa/3.0/               │
 * │                                                                │
 * │  This tool does NOT bundle or redistribute wiki data.          │
 * │  Data flows: Wiki → User → Local database (never committed).   │
 * │  See ADR-013 for full legal/ethical analysis.                  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Three input modes (see ADR-013):
 *
 *   1. Local XML file (user downloaded via Special:Export):
 *      node scripts/ingest-wiki-officers.mjs --file export.xml
 *
 *   2. Pasted wikitext from stdin:
 *      cat wikitext.txt | node scripts/ingest-wiki-officers.mjs --stdin
 *
 *   3. Fetch via Special:Export (local/dev convenience only):
 *      node scripts/ingest-wiki-officers.mjs --fetch --consent
 *
 * Common options:
 *   --dry-run     Parse and display officers without writing to API
 *   --api-url     Majel API base URL (default: http://localhost:3000)
 *   --json        Output parsed officers as JSON to stdout (implies --dry-run)
 *
 * The script is idempotent — re-running will update existing officers.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

const VERSION = "0.4";
const EXPORT_URL = "https://star-trek-fleet-command.fandom.com/wiki/Special:Export";
const WIKI_PAGE_URL = "https://star-trek-fleet-command.fandom.com/wiki/Officers";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/3.0/";
const USER_AGENT = `Majel/${VERSION} (STFC Fleet Tool; local use; github.com/Guffawaffle/majel)`;

const ATTRIBUTION_NOTICE = `
┌─────────────────────────────────────────────────────────────────┐
│  DATA SOURCE ATTRIBUTION                                       │
│                                                                 │
│  Star Trek: Fleet Command Wiki (Fandom)                        │
│  ${WIKI_PAGE_URL}        │
│                                                                 │
│  Text content licensed CC BY-SA 3.0 by community contributors  │
│  ${LICENSE_URL}                     │
│                                                                 │
│  Star Trek™ and related marks are trademarks of                 │
│  CBS Studios / Paramount. STFC is a Scopely game.              │
│  This tool is an unofficial community project.                  │
└─────────────────────────────────────────────────────────────────┘`;

// ─── CLI Flags ──────────────────────────────────────────────

const args = process.argv.slice(2);

const MODE_FILE = args.includes("--file");
const MODE_STDIN = args.includes("--stdin");
const MODE_FETCH = args.includes("--fetch");
const CONSENT = args.includes("--consent");
const DRY_RUN = args.includes("--dry-run") || args.includes("--json");
const JSON_OUT = args.includes("--json");
const apiUrlIdx = args.indexOf("--api-url");
const API_BASE = apiUrlIdx >= 0 ? args[apiUrlIdx + 1] : "http://localhost:3000";
const fileIdx = args.indexOf("--file");
const FILE_PATH = fileIdx >= 0 ? args[fileIdx + 1] : null;

// ─── Helpers ────────────────────────────────────────────────

function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Normalize rarity to match Majel's allowed values */
function normalizeRarity(raw) {
    if (!raw) return null;
    const r = raw.trim().toLowerCase();
    const map = {
        common: "common",
        uncommon: "uncommon",
        rare: "rare",
        epic: "epic",
        legendary: "legendary",
    };
    return map[r] || null;
}

/** Strip wikitext markup from a cell value — images, links, formatting */
function cleanWikitext(text) {
    if (!text) return "";
    let s = text;
    // Remove [[File:...]] and image markup
    s = s.replace(/\[\[File:[^\]]*\]\]/gi, "");
    // Remove style attributes
    s = s.replace(/style="[^"]*"\s*\|/g, "");
    // Remove data- attributes
    s = s.replace(/data-[a-z-]+="[^"]*"\s*\|?/g, "");
    // Simplify [[links]] — [[Page|Display]] → Display, [[Page]] → Page
    s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
    s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
    // Remove bold/italic markup
    s = s.replace(/'{2,}/g, "");
    // Remove <br> / <br/> tags
    s = s.replace(/<br\s*\/?>/gi, " ");
    // Remove remaining HTML tags
    s = s.replace(/<[^>]*>/g, "");
    // Collapse whitespace
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

function printUsage() {
    console.log(`
Usage: node scripts/ingest-wiki-officers.mjs <mode> [options]

Modes (pick one):
  --file <path>        Parse a MediaWiki XML export file (from Special:Export)
  --stdin              Parse raw wikitext from stdin (copy/paste from wiki edit view)
  --fetch --consent    Download via Special:Export (local/dev only — requires --consent)

Options:
  --dry-run            Parse and display results without writing to API
  --json               Output parsed officers as JSON (implies --dry-run)
  --api-url <url>      Majel API base URL (default: http://localhost:3000)

How to get the data:
  Manual download:
    1. Visit: ${EXPORT_URL}
    2. Type "Officers" in the page list box
    3. Check "Include only the current revision"
    4. Click Export → save the .xml file
    5. Run: node scripts/ingest-wiki-officers.mjs --file <saved-file.xml>

  Copy/paste:
    1. Visit: ${WIKI_PAGE_URL}?action=edit
    2. Select All → Copy the wikitext
    3. Run: pbpaste | node scripts/ingest-wiki-officers.mjs --stdin
       (or paste into a file, then pipe it)
`);
}

// ─── Input Sources ──────────────────────────────────────────

/**
 * Extract wikitext from a MediaWiki XML export file.
 * Returns { wikitext, provenance } where provenance contains page/revision metadata.
 */
function parseExportXml(xmlContent) {
    // Simple XML parsing without dependencies — the structure is predictable
    const pages = [];
    const pageRegex = /<page>([\s\S]*?)<\/page>/g;
    let match;
    while ((match = pageRegex.exec(xmlContent)) !== null) {
        const block = match[1];
        const title = block.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const pageId = block.match(/<id>(\d+)<\/id>/)?.[1] || "";
        const revId = block.match(/<revision>\s*<id>(\d+)<\/id>/)?.[1] || "";
        const timestamp = block.match(/<timestamp>(.*?)<\/timestamp>/)?.[1] || "";
        const text = block.match(/<text[^>]*>([\s\S]*?)<\/text>/)?.[1] || "";
        // Unescape XML entities
        const wikitext = text
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&").replace(/&quot;/g, '"');
        pages.push({ title, pageId, revId, timestamp, wikitext });
    }

    // Find the Officers page (skip templates)
    const officersPage = pages.find(p => p.title === "Officers");
    if (!officersPage) {
        const titles = pages.map(p => p.title).join(", ");
        throw new Error(`No "Officers" page found in export. Found: ${titles || "(empty)"}`);
    }

    return {
        wikitext: officersPage.wikitext,
        provenance: {
            source: "wiki:stfc-fandom",
            pageTitle: officersPage.title,
            pageId: officersPage.pageId,
            revisionId: officersPage.revId,
            revisionTimestamp: officersPage.timestamp,
            sourceUrl: WIKI_PAGE_URL,
            license: "CC BY-SA 3.0",
            licenseUrl: LICENSE_URL,
        },
    };
}

/** Read wikitext from a local XML file */
function readFromFile(filePath) {
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }
    const xml = readFileSync(resolved, "utf-8");
    return parseExportXml(xml);
}

/** Read raw wikitext from stdin */
async function readFromStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    if (!text) throw new Error("No input received on stdin");

    // If it looks like XML, parse as export
    if (text.startsWith("<mediawiki") || text.includes("<page>")) {
        return parseExportXml(text);
    }

    // Otherwise treat as raw wikitext
    return {
        wikitext: text,
        provenance: {
            source: "wiki:stfc-fandom",
            pageTitle: "Officers",
            pageId: null,
            revisionId: null,
            revisionTimestamp: null,
            sourceUrl: WIKI_PAGE_URL,
            license: "CC BY-SA 3.0",
            licenseUrl: LICENSE_URL,
        },
    };
}

/** Fetch via Special:Export (requires --consent) */
async function fetchFromExport() {
    if (!CONSENT) {
        console.error("\n✘ --fetch requires --consent flag to acknowledge Fandom ToS.");
        console.error("  This mode uses Fandom's Special:Export tool to download wiki content.");
        console.error("  It is intended for LOCAL/DEV use only. See ADR-013.\n");
        console.error("  Add --consent to proceed:\n");
        console.error("    node scripts/ingest-wiki-officers.mjs --fetch --consent\n");
        process.exit(1);
    }

    if (!JSON_OUT) {
        console.log("Downloading Officers page via Special:Export...");
        console.log(`  URL: ${EXPORT_URL}?pages=Officers&curonly=1&templates=1`);
        console.log(`  User-Agent: ${USER_AGENT}\n`);
    }

    const url = `${EXPORT_URL}?pages=Officers&curonly=1&templates=1`;
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
    });

    if (!res.ok) throw new Error(`Special:Export returned HTTP ${res.status}`);
    const xml = await res.text();

    // Save receipt (gitignored)
    const receiptDir = resolve(PROJECT_ROOT, ".import-receipts");
    mkdirSync(receiptDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const receiptPath = resolve(receiptDir, `officers-${ts}.xml`);
    writeFileSync(receiptPath, xml, "utf-8");
    if (!JSON_OUT) console.log(`  Receipt saved: ${receiptPath}\n`);

    return parseExportXml(xml);
}

// ─── Parser ─────────────────────────────────────────────────

/**
 * Parse the wikitable from the Officers page wikitext.
 * The table format is:
 *   {| class="wikitable sortable"
 *   !Name !Captain Maneuver !Officer Ability !Below Deck Ability !Group !Rarity
 *   |-
 *   |...|...|...|...|Group|Rarity
 *   |}
 */
function parseOfficerTable(wikitext) {
    const officers = [];

    // Find the table block
    const tableStart = wikitext.indexOf('{| class="wikitable');
    const tableEnd = wikitext.indexOf("|}", tableStart);
    if (tableStart < 0 || tableEnd < 0) {
        throw new Error("Could not locate officer wikitable in page source");
    }

    const tableText = wikitext.slice(tableStart, tableEnd);

    // Split into rows by "|-"
    const rawRows = tableText.split(/\n\|-\s*\n/);

    // First row is the header — skip it
    for (let i = 1; i < rawRows.length; i++) {
        const row = rawRows[i].trim();
        if (!row) continue;

        // Split columns by "\n|" — wiki table column separator
        const cells = row.split(/\n\|/).map((c) => c.trim()).filter(Boolean);

        if (cells.length < 5) continue;

        // The name is always the first cell. Format:
        //   |style="text-align: center;" |Name[[File:...|frameless|80px|center]]
        // IMPORTANT: Remove [[File:...]] FIRST before splitting on | because
        // file templates contain | chars (e.g. |frameless|80px|center).
        let nameCell = cells[0];
        // Strip leading | (table cell marker not consumed by \n| split)
        if (nameCell.startsWith("|")) nameCell = nameCell.slice(1);
        // Remove [[File:...]] images (they contain | which corrupts pipe-splitting)
        nameCell = nameCell.replace(/\[\[File:[^\]]*\]\]/gi, "");
        // Now safe to handle style="..." | Content pattern
        if (nameCell.includes("|")) {
            const parts = nameCell.split("|");
            nameCell = parts[parts.length - 1];
        }
        const name = cleanWikitext(nameCell).trim();
        if (!name || name.length < 2) continue;

        // Rarity is last cell, group is second-to-last
        const rarityRaw = cleanWikitext(cells[cells.length - 1]);
        const groupRaw = cleanWikitext(cells[cells.length - 2]);
        const captainManeuver = cells.length > 2 ? cleanWikitext(cells[1]) : "";
        const officerAbility = cells.length > 3 ? cleanWikitext(cells[2]) : "";
        const belowDeckAbility = cells.length > 5 ? cleanWikitext(cells[3]) : "";

        const rarity = normalizeRarity(rarityRaw);
        const group = groupRaw || null;

        // Skip if rarity couldn't be parsed (probably not an officer row)
        if (!rarity && rarityRaw.toLowerCase() !== "legendary") continue;

        officers.push({
            id: slugify(name),
            name,
            rarity,
            group,
            captainManeuver: captainManeuver || null,
            officerAbility: officerAbility || null,
            belowDeckAbility: belowDeckAbility || null,
        });
    }

    // Deduplicate by ID (keep first occurrence)
    const seen = new Set();
    return officers.filter((o) => {
        if (seen.has(o.id)) return false;
        seen.add(o.id);
        return true;
    });
}

// ─── API Upsert ─────────────────────────────────────────────

async function upsertOfficer(officer) {
    const url = `${API_BASE}/api/fleet/officers`;
    const checkRes = await fetch(`${url}/${officer.id}`);

    if (checkRes.ok) {
        const patchRes = await fetch(`${url}/${officer.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: officer.name,
                rarity: officer.rarity,
                groupName: officer.group,
            }),
        });
        if (!patchRes.ok) {
            const err = await patchRes.text();
            throw new Error(`PATCH ${officer.id}: ${patchRes.status} — ${err}`);
        }
        return "updated";
    } else if (checkRes.status === 404) {
        const postRes = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: officer.id,
                name: officer.name,
                rarity: officer.rarity,
                groupName: officer.group,
                importedFrom: "wiki:stfc-fandom",
            }),
        });
        if (!postRes.ok) {
            const err = await postRes.text();
            throw new Error(`POST ${officer.id}: ${postRes.status} — ${err}`);
        }
        return "created";
    } else {
        throw new Error(`GET ${officer.id}: ${checkRes.status}`);
    }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
    // Determine input mode
    const modeCount = [MODE_FILE, MODE_STDIN, MODE_FETCH].filter(Boolean).length;
    if (modeCount === 0 || args.includes("--help") || args.includes("-h")) {
        printUsage();
        process.exit(modeCount === 0 ? 1 : 0);
    }
    if (modeCount > 1) {
        console.error("✘ Pick exactly one mode: --file, --stdin, or --fetch");
        process.exit(1);
    }

    try {
        // Always show attribution
        if (!JSON_OUT) console.log(ATTRIBUTION_NOTICE);

        // Get input
        let wikitext, provenance;
        if (MODE_FILE) {
            if (!FILE_PATH) {
                console.error("✘ --file requires a path: --file <export.xml>");
                process.exit(1);
            }
            ({ wikitext, provenance } = readFromFile(FILE_PATH));
            if (!JSON_OUT) console.log(`Parsed XML from ${FILE_PATH}`);
        } else if (MODE_STDIN) {
            ({ wikitext, provenance } = await readFromStdin());
            if (!JSON_OUT) console.log("Parsed input from stdin");
        } else {
            ({ wikitext, provenance } = await fetchFromExport());
        }

        if (!JSON_OUT && provenance.revisionId) {
            console.log(`  Page: ${provenance.pageTitle} (ID: ${provenance.pageId})`);
            console.log(`  Revision: ${provenance.revisionId} @ ${provenance.revisionTimestamp}`);
        }

        // Parse
        const officers = parseOfficerTable(wikitext);

        if (JSON_OUT) {
            console.log(JSON.stringify({ provenance, officers }, null, 2));
            return;
        }

        console.log(`\nParsed ${officers.length} officers.\n`);

        // Summary
        const groups = {};
        for (const o of officers) {
            const g = o.group || "Ungrouped";
            groups[g] = (groups[g] || 0) + 1;
        }
        console.log("Groups:");
        for (const [g, count] of Object.entries(groups).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${g}: ${count}`);
        }

        const rarities = {};
        for (const o of officers) {
            rarities[o.rarity || "unknown"] = (rarities[o.rarity || "unknown"] || 0) + 1;
        }
        console.log("\nRarities:");
        for (const [r, count] of Object.entries(rarities)) {
            console.log(`  ${r}: ${count}`);
        }

        if (DRY_RUN) {
            console.log("\n[DRY RUN] No changes written.\n");
            console.log("Sample officers:");
            officers.slice(0, 10).forEach((o) => {
                console.log(`  ${o.id} — ${o.name} (${o.rarity}, ${o.group})`);
            });
            return;
        }

        // Check API is reachable
        console.log(`\nConnecting to Majel at ${API_BASE}...`);
        try {
            const healthRes = await fetch(`${API_BASE}/api/health`);
            if (!healthRes.ok) throw new Error(`status ${healthRes.status}`);
        } catch {
            console.error(`\n✘ Cannot reach Majel API at ${API_BASE}`);
            console.error("  Make sure the server is running: npm run dev\n");
            process.exit(1);
        }

        // Upsert
        let created = 0, updated = 0, errors = 0;
        for (const officer of officers) {
            try {
                const result = await upsertOfficer(officer);
                if (result === "created") created++;
                else updated++;
                if ((created + updated) % 25 === 0) {
                    process.stdout.write(`  ... ${created + updated}/${officers.length}\n`);
                }
            } catch (err) {
                console.error(`  ✘ ${officer.name}: ${err.message}`);
                errors++;
            }
        }

        console.log(`\n✔ Ingest complete:`);
        console.log(`  Created: ${created}`);
        console.log(`  Updated: ${updated}`);
        if (errors) console.log(`  Errors:  ${errors}`);
        console.log(`  Total:   ${officers.length}`);
        console.log(`  Source:  ${provenance.sourceUrl}`);
        if (provenance.revisionId) {
            console.log(`  Rev:     ${provenance.revisionId} @ ${provenance.revisionTimestamp}`);
        }
        console.log();
    } catch (err) {
        console.error("Fatal error:", err.message);
        process.exit(1);
    }
}

main();
