/**
 * sheets.ts — Google Sheets OAuth + Multi-Tab Fleet Data Fetch
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Supports multiple tabs with classification:
 * - Fetches all configured tabs from a single spreadsheet
 * - Each tab is classified by type (officers, ships, custom)
 * - Returns structured FleetData, not raw CSV
 *
 * OAuth uses Desktop app loopback flow with dynamic port.
 */

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { URL } from "node:url";
import {
  type TabMapping,
  type FleetData,
  DEFAULT_TAB_MAPPING,
  buildSection,
  buildFleetData,
} from "./fleet-data.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const TOKEN_PATH = path.resolve("token.json");
const CREDENTIALS_PATH = path.resolve("credentials.json");

// ─── Re-export for backward compat ──────────────────────────────

/** @deprecated Use FleetData-based APIs instead */
export interface SheetsConfig {
  spreadsheetId: string;
  range: string;
}

// ─── Multi-Tab Configuration ────────────────────────────────────

export interface MultiTabConfig {
  spreadsheetId: string;
  /** Maps tab names → fleet data types. If empty, auto-discovers all tabs. */
  tabMapping: TabMapping;
}

/**
 * Parse tab mapping from environment variable.
 * Format: "TabName:type,TabName2:type2" e.g. "Officers:officers,Ships:ships"
 * Returns DEFAULT_TAB_MAPPING if not set or empty.
 */
export function parseTabMapping(envValue: string | undefined): TabMapping {
  if (!envValue || envValue.trim() === "") {
    return { ...DEFAULT_TAB_MAPPING };
  }

  const mapping: TabMapping = {};
  for (const pair of envValue.split(",")) {
    const [tabName, type] = pair.split(":").map((s) => s.trim());
    if (tabName && type) {
      const validTypes = ["officers", "ships", "custom"] as const;
      const tabType = validTypes.includes(type as (typeof validTypes)[number])
        ? (type as (typeof validTypes)[number])
        : "custom";
      mapping[tabName] = tabType;
    }
  }

  return Object.keys(mapping).length > 0 ? mapping : { ...DEFAULT_TAB_MAPPING };
}

/**
 * Load or run OAuth2 flow for Google Sheets access.
 * Mirrors the Python `get_sheets_service()` pattern.
 */
