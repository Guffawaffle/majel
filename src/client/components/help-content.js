/**
 * help-content.js — Structured help content keyed by view name
 *
 * Each entry provides contextual help for a specific view.
 * Consumed by help-panel.js to render the right-side help drawer.
 *
 * Format:
 *   title    — Panel heading
 *   intro    — One-liner overview
 *   sections — Array of { heading, body (HTML string) }
 *   tips     — Array of quick-tip strings (shown as bullet list)
 *   keys     — Array of { key, action } for keyboard shortcuts
 */

/** @type {Record<string, ViewHelp>} */
export const helpContent = {

    // ─── Global / Fallback ──────────────────────────────────
    _global: {
        title: 'About Ariadne',
        intro: 'Your STFC Fleet Intelligence System — an AI advisor that actually knows your fleet.',
        sections: [
            {
                heading: 'What Aria Knows',
                body: `
                    <p>Aria combines <strong>three layers</strong> of knowledge:</p>
                    <ol>
                        <li><strong>Your Fleet</strong> — every officer, ship, loadout, dock, and target you've configured. She reads your actual data.</li>
                        <li><strong>Reference Data</strong> — officer abilities, ship stats, hull types, and faction info from the CDN catalog.</li>
                        <li><strong>Game Knowledge</strong> — combat triangle, crew synergies, PvP meta, mining strategies, event tactics, and Trek lore from training data.</li>
                    </ol>
                `
            },
            {
                heading: 'Navigation',
                body: `
                    <p>Use the <strong>sidebar</strong> to switch between views. Each view handles a different aspect of fleet management.</p>
                    <p>The <strong>back button</strong> (←) in the title bar returns to your previous view. Your browser's back/forward buttons work too.</p>
                `
            },
            {
                heading: 'Data Model',
                body: `
                    <p>Majel separates <strong>reference data</strong> (game facts — stats, abilities, factions) from your <strong>personal overlays</strong> (levels, tiers, notes, ownership). Your data is never lost when reference data updates.</p>
                `
            }
        ],
        tips: [
            'You can ask Aria about anything STFC — she\'ll use your fleet data when relevant',
            'Use the sidebar to jump between views; the back button remembers your history',
            'Your OPS level is shown in the sidebar footer — click it to update',
        ],
        keys: []
    },

    // ─── Chat ───────────────────────────────────────────────
    chat: {
        title: 'Chat — Talking to Aria',
        intro: 'Your conversational AI advisor. Ask about crews, strategy, lore, or your fleet — she has full context.',
        sections: [
            {
                heading: 'What to Ask',
                body: `
                    <p>Aria can answer questions across the full STFC domain:</p>
                    <ul>
                        <li><strong>Crew advice</strong> — "What crew should I use for the Enterprise?"</li>
                        <li><strong>Fleet queries</strong> — "Show me my strongest officers" or "Which ships aren't crewed?"</li>
                        <li><strong>Strategy</strong> — "What's the current PvP meta?" or "Best mining crew for latinum?"</li>
                        <li><strong>Game knowledge</strong> — "How does the combat triangle work?" or "Tell me about Khan"</li>
                        <li><strong>Fleet mutations</strong> — "Create a target to unlock the Enterprise" or "Set up a new bridge core with Kirk, Spock, and McCoy"</li>
                    </ul>
                    <p>She reads your fleet data automatically — no need to describe what you own.</p>
                `
            },
            {
                heading: 'Model Selection',
                body: `
                    <p>Click the model name below the input box to switch AI tiers:</p>
                    <ul>
                        <li><strong>Flash-Lite ($)</strong> — fastest, cheapest. Good for quick lookups.</li>
                        <li><strong>Flash ($$)</strong> — balanced speed and quality with thinking.</li>
                        <li><strong>Flash Preview ($$$)</strong> — latest thinking model. Default.</li>
                        <li><strong>Pro ($$$$)</strong> — premium quality for complex analysis.</li>
                        <li><strong>Pro Preview ($$$$$)</strong> — frontier model. Best reasoning, slowest.</li>
                    </ul>
                `
            },
            {
                heading: 'Sessions',
                body: `
                    <p><strong>Recent Chats</strong> appear in the sidebar. Click to restore a previous conversation. Each session has its own history.</p>
                    <p>Click <strong>✚ New Chat</strong> to start a fresh session. Aria's memory persists across sessions — she can recall past conversations.</p>
                `
            }
        ],
        tips: [
            'Be specific — "What crew for the Enterprise for PvP?" beats "good crew?"',
            'Aria will look up your fleet data automatically — just ask naturally',
            'She confirms before making changes (creating targets, bridge cores, etc.)',
            'Suggestion chips on the welcome screen are good starting points',
        ],
        keys: [
            { key: 'Enter', action: 'Send message' },
            { key: 'Shift + Enter', action: 'New line' },
        ]
    },

    // ─── Catalog ────────────────────────────────────────────
    catalog: {
        title: 'Catalog — Reference Database',
        intro: 'Browse all officers and ships in the game. Mark what you own, flag targets, and filter by any attribute.',
        sections: [
            {
                heading: 'Browsing',
                body: `
                    <p>Switch between <strong>Officers</strong> and <strong>Ships</strong> tabs. Each tab shows a count badge.</p>
                    <p><strong>Search</strong> filters by name in real-time (debounced). The <strong>A–Z alphabet bar</strong> jumps to names starting with that letter.</p>
                `
            },
            {
                heading: 'Filtering',
                body: `
                    <ul>
                        <li><strong>Ownership chips</strong> — filter by Owned, Unowned, or Targeted status</li>
                        <li><strong>Class dropdown</strong> (officers) — Command, Engineering, Science</li>
                        <li><strong>Hull type dropdown</strong> (ships) — Explorer, Interceptor, Battleship, Survey, etc.</li>
                    </ul>
                `
            },
            {
                heading: 'Cards',
                body: `
                    <p><strong>Officer cards</strong> show class, rarity, group, and faction badges, plus Captain Maneuver (CM), Officer Ability (OA), and Below Deck Ability (BD). Toggle <em>Owned</em> and <em>Target</em> with the card buttons.</p>
                    <p><strong>Ship cards</strong> show hull type, rarity, faction, grade, max tier, max level, and build time.</p>
                `
            },
            {
                heading: 'Bulk Actions',
                body: `
                    <p>Use the selection bar to <strong>Mark Owned</strong>, <strong>Mark Unowned</strong>, or <strong>Toggle Target</strong> on multiple items at once. An <em>Undo</em> option appears briefly after bulk changes.</p>
                `
            }
        ],
        tips: [
            'Use keyboard arrows to navigate cards, Space to toggle owned, T to toggle target',
            'Combine filters — e.g., "Unowned" + "Command" to find officers you still need',
            'Ownership and target flags are your personal overlays — they sync to your Fleet view',
        ],
        keys: [
            { key: 'Space', action: 'Toggle owned status' },
            { key: 'T', action: 'Toggle target status' },
            { key: '←→↑↓', action: 'Navigate between cards' },
        ]
    },

    // ─── Fleet ──────────────────────────────────────────────
    fleet: {
        title: 'Fleet — Your Roster',
        intro: 'Your owned officers and ships. Inline-edit levels, tiers, and power. See cross-references to loadouts and docks.',
        sections: [
            {
                heading: 'Roster',
                body: `
                    <p>Only items you've marked as <strong>owned</strong> (via Catalog) appear here. Switch between Officers and Ships tabs.</p>
                    <p>The <strong>stats bar</strong> shows count, average level, total power, and targeted items.</p>
                `
            },
            {
                heading: 'Inline Editing',
                body: `
                    <p>Click any <strong>level</strong>, <strong>rank</strong>, <strong>power</strong>, or <strong>tier</strong> field to edit it in-place. Changes save automatically on blur.</p>
                    <p>Add <strong>notes</strong> to any item — they'll appear in Aria's fleet context when she advises you.</p>
                `
            },
            {
                heading: 'Cross-References',
                body: `
                    <p>Each item shows where it's used:</p>
                    <ul>
                        <li>🔗 <strong>Reservations</strong> — soft/hard locks on officers</li>
                        <li>👥 <strong>Bridge Cores</strong> — which trios use this officer</li>
                        <li>📋 <strong>Policies</strong> — below-deck policies referencing this officer</li>
                        <li>⚠️ <strong>Conflicts</strong> — officer assigned to multiple active loadouts</li>
                        <li>⚓ <strong>Loadouts</strong> — which loadouts use this ship</li>
                        <li>🔧 <strong>Docks</strong> — which dock berths this ship is assigned to</li>
                    </ul>
                `
            },
            {
                heading: 'Sorting & View Mode',
                body: `
                    <p><strong>Sort</strong> by name, level, power, or rarity. Toggle between <strong>list</strong> and <strong>card</strong> view modes.</p>
                `
            }
        ],
        tips: [
            'Click any numeric field to edit inline — no save button needed',
            'Cross-reference badges tell you where each officer/ship is deployed',
            'Your fleet data is what Aria uses to give personalized advice',
        ],
        keys: []
    },

    // ─── Workshop (Crews) ──────────────────────────────────
    crews: {
        title: 'Workshop — Composition Workshop',
        intro: 'The comprehensive crew management view. Bridge cores, loadouts, policies, and reservations all in one place.',
        sections: [
            {
                heading: 'Bridge Cores',
                body: `
                    <p>A <strong>bridge core</strong> is a named group of three officers: <em>Captain</em>, <em>Bridge 1</em>, <em>Bridge 2</em>. These sit in a ship's bridge seats.</p>
                    <p><strong>"Used in" cross-references</strong> show which loadouts reference each core.</p>
                `
            },
            {
                heading: 'Loadouts',
                body: `
                    <p>A <strong>loadout</strong> is a complete ship configuration: which ship, bridge core, below-deck policy, and activity tags.</p>
                    <p>Full loadout management with inline variant expansion. Includes an <strong>intent picker</strong> with 21 predefined intents organized by category (mining, combat, utility).</p>
                    <p>Use the <strong>search</strong>, <strong>intent filter</strong>, and <strong>sort controls</strong> to find loadouts quickly.</p>
                `
            },
            {
                heading: 'Policies',
                body: `
                    <p>Controls how the below-deck crew is filled. Three modes:</p>
                    <ul>
                        <li><strong>Stats → BDA</strong> — fill by stats first, then below-deck abilities</li>
                        <li><strong>Pinned Only</strong> — use only the officers you've pinned</li>
                        <li><strong>Stats Fill Only</strong> — fill purely by stats, ignore abilities</li>
                    </ul>
                `
            },
            {
                heading: 'Reservations',
                body: `
                    <p>Officers can be <strong>reserved</strong> (locked to specific duties):</p>
                    <ul>
                        <li><strong>Soft lock</strong> — generates a warning if auto-assigned elsewhere</li>
                        <li><strong>Hard lock</strong> — prevents auto-assignment entirely</li>
                    </ul>
                    <p>Use reservations to protect key officers from being shuffled by preset changes.</p>
                `
            }
        ],
        tips: [
            'Name your bridge cores descriptively — "Kirk PvP Trio" is better than "Core 7"',
            'The "Used in" badges on bridge cores help track where trios are deployed',
            'Hard-lock your best officers to avoid accidental reassignment',
            'Use intents to tag what each loadout is for — Aria searches by intent',
        ],
        keys: []
    },

    // ─── Plan ───────────────────────────────────────────────
    plan: {
        title: 'Plan — Fleet State Dashboard',
        intro: 'The single source of truth for dock assignments, conflict detection, fleet presets, and docks management.',
        sections: [
            {
                heading: 'Effective State',
                body: `
                    <p>Shows every dock with its resolved assignment — which ship, crew, and policy are actually deployed. Each dock shows its <strong>source</strong>:</p>
                    <ul>
                        <li>🟢 <strong>Preset</strong> — assigned by the active fleet preset</li>
                        <li>🟡 <strong>Manual</strong> — manually assigned or overridden</li>
                    </ul>
                    <p><strong>Conflict alerts</strong> appear when the same officer is assigned to multiple active loadouts. Click to investigate.</p>
                `
            },
            {
                heading: 'Docks',
                body: `
                    <p>Docks are numbered berths (1–99) where ships are parked. Each dock has a label, lock state (🔒/🔓), and optional notes.</p>
                    <p><strong>Locked docks</strong> won't be reassigned when you activate a preset.</p>
                `
            },
            {
                heading: 'Fleet Presets',
                body: `
                    <p>Create and activate fleet-wide configurations. Activating a preset updates all non-locked docks at once.</p>
                `
            },
            {
                heading: 'Plan Items',
                body: `
                    <p>Manual assignments and objectives that supplement or override preset configurations.</p>
                `
            }
        ],
        tips: [
            'Start here to get a full picture of your fleet\'s current deployment',
            'Lock important docks to protect them from preset swaps',
            'Conflict alerts are your early warning system — resolve them before they cost you',
            'One-click preset activation makes switching fleet strategies fast',
        ],
        keys: []
    },

    // ─── Diagnostics ────────────────────────────────────────
    diagnostics: {
        title: 'Diagnostics — System Dashboard',
        intro: 'System health, data summary, query console, and schema browser. Admiral access only.',
        sections: [
            {
                heading: 'System Health',
                body: `
                    <p>Status of all subsystems: server version and uptime, Gemini engine (model, sessions), Lex memory (frame count), stores (reference, overlay, crew data counts).</p>
                `
            },
            {
                heading: 'Data Summary',
                body: `
                    <p>Breakdown of officers and ships by rarity, ship class, and overlay state (owned/unowned/targeted).</p>
                `
            },
            {
                heading: 'Query Console',
                body: `
                    <p>Run SQL queries against the database. Choose from <strong>6 preset queries</strong> or write custom SQL. Results display as a sortable table with row count and duration.</p>
                    <p>Query history saves your last 20 queries.</p>
                `
            },
            {
                heading: 'Schema Browser',
                body: `
                    <p>Explore the database schema — table structures, columns, and types.</p>
                `
            }
        ],
        tips: [
            'Use preset queries first — they cover the most common lookups',
            'The query console is read-only safe — SELECT only',
            'Check System Health after deployments or config changes',
        ],
        keys: []
    },

    // ─── Admiral Console ────────────────────────────────────
    admiral: {
        title: 'Admiral Console — Administration',
        intro: 'User management, invite codes, and session control. Admiral access only.',
        sections: [
            {
                heading: 'Users',
                body: `
                    <p>Manage user roles across four tiers:</p>
                    <ul>
                        <li><strong>Ensign</strong> — read-only catalog access</li>
                        <li><strong>Lieutenant</strong> — overlays, fleet read, limited chat</li>
                        <li><strong>Captain</strong> — full fleet management, unlimited chat</li>
                        <li><strong>Admiral</strong> — full system access, user management, diagnostics</li>
                    </ul>
                    <p>Lock or delete users, change roles. You cannot modify your own role.</p>
                `
            },
            {
                heading: 'Invites',
                body: `
                    <p>Generate <strong>invite codes</strong> for new users. Set max uses (1–100) and expiry (1 hour to 30 days). Copy the code to share, or revoke it at any time.</p>
                `
            },
            {
                heading: 'Sessions',
                body: `
                    <p>View active sessions with timestamps. Kill individual sessions or all sessions at once for security.</p>
                `
            }
        ],
        tips: [
            'Use short-lived invites (1h or 24h) for better security',
            'Kill all sessions if you suspect unauthorized access',
            'New users start as Ensign — promote them after verification',
        ],
        keys: []
    },
};

/**
 * Get help content for a view, with fallback to global.
 * @param {string|null} viewName
 * @returns {ViewHelp}
 */
export function getHelpForView(viewName) {
    return helpContent[viewName] || helpContent._global;
}

/**
 * Get the global (About) help content.
 * @returns {ViewHelp}
 */
export function getGlobalHelp() {
    return helpContent._global;
}

/**
 * Get all view names that have help content (excludes _global).
 * @returns {string[]}
 */
export function getHelpViewNames() {
    return Object.keys(helpContent).filter(k => k !== '_global');
}
