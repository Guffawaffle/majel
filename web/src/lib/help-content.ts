/**
 * help-content.ts — Contextual help content for every view + global overview.
 *
 * Ported from legacy help-content.js (404 LOC).
 * Content is hardcoded HTML (trusted — not user-supplied), so {@html} is safe.
 */

export interface HelpSection {
  heading: string;
  /** HTML body — rendered via {@html} in HelpPanel */
  body: string;
}

export interface HelpKey {
  key: string;
  action: string;
}

export interface ViewHelp {
  title: string;
  intro: string;
  sections: HelpSection[];
  tips: string[];
  keys: HelpKey[];
}

/** Display metadata per view (icon + label for the index grid). */
export const VIEW_META: Record<string, { icon: string; label: string }> = {
  chat: { icon: "💬", label: "Chat" },
  catalog: { icon: "📋", label: "Catalog" },
  fleet: { icon: "🚀", label: "Fleet" },
  crews: { icon: "⚓", label: "Workshop" },
  plan: { icon: "🗺️", label: "Plan" },
  diagnostics: { icon: "⚡", label: "Diagnostics" },
  admiral: { icon: "🛡️", label: "Admiral Console" },
};

// ─── Content ────────────────────────────────────────────────

const helpContent: Record<string, ViewHelp> = {
  _global: {
    title: "About Ariadne",
    intro: "Your STFC Fleet Intelligence System — a conversational AI advisor backed by real-time fleet data.",
    sections: [
      {
        heading: "What Aria Knows",
        body: `<p>Ariadne draws from three knowledge layers:</p>
<ol>
  <li><strong>Reference Data</strong> — Every officer and ship in the game, with stats, abilities, and synergies.</li>
  <li><strong>Your Fleet</strong> — Ownership, levels, ranks, power, and custom notes for the officers and ships you own.</li>
  <li><strong>Your Compositions</strong> — Bridge cores, loadouts, below-deck policies, reservations, docks, and fleet presets — the crew-building system.</li>
</ol>`,
      },
      {
        heading: "Navigation",
        body: `<p>Use the <strong>sidebar</strong> to switch between views. On mobile, tap the ☰ button.</p>
<p>The <strong>?</strong> button in the title bar opens this help panel for context-specific guidance.</p>`,
      },
      {
        heading: "Data Model",
        body: `<p><strong>Reference data</strong> is read-only — it comes from game data sources and cannot be edited.</p>
<p><strong>Overlays</strong> are your personal data — ownership, levels, ranks, notes. These sync to your fleet roster.</p>`,
      },
    ],
    tips: [
      "Ask Aria anything — she can look up officers, recommend crews, and explain game mechanics.",
      "Use the sidebar to navigate between views.",
      "Your OPS level determines which officers and ships are relevant to you.",
    ],
    keys: [],
  },

  chat: {
    title: "Chat — Talking to Aria",
    intro: "Your conversational AI advisor — ask about officers, ships, crew builds, and strategy.",
    sections: [
      {
        heading: "What to Ask",
        body: `<ul>
  <li><strong>Crew advice</strong> — "What's the best crew for the Saladin?"</li>
  <li><strong>Fleet queries</strong> — "Which officers do I own that are good for mining?"</li>
  <li><strong>Strategy</strong> — "How should I prioritize officer upgrades?"</li>
  <li><strong>Game knowledge</strong> — "What does Yuki Sulu's captain maneuver do?"</li>
  <li><strong>Mutations</strong> — "Mark Khan as owned" or "Set my ops level to 42"</li>
</ul>`,
      },
      {
        heading: "Model Selection",
        body: `<p>Choose from 5 Gemini tiers in the model selector:</p>
<ul>
  <li><strong>Flash-Lite</strong> ($) — Fastest, cheapest. Good for simple lookups.</li>
  <li><strong>Flash</strong> ($$) — Balanced speed and intelligence.</li>
  <li><strong>Flash Thinking</strong> ($$$) — Shows reasoning steps.</li>
  <li><strong>Pro</strong> ($$$$) — Most capable for complex analysis.</li>
  <li><strong>Pro Preview</strong> ($$$$$) — Frontier model with latest capabilities.</li>
</ul>`,
      },
      {
        heading: "Sessions",
        body: `<p>Recent conversations are saved in the sidebar. Click one to restore it, or start a new chat.</p>`,
      },
    ],
    tips: [
      "Be specific — \"best mining crew for the Saladin\" is better than \"best crew\".",
      "Aria automatically looks up your fleet when answering crew questions.",
      "Confirmations are required for mutations — nothing changes without your approval.",
      "Click suggestion chips below messages for follow-up questions.",
    ],
    keys: [
      { key: "Enter", action: "Send message" },
      { key: "Shift + Enter", action: "New line" },
    ],
  },

  catalog: {
    title: "Catalog — Reference Database",
    intro: "Browse all officers and ships in the game — with your ownership overlay.",
    sections: [
      {
        heading: "Browsing",
        body: `<p>Switch between <strong>Officers</strong> and <strong>Ships</strong> tabs. Use the search bar or A–Z quick-jump.</p>`,
      },
      {
        heading: "Filtering",
        body: `<p>Filter by ownership (owned/unowned/all), officer class, hull type, rarity, and faction. Combine filters to narrow results.</p>`,
      },
      {
        heading: "Cards",
        body: `<p><strong>Officers:</strong> Class · Rarity · Group · Captain Maneuver · Officer Ability · Below Decks effect.</p>
<p><strong>Ships:</strong> Hull type · Rarity · Faction · Grade · Warp range.</p>`,
      },
      {
        heading: "Bulk Actions",
        body: `<p>Use the action buttons to mark officers/ships as owned or unowned, toggle targeting, or undo recent changes.</p>`,
      },
    ],
    tips: [
      "Use keyboard arrows to navigate cards.",
      "Combine multiple filters to narrow results quickly.",
      "Ownership changes sync to your Fleet roster automatically.",
    ],
    keys: [
      { key: "Space", action: "Toggle owned" },
      { key: "T", action: "Toggle target" },
      { key: "← → ↑ ↓", action: "Navigate cards" },
    ],
  },

  fleet: {
    title: "Fleet — Your Roster",
    intro: "Your owned officers and ships — levels, ranks, power, notes, and cross-references.",
    sections: [
      {
        heading: "Roster",
        body: `<p>Shows only officers/ships you've marked as <strong>owned</strong>. Stats bar shows totals.</p>`,
      },
      {
        heading: "Inline Editing",
        body: `<p>Click any officer/ship to expand its detail panel. Edit level, rank, power, tier, and notes inline.</p>`,
      },
      {
        heading: "Cross-References",
        body: `<p>Each officer shows where they're used across the crew system:</p>
<ul>
  <li>🔗 Reservations</li>
  <li>👥 Bridge Cores</li>
  <li>📋 Below-Deck Policies</li>
  <li>⚠️ Conflicts</li>
  <li>⚓ Loadouts</li>
  <li>🔧 Dock Assignments</li>
</ul>`,
      },
      {
        heading: "Sorting & View Mode",
        body: `<p>Sort by name, level, power, or rank. Toggle between grid and list views.</p>`,
      },
    ],
    tips: [
      "The stats bar updates in real-time as you edit.",
      "Cross-references help you check before removing an officer.",
      "Notes are searchable — add tags to help you find officers later.",
    ],
    keys: [],
  },

  crews: {
    title: "Workshop — Composition Workshop",
    intro: "The comprehensive crew management view — bridge cores, loadouts, policies & reservations.",
    sections: [
      {
        heading: "Bridge Cores",
        body: `<p>A bridge core is a <strong>captain + 2 bridge officers</strong>. Create reusable cores and assign them to loadouts.</p>
<p>Cross-references show which loadouts use each core.</p>`,
      },
      {
        heading: "Loadouts",
        body: `<p>Loadouts combine a <strong>ship + bridge core + below-deck policy + intents + tags</strong>.</p>
<p>Use the intent picker to tag loadouts with their purpose (21 intents across mining, combat, and utility categories).</p>`,
      },
      {
        heading: "Policies",
        body: `<p>Below-deck policies define how the remaining crew slots are filled. Three modes:</p>
<ul>
  <li><strong>Stats → BDA</strong> — Fill by stats first, then below-deck abilities.</li>
  <li><strong>Pinned Only</strong> — Use only the officers you pin.</li>
  <li><strong>Stats Fill Only</strong> — Fill purely by stats, ignore abilities.</li>
</ul>`,
      },
      {
        heading: "Reservations",
        body: `<p>Reserve officers for specific uses. <strong>Soft lock</strong> (🔓) is advisory; <strong>hard lock</strong> (🔒) prevents the officer from being assigned elsewhere.</p>`,
      },
    ],
    tips: [
      "Build cores first, then loadouts that reference them.",
      "Intents help Aria understand what each loadout is for.",
      "Policies with pinned officers give you precise control over below-deck slots.",
      "Reservations prevent accidental double-booking of key officers.",
    ],
    keys: [],
  },

  plan: {
    title: "Plan — Fleet State Dashboard",
    intro: "Single source of truth for dock assignments, presets, and the effective fleet state.",
    sections: [
      {
        heading: "Effective State",
        body: `<p>Shows the <strong>current state of all docks</strong> with their assigned loadouts, bridge crews, and policies.</p>
<p>Sources: <span style="color:var(--accent-green)">🟢 Preset</span> (from activated fleet preset) or <span style="color:var(--accent-gold)">🟡 Manual</span> (manually assigned).</p>
<p><strong>Conflict alerts</strong> appear when an officer is assigned to multiple docks simultaneously.</p>`,
      },
      {
        heading: "Docks",
        body: `<p>Docks are numbered slots (1–99) that hold ship loadouts. Each dock has a label, lock state, and optional notes.</p>`,
      },
      {
        heading: "Fleet Presets",
        body: `<p>Presets are saved fleet configurations that assign loadouts to docks in bulk. <strong>Activate</strong> a preset to populate all docks at once.</p>`,
      },
      {
        heading: "Plan Items",
        body: `<p>Manual dock assignments. Use these for one-off changes without creating a full preset.</p>`,
      },
    ],
    tips: [
      "Check the Effective State tab after activating a preset to verify assignments.",
      "Conflicts are highlighted — resolve them before deploying.",
      "Manual overrides take precedence over preset assignments.",
      "Use dock labels to remember what each dock is for.",
    ],
    keys: [],
  },

  diagnostics: {
    title: "Diagnostics — System Dashboard",
    intro: "System health, data summary, query console & schema browser — for admirals.",
    sections: [
      {
        heading: "System Health",
        body: `<p>Real-time status of all system components: Gemini engine, Lex memory, settings store, session store, reference/overlay/crew stores.</p>`,
      },
      {
        heading: "Data Summary",
        body: `<p>Aggregate counts and breakdowns of reference data and overlays. Includes sample data for quick verification.</p>`,
      },
      {
        heading: "Query Console",
        body: `<p>Execute read-only SQL queries against the database. Use <strong>preset queries</strong> for common lookups or write custom SQL.</p>
<p>Results limited to 200 rows. Up to 20 queries stored in history.</p>`,
      },
      {
        heading: "Schema Browser",
        body: `<p>Browse all database tables, columns, types, and indexes. Row counts show data volume per table.</p>`,
      },
    ],
    tips: [
      "Use Ctrl+Enter (or ⌘+Enter) to run queries from the textarea.",
      "Preset queries are safe starting points — modify them for custom analysis.",
      "The schema browser helps you write correct SQL by showing column names and types.",
    ],
    keys: [],
  },

  admiral: {
    title: "Admiral Console — Administration",
    intro: "User management, invite codes & session control — for admirals.",
    sections: [
      {
        heading: "Users",
        body: `<p>Manage all registered users. Four roles with escalating permissions:</p>
<ul>
  <li><strong>Ensign</strong> — Basic access (chat, catalog, fleet).</li>
  <li><strong>Lieutenant</strong> — + Workshop and Plan access.</li>
  <li><strong>Captain</strong> — + Full crew management.</li>
  <li><strong>Admiral</strong> — + Diagnostics, admin console, user management.</li>
</ul>
<p>Lock accounts to suspend access. Delete to permanently remove.</p>`,
      },
      {
        heading: "Invites",
        body: `<p>Generate invite codes to onboard new users. Configure:</p>
<ul>
  <li><strong>Max uses</strong> — 1 to 100 (default: 10).</li>
  <li><strong>Expiry</strong> — 1 hour to 30 days (default: 7 days).</li>
  <li><strong>Label</strong> — Optional note for tracking.</li>
</ul>
<p>Codes are copied to clipboard on creation. Revoke codes to invalidate them.</p>`,
      },
      {
        heading: "Sessions",
        body: `<p>View all active sessions across all users. Kill individual sessions or all sessions at once.</p>
<p>⚠️ "Kill All" will log out every user including yourself.</p>`,
      },
    ],
    tips: [
      "You can't change your own role or lock/delete yourself.",
      "Revoked invite codes cannot be reactivated — create a new one.",
      "Session IDs are truncated for display — hover or click to see full ID.",
    ],
    keys: [],
  },
};

// ─── Accessors ──────────────────────────────────────────────

/** Get help content for a specific view, falling back to global. */
export function getHelpForView(viewName: string | null): ViewHelp {
  if (viewName && viewName in helpContent) return helpContent[viewName];
  return helpContent._global;
}

/** Get the global "About Ariadne" help. */
export function getGlobalHelp(): ViewHelp {
  return helpContent._global;
}

/** Get the list of view names that have help (excludes _global). */
export function getHelpViewNames(): string[] {
  return Object.keys(helpContent).filter((k) => k !== "_global");
}
