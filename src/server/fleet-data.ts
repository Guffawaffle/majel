/**
 * fleet-data.ts — Fleet Data Model
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Defines the structured fleet data model. Each data source (officers, ships, etc.)
 * is a labeled section with its own CSV data, metadata, and optional column mapping.
 *
 * This replaces the old "single CSV blob" approach with a typed, multi-section
 * model that lets the prompt builder give the model properly labeled context.
 */

// ─── Tab Types ──────────────────────────────────────────────────

/**
 * Known fleet data categories.
 * "custom" is a catch-all for user-defined tabs we don't have special handling for.
 */
export type TabType = "officers" | "ships" | "custom";

/**
 * A single data section from a spreadsheet tab.
 */
export interface FleetSection {
  /** What kind of data this is */
  type: TabType;

  /** Display label (e.g. "Officers", "Ships", tab name) */
  label: string;

  /** The actual spreadsheet tab/range this came from */
  source: string;

  /** Raw 2D array from Sheets API */
  rows: string[][];

  /** CSV-serialized version of the data */
  csv: string;

  /** Number of data rows (excluding header) */
  rowCount: number;

  /** Column headers (first row) */
  headers: string[];
}

/**
 * Complete fleet intelligence data — all tabs, structured.
 */
export interface FleetData {
  /** All loaded sections, keyed by their type (or label for custom) */
  sections: FleetSection[];

  /** When this data was last fetched */
  fetchedAt: string;

  /** Source spreadsheet ID */
  spreadsheetId: string;

  /** Total character count across all sections */
  totalChars: number;
}

// ─── Tab Mapping Configuration ──────────────────────────────────

/**
 * Maps spreadsheet tab names to fleet data types.
 * User configures this to tell Majel what each tab contains.
 *
 * Example: { "Roster": "officers", "My Ships": "ships", "Notes": "custom" }
 */
export type TabMapping = Record<string, TabType>;

/**
 * Default tab mapping — works with common STFC spreadsheet layouts.
 */
export const DEFAULT_TAB_MAPPING: TabMapping = {
  Officers: "officers",
  Roster: "officers",
  Ships: "ships",
};

// ─── Serialization ──────────────────────────────────────────────

/**
 * Convert a 2D array of cell values to a CSV string.
 * Handles commas, quotes, and newlines in cell values.
 */
export function rowsToCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join(",")
    )
    .join("\n");
}

/**
 * Build a FleetSection from raw spreadsheet row data.
 */
export function buildSection(
  type: TabType,
  label: string,
  source: string,
  rows: string[][]
): FleetSection {
  const csv = rowsToCsv(rows);
  const headers = rows.length > 0 ? rows[0].map((h) => String(h ?? "")) : [];
  const rowCount = Math.max(0, rows.length - 1); // exclude header

  return { type, label, source, rows, csv, rowCount, headers };
}

/**
 * Build a complete FleetData object from multiple sections.
 */
export function buildFleetData(
  spreadsheetId: string,
  sections: FleetSection[]
): FleetData {
  const totalChars = sections.reduce((sum, s) => sum + s.csv.length, 0);

  return {
    sections,
    fetchedAt: new Date().toISOString(),
    spreadsheetId,
    totalChars,
  };
}

/**
 * Check if fleet data has any meaningful content.
 */
export function hasFleetData(data: FleetData | null): boolean {
  if (!data) return false;
  return data.sections.length > 0 && data.totalChars > 0;
}

/**
 * Get sections of a specific type.
 */
export function getSections(
  data: FleetData,
  type: TabType
): FleetSection[] {
  return data.sections.filter((s) => s.type === type);
}

/**
 * Format fleet data as a human-readable summary for health endpoints.
 */
export function fleetDataSummary(
  data: FleetData
): { totalChars: number; sections: Array<{ label: string; type: string; rows: number }> } {
  return {
    totalChars: data.totalChars,
    sections: data.sections.map((s) => ({
      label: s.label,
      type: s.type,
      rows: s.rowCount,
    })),
  };
}
