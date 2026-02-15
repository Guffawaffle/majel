#!/usr/bin/env node
/**
 * parse-ships.mjs — Scrape ship data from 1337wiki ship guide
 *
 * Fetches https://star-trek-fleet-command.1337wiki.com/ship-guide/
 * Parses both tables:
 *   1. Ship list (name, ability, grade, class, faction, rarity)
 *   2. Warp range by tier
 *
 * Outputs data/raw-ships.json
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const URL = "https://star-trek-fleet-command.1337wiki.com/ship-guide/";

/** Normalize curly quotes/apostrophes to ASCII */
const normalizeQuotes = (s) => s.replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"');

async function fetchPage() {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

/**
 * Parse the ship list table (table 1).
 * Columns: Ship | Link | Ability | Grade | Class | Faction | Rarity  (7 cells)
 */
function parseShipTable(html) {
    const ships = new Map();

    // Find table 1 body (footable_11603)
    const tableStart = html.indexOf("footable_11603");
    const tableEnd = html.indexOf("</table>", tableStart);
    const tableHtml = html.substring(tableStart, tableEnd);

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const stripTags = (s) => normalizeQuotes(s.replace(/<[^>]+>/g, "").trim());

    let match;
    while ((match = rowRe.exec(tableHtml)) !== null) {
        const rowHtml = match[1];
        const cells = [];
        let cellMatch;
        cellRe.lastIndex = 0;
        while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
            cells.push(cellMatch[1]); // keep raw HTML for link extraction
        }

        // Ship list rows have 7 cells: Name, Link, Ability, Grade, Class, Faction, Rarity
        if (cells.length !== 7) continue;

        const name = stripTags(cells[0]);
        const link = (cells[1].match(/href="([^"]+)"/) || [])[1] || stripTags(cells[1]);
        const abilityRaw = stripTags(cells[2]);
        const gradeRaw = stripTags(cells[3]);
        const shipClass = stripTags(cells[4]);
        const faction = stripTags(cells[5]);
        const rarity = stripTags(cells[6]);

        // Skip header rows
        if (!name || name === "Ship" || name === "Name" || gradeRaw === "Grade") continue;

        // Parse grade: "3★" → 3
        const gradeMatch = gradeRaw.match(/(\d+)/);
        const grade = gradeMatch ? parseInt(gradeMatch[1], 10) : null;

        // Parse ability name and description
        const abilityParts = abilityRaw.match(/^(.+?)\s*[-–—]\s*([\s\S]+)$/);
        const abilityName = abilityParts ? abilityParts[1].trim() : abilityRaw;
        const abilityDesc = abilityParts ? abilityParts[2].trim() : "";

        // Normalize class (fix "Survery" → "Survey")
        const normalizedClass = shipClass === "Survery" ? "Survey" : shipClass;

        ships.set(name, {
            name,
            link: link || null,
            ability: { name: abilityName, description: abilityDesc },
            grade,
            shipClass: normalizedClass,
            faction,
            rarity: rarity.toLowerCase(),
        });
    }

    return ships;
}

/**
 * Parse the warp range table (table 2).
 * Columns: Class | Rarity | Grade | Faction | Ship Name (link) | Tier1..Tier12  (17 cells)
 */
function parseWarpTable(html) {
    const warpData = new Map();

    // Find table 2 body (footable_7267)
    const tableStart = html.indexOf("footable_7267");
    const tableEnd = html.indexOf("</table>", tableStart);
    const tableHtml = html.substring(tableStart, tableEnd);

    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const stripTags = (s) => normalizeQuotes(s.replace(/<[^>]+>/g, "").trim());

    let match;
    while ((match = rowRe.exec(tableHtml)) !== null) {
        const rowHtml = match[1];
        const cells = [];
        let cellMatch;
        cellRe.lastIndex = 0;
        while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
            cells.push(stripTags(cellMatch[1]));
        }

        // Warp table rows have 17 cells: Class, Rarity, Grade, Faction, Ship Name, Tier1-12
        if (cells.length !== 17) continue;

        const name = cells[4]; // Ship Name is column 5 (index 4)
        if (!name || name === "Ship Name" || name === "Ship") continue;

        const warpRange = [];
        for (let i = 5; i <= 16; i++) {
            const val = cells[i].replace(/,/g, "").trim();
            if (val && !isNaN(parseInt(val, 10))) {
                warpRange.push(parseInt(val, 10));
            }
        }

        if (warpRange.length > 0) {
            warpData.set(name, warpRange);
        }
    }

    return warpData;
}

async function main() {
    console.log("Fetching ship guide from 1337wiki...");
    const html = await fetchPage();
    console.log(`Fetched ${(html.length / 1024).toFixed(0)} KB`);

    // Parse both tables
    const shipMap = parseShipTable(html);
    console.log(`Table 1 (ship list): ${shipMap.size} ships`);

    const warpMap = parseWarpTable(html);
    console.log(`Table 2 (warp range): ${warpMap.size} ships`);

    // Build case-insensitive lookup for warp data
    const warpLookup = new Map();
    for (const [name, range] of warpMap) {
        warpLookup.set(name.toLowerCase(), range);
    }

    // Merge warp data into ship data
    const ships = [];
    for (const [name, ship] of shipMap) {
        const warpRange = warpLookup.get(name.toLowerCase()) || null;
        ships.push({
            ...ship,
            warpRange,
        });

        // Report ships missing from warp table
        if (!warpRange) {
            console.warn(`  ⚠ No warp data for: ${name}`);
        }
    }

    // Report ships in warp table but not in ship list
    const shipLookup = new Set([...shipMap.keys()].map(n => n.toLowerCase()));
    for (const name of warpMap.keys()) {
        if (!shipLookup.has(name.toLowerCase())) {
            console.warn(`  ⚠ Warp data for unknown ship: ${name}`);
        }
    }

    // Sort by grade desc, then name
    ships.sort((a, b) => (b.grade || 0) - (a.grade || 0) || a.name.localeCompare(b.name));

    const outPath = resolve(__dirname, "../data/raw-ships.json");
    writeFileSync(outPath, JSON.stringify(ships, null, 2) + "\n");
    console.log(`\nWrote ${ships.length} ships to data/raw-ships.json`);

    // Summary
    const byGrade = {};
    const byClass = {};
    const byFaction = {};
    for (const s of ships) {
        byGrade[s.grade + "★"] = (byGrade[s.grade + "★"] || 0) + 1;
        byClass[s.shipClass] = (byClass[s.shipClass] || 0) + 1;
        byFaction[s.faction] = (byFaction[s.faction] || 0) + 1;
    }
    console.log("\nBy grade:", byGrade);
    console.log("By class:", byClass);
    console.log("By faction:", byFaction);
}

main().catch(console.error);
