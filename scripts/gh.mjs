#!/usr/bin/env node
/**
 * gh.mjs — lightweight GitHub issue/PR helper for AI agents
 *
 * Usage:
 *   npm run gh issues              # list open issues
 *   npm run gh issues -- --all     # include closed
 *   npm run gh issues -- --label=ui
 *   npm run gh prs                 # list open PRs
 *   npm run gh issue 61            # show single issue detail
 *   npm run gh close 61 "Done in abc123"  # close with comment
 *   npm run gh comment 61 "Ship it"       # add comment
 *   npm run gh labels              # list available labels
 *
 * Reads token from MCP_GITHUB_TOKEN, MCP_GITHUB_PAT, or GITHUB_TOKEN.
 *
 * @module scripts/gh
 */

const OWNER = 'Guffawaffle';
const REPO = 'majel';
const API = 'https://api.github.com';

const token = process.env.MCP_GITHUB_TOKEN
    || process.env.MCP_GITHUB_PAT
    || process.env.GITHUB_TOKEN;

if (!token) {
    console.error('❌ No GitHub token found. Set MCP_GITHUB_TOKEN, MCP_GITHUB_PAT, or GITHUB_TOKEN.');
    process.exit(1);
}

const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, opts = {}) {
    const url = path.startsWith('http') ? path : `${API}/repos/${OWNER}/${REPO}${path}`;
    const res = await fetch(url, { headers, ...opts });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
}

// ── Commands ──────────────────────────────────────────────

async function listIssues(flags) {
    const state = flags.all ? 'all' : 'open';
    const label = flags.label || '';
    const params = new URLSearchParams({ state, per_page: '50', sort: 'created', direction: 'desc' });
    if (label) params.set('labels', label);
    const issues = await api(`/issues?${params}`);

    // Filter out PRs (GitHub lists PRs as issues too)
    const filtered = issues.filter(i => !i.pull_request);

    if (filtered.length === 0) {
        console.log('No issues found.');
        return;
    }

    const maxNum = Math.max(...filtered.map(i => String(i.number).length));
    for (const i of filtered) {
        const num = `#${String(i.number).padStart(maxNum)}`;
        const labels = (i.labels || []).map(l => l.name).join(', ');
        const state_icon = i.state === 'open' ? '○' : '●';
        const labelStr = labels ? ` [${labels}]` : '';
        console.log(`${state_icon} ${num}  ${i.title}${labelStr}`);
    }
    console.log(`\n${filtered.length} issue(s)`);
}

async function listPRs(flags) {
    const state = flags.all ? 'all' : 'open';
    const params = new URLSearchParams({ state, per_page: '30', sort: 'created', direction: 'desc' });
    const prs = await api(`/pulls?${params}`);

    if (prs.length === 0) {
        console.log('No pull requests found.');
        return;
    }

    for (const pr of prs) {
        const icon = pr.state === 'open' ? '○' : pr.merged_at ? '◉' : '●';
        const labels = (pr.labels || []).map(l => l.name).join(', ');
        const labelStr = labels ? ` [${labels}]` : '';
        console.log(`${icon} #${pr.number}  ${pr.title}${labelStr}`);
    }
    console.log(`\n${prs.length} PR(s)`);
}

async function showIssue(number) {
    const issue = await api(`/issues/${number}`);
    const labels = (issue.labels || []).map(l => l.name).join(', ');
    console.log(`#${issue.number} — ${issue.title}`);
    console.log(`State: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ''}`);
    if (labels) console.log(`Labels: ${labels}`);
    console.log(`Created: ${issue.created_at}`);
    if (issue.closed_at) console.log(`Closed: ${issue.closed_at}`);
    console.log(`Comments: ${issue.comments}`);
    console.log('---');
    console.log(issue.body || '(no body)');
}

async function closeIssue(number, comment) {
    if (comment) {
        await api(`/issues/${number}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body: comment }),
        });
    }
    await api(`/issues/${number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
    console.log(`✅ #${number} closed${comment ? ' with comment' : ''}`);
}

async function addComment(number, body) {
    await api(`/issues/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
    });
    console.log(`💬 Comment added to #${number}`);
}

async function listLabels() {
    const labels = await api('/labels?per_page=100');
    for (const l of labels) {
        console.log(`  ${l.name}`);
    }
    console.log(`\n${labels.length} label(s)`);
}

// ── CLI Parser ────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
    args.filter(a => a.startsWith('--')).map(a => {
        const [k, v] = a.slice(2).split('=');
        return [k, v ?? true];
    })
);

try {
    switch (command) {
        case 'issues':
        case 'i':
            await listIssues(flags);
            break;
        case 'prs':
        case 'pr':
            await listPRs(flags);
            break;
        case 'issue':
        case 'show':
            if (!positional[1]) { console.error('Usage: gh issue <number>'); process.exit(1); }
            await showIssue(positional[1]);
            break;
        case 'close':
            if (!positional[1]) { console.error('Usage: gh close <number> [comment]'); process.exit(1); }
            await closeIssue(positional[1], positional[2] || null);
            break;
        case 'comment':
            if (!positional[1] || !positional[2]) { console.error('Usage: gh comment <number> <body>'); process.exit(1); }
            await addComment(positional[1], positional[2]);
            break;
        case 'labels':
            await listLabels();
            break;
        default:
            console.log(`Usage: npm run gh <command>

Commands:
  issues [--all] [--label=X]   List issues (default: open)
  prs [--all]                  List pull requests
  issue <number>               Show issue detail
  close <number> [comment]     Close issue with optional comment
  comment <number> <body>      Add comment to issue
  labels                       List available labels

Aliases: i=issues, pr=prs, show=issue`);
    }
} catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
}