async function getOAuth2Client(): Promise<OAuth2Client> {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}.\n` +
        "Download from: Google Cloud Console → APIs & Services → Credentials\n" +
        "Place in the project root and run again."
    );
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } =
    credentials.installed || credentials.web;

  // For Desktop app OAuth, we use a loopback redirect on a dynamic port.
  // The redirect_uri is set when we actually start the callback server.
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);

  // Try loading cached token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oauth2Client.setCredentials(token);

    // Check if token needs refresh
    if (token.expiry_date && token.expiry_date < Date.now()) {
      try {
        const { credentials: refreshed } =
          await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(refreshed);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(refreshed, null, 2));
      } catch {
        // Refresh failed — re-auth
        return runLocalOAuthFlow(oauth2Client);
      }
    }

    return oauth2Client;
  }

  // No cached token — run interactive flow
  return runLocalOAuthFlow(oauth2Client);
}

/**
 * Run a local loopback OAuth flow (Desktop app style).
 *
 * Google Desktop OAuth redirects to http://localhost:{port}/?code=...
 * We spin up a temporary server, grab the code, exchange it, then shut down.
 */
function runLocalOAuthFlow(oauth2Client: OAuth2Client): Promise<OAuth2Client> {
  return new Promise((resolve, reject) => {
    // Use port 0 to get an OS-assigned free port, then build the redirect URI
    const server = http.createServer(async (req, res) => {
      try {
        const port = (server.address() as { port: number }).port;
        const url = new URL(req.url!, `http://localhost:${port}`);

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>❌ Missing authorization code</h2><p>Try the OAuth flow again.</p>");
          return;
        }

        // Exchange code for tokens — must pass the exact redirect_uri used for auth
        const redirectUri = `http://localhost:${port}`;
        const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri });
        oauth2Client.setCredentials(tokens);

        // Cache token for future runs
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>✅ Majel authorized!</h2>" +
          "<p>Google Sheets connected. You can close this tab.</p>" +
          "<p>Restart Majel to load your roster: <code>npm run dev</code></p>"
        );

        server.close();
        resolve(oauth2Client);
      } catch (err) {
        console.error("OAuth token exchange failed:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end("<h2>❌ OAuth error</h2><p>Check the server console for details.</p>");
        server.close();
        reject(err);
      }
    });

    // Listen on port 0 → OS picks a free port
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://localhost:${port}`;

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
        redirect_uri: redirectUri,
      });

      console.log("\n🔐 OAuth required. Open this URL in a browser:\n");
      console.log(`   ${authUrl}\n`);
      console.log(`   Listening for callback on ${redirectUri} ...\n`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

/**
 * Fetch the roster spreadsheet and return as CSV string.
 * @deprecated Use fetchFleetData() instead.
 */
export async function fetchRoster(config: SheetsConfig): Promise<string> {
  const auth = await getOAuth2Client();
  const sheets = google.sheets({ version: "v4", auth });

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.range,
  });

  const values = result.data.values;
  if (!values || values.length === 0) {
    return "No data found in spreadsheet.";
  }

  // Serialize to CSV (handle commas/quotes properly)
  return values
    .map((row) =>
      row
        .map((cell: string) => {
          const s = String(cell);
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(",")
    )
    .join("\n");
}

// ─── Multi-Tab Data Fetching ────────────────────────────────────

/**
 * Discover all tab names in a spreadsheet.
 */
async function discoverTabs(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<string[]> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });

  return (
    meta.data.sheets?.map((s) => s.properties?.title ?? "").filter(Boolean) ?? []
  );
}

/**
 * Fetch a single tab's data as a 2D array.
 */
async function fetchTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string
): Promise<string[][]> {
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'`,
  });

  return (result.data.values as string[][]) ?? [];
}

/**
 * Fetch all configured tabs and return structured FleetData.
 *
 * Process:
 * 1. Discover all tabs in the spreadsheet
 * 2. Match tabs against the configured mapping
 * 3. Fetch data for each matched tab
 * 4. Build structured FleetData with typed sections
 */
export async function fetchFleetData(config: MultiTabConfig): Promise<FleetData> {
  const auth = await getOAuth2Client();
  const sheets = google.sheets({ version: "v4", auth });

  // Discover available tabs
  const availableTabs = await discoverTabs(sheets, config.spreadsheetId);
  console.log(`   📋 Found tabs: ${availableTabs.join(", ")}`);

  // Match tabs to mapping (case-insensitive)
  const matchedTabs: Array<{ tabName: string; type: TabMapping[string] }> = [];

  for (const available of availableTabs) {
    const mappingKey = Object.keys(config.tabMapping).find(
      (key) => key === available || key.toLowerCase() === available.toLowerCase()
    );

    if (mappingKey) {
      matchedTabs.push({ tabName: available, type: config.tabMapping[mappingKey] });
    }
  }

  if (matchedTabs.length === 0) {
    console.warn(
      `   ⚠️  No tabs matched the mapping. Available: [${availableTabs.join(", ")}], ` +
        `Configured: [${Object.keys(config.tabMapping).join(", ")}]`
    );
  }

  // Fetch each matched tab in parallel
  const sections = await Promise.all(
    matchedTabs.map(async ({ tabName, type }) => {
      const rows = await fetchTab(sheets, config.spreadsheetId, tabName);
      const section = buildSection(type, tabName, tabName, rows);
      console.log(
        `   ✅ ${tabName} (${type}): ${section.rowCount} rows, ${section.csv.length} chars`
      );
      return section;
    })
  );

  return buildFleetData(config.spreadsheetId, sections);
}

/**
 * Check whether Google OAuth credentials are configured.
 */
export function hasCredentials(): boolean {
  return fs.existsSync(CREDENTIALS_PATH);
}
