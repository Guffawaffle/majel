/**
 * ax/pm-sweep.ts — GitHub PM sweep: issues vs commits vs BACKLOG
 *
 * Cross-references open GitHub issues with local git history and
 * BACKLOG.md status tables. Reports discrepancies:
 *   - Issues that appear done (referenced in commits) but are still open
 *   - BACKLOG entries marked done with no matching commit
 *   - Issues not mentioned in BACKLOG at all
 *
 * Uses stderr for progress, stdout for structured JSON result.
 *
 * Requires: GITHUB_TOKEN, MCP_GITHUB_TOKEN, or MCP_GITHUB_PAT.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { makeResult, runCapture, ROOT, hasFlag, getFlag } from "./runner.js";

// ─── GitHub API ─────────────────────────────────────────────────

const OWNER = "Guffawaffle";
const REPO = "majel";
const API = "https://api.github.com";

interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

function resolveToken(): string | undefined {
  return (
    process.env.MCP_GITHUB_TOKEN ||
    process.env.MCP_GITHUB_PAT ||
    process.env.GITHUB_TOKEN
  );
}

async function fetchIssues(
  token: string,
  state: "open" | "closed" | "all",
): Promise<GitHubIssue[]> {
  const all: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${API}/repos/${OWNER}/${REPO}/issues?state=${state}&per_page=${perPage}&page=${page}&sort=created&direction=desc`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }

    const issues: GitHubIssue[] = await res.json();
    // Filter out PRs (GitHub /issues endpoint returns PRs too)
    const filtered = issues.filter((i) => !i.pull_request);
    all.push(...filtered);

    if (issues.length < perPage) break;
    page++;
  }

  return all;
}

// ─── Git history scanning ───────────────────────────────────────

interface CommitRef {
  sha: string;
  message: string;
  issueNumbers: number[];
}

function scanCommits(since?: string): CommitRef[] {
  const gitArgs = ["log", "--oneline", "--all"];
  if (since) gitArgs.push(`--since=${since}`);

  const result = runCapture("git", gitArgs, { ignoreExit: true });
  if (result.exitCode !== 0) return [];

  const issuePattern = /#(\d+)/g;
  const commits: CommitRef[] = [];

  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const sha = line.slice(0, 7);
    const message = line.slice(8);
    const matches = [...message.matchAll(issuePattern)];
    const issueNumbers = matches.map((m) => parseInt(m[1], 10));
    if (issueNumbers.length > 0) {
      commits.push({ sha, message, issueNumbers });
    }
  }

  return commits;
}

// ─── BACKLOG.md parsing ─────────────────────────────────────────

interface BacklogEntry {
  issueNumber: number;
  title: string;
  status: "done" | "in-progress" | "not-started" | "deferred";
  commitSha?: string;
  section: string;
}

function parseBacklog(): BacklogEntry[] {
  const backlogPath = join(ROOT, "BACKLOG.md");
  let content: string;
  try {
    content = readFileSync(backlogPath, "utf-8");
  } catch {
    return [];
  }

  const entries: BacklogEntry[] = [];
  // Track which section we're in
  let currentSection = "";

  for (const line of content.split("\n")) {
    // Track section headers
    if (line.startsWith("## ")) {
      currentSection = line.replace(/^## /, "").trim();
      continue;
    }

    // Match table rows: | Slice/Phase | #NNN | Title | [x] Done `sha` |
    const tableMatch = line.match(
      /\|\s*\d+\s*\|\s*#(\d+)\s*\|\s*(.+?)\s*\|\s*\[([x~—\s])\]\s*(.*?)\s*\|/,
    );
    if (!tableMatch) continue;

    const issueNumber = parseInt(tableMatch[1], 10);
    const title = tableMatch[2].trim();
    const marker = tableMatch[3];
    const statusText = tableMatch[4];
    const shaMatch = statusText.match(/`([a-f0-9]{7,})`/);

    let status: BacklogEntry["status"];
    switch (marker) {
      case "x":
        status = "done";
        break;
      case "~":
        status = "in-progress";
        break;
      case "—":
        status = "deferred";
        break;
      default:
        status = "not-started";
    }

    entries.push({
      issueNumber,
      title,
      status,
      commitSha: shaMatch?.[1],
      section: currentSection,
    });
  }

  return entries;
}

// ─── Discrepancy analysis ───────────────────────────────────────

interface Discrepancy {
  type:
    | "open-but-committed"
    | "backlog-done-no-commit"
    | "issue-not-in-backlog"
    | "backlog-stale"
    | "closed-but-backlog-open";
  issueNumber: number;
  title: string;
  detail: string;
}

function analyze(
  openIssues: GitHubIssue[],
  closedIssues: GitHubIssue[],
  commits: CommitRef[],
  backlog: BacklogEntry[],
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Build lookup maps
  const committedIssues = new Map<number, CommitRef[]>();
  for (const c of commits) {
    for (const n of c.issueNumbers) {
      if (!committedIssues.has(n)) committedIssues.set(n, []);
      committedIssues.get(n)!.push(c);
    }
  }

  const backlogByIssue = new Map<number, BacklogEntry>();
  for (const b of backlog) backlogByIssue.set(b.issueNumber, b);

  const closedNumbers = new Set(closedIssues.map((i) => i.number));

  // 1. Open issues that have commits referencing them
  for (const issue of openIssues) {
    const refs = committedIssues.get(issue.number);
    if (refs && refs.length > 0) {
      const shas = refs.map((r) => r.sha).join(", ");
      discrepancies.push({
        type: "open-but-committed",
        issueNumber: issue.number,
        title: issue.title,
        detail: `Open on GitHub but referenced in commits: ${shas}`,
      });
    }
  }

  // 2. BACKLOG says done but no commit found
  for (const entry of backlog) {
    if (entry.status === "done" && entry.commitSha) {
      // Verify the commit SHA actually exists
      const check = runCapture("git", ["cat-file", "-t", entry.commitSha], {
        ignoreExit: true,
      });
      if (check.exitCode !== 0) {
        discrepancies.push({
          type: "backlog-done-no-commit",
          issueNumber: entry.issueNumber,
          title: entry.title,
          detail: `BACKLOG says done with ${entry.commitSha} but commit not found in git`,
        });
      }
    }
  }

  // 3. Open issues not in BACKLOG at all
  for (const issue of openIssues) {
    if (!backlogByIssue.has(issue.number)) {
      discrepancies.push({
        type: "issue-not-in-backlog",
        issueNumber: issue.number,
        title: issue.title,
        detail: "Open on GitHub but not tracked in BACKLOG.md",
      });
    }
  }

  // 4. BACKLOG says not-started/in-progress but issue is closed on GitHub
  for (const entry of backlog) {
    if (
      (entry.status === "not-started" || entry.status === "in-progress") &&
      closedNumbers.has(entry.issueNumber)
    ) {
      discrepancies.push({
        type: "backlog-stale",
        issueNumber: entry.issueNumber,
        title: entry.title,
        detail: `BACKLOG says "${entry.status}" but #${entry.issueNumber} is closed on GitHub`,
      });
    }
  }

  // 5. BACKLOG says done but issue still open on GitHub
  for (const entry of backlog) {
    if (entry.status === "done") {
      const stillOpen = openIssues.find(
        (i) => i.number === entry.issueNumber,
      );
      if (stillOpen) {
        discrepancies.push({
          type: "closed-but-backlog-open",
          issueNumber: entry.issueNumber,
          title: entry.title,
          detail: `BACKLOG says done but #${entry.issueNumber} is still open on GitHub`,
        });
      }
    }
  }

  return discrepancies;
}

// ─── Command ────────────────────────────────────────────────────

const command: AxCommand = {
  name: "pm:sweep",
  description:
    "GitHub PM sweep: cross-reference issues, commits, and BACKLOG.md",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const verbose = hasFlag(args, "verbose");
    const since = getFlag(args, "since") ?? "90d";

    // ─── Token check ────────────────────────────────────
    const token = resolveToken();
    if (!token) {
      return makeResult("pm:sweep", start, {}, {
        success: false,
        errors: ["No GitHub token found"],
        hints: [
          "Set GITHUB_TOKEN, MCP_GITHUB_TOKEN, or MCP_GITHUB_PAT",
        ],
      });
    }

    // ─── Fetch issues ───────────────────────────────────
    if (verbose) console.error("⏳ Fetching open issues from GitHub...");
    const openIssues = await fetchIssues(token, "open");
    if (verbose) console.error(`   ${openIssues.length} open issue(s)`);

    if (verbose)
      console.error("⏳ Fetching recently closed issues from GitHub...");
    const closedIssues = await fetchIssues(token, "closed");
    if (verbose) console.error(`   ${closedIssues.length} closed issue(s)`);

    // ─── Scan git history ───────────────────────────────
    if (verbose)
      console.error(`⏳ Scanning git history (since ${since})...`);
    const commits = scanCommits(since);
    if (verbose)
      console.error(
        `   ${commits.length} commit(s) referencing issues`,
      );

    // ─── Parse BACKLOG.md ───────────────────────────────
    if (verbose) console.error("⏳ Parsing BACKLOG.md...");
    const backlog = parseBacklog();
    if (verbose)
      console.error(`   ${backlog.length} tracked entries`);

    // ─── Analyze ────────────────────────────────────────
    const discrepancies = analyze(
      openIssues,
      closedIssues,
      commits,
      backlog,
    );

    // ─── Progress summary (always on stderr) ────────────
    console.error(
      `\n📋 PM Sweep: ${openIssues.length} open, ${closedIssues.length} closed, ${commits.length} issue-commits, ${backlog.length} backlog entries`,
    );
    if (discrepancies.length === 0) {
      console.error("✅ No discrepancies found");
    } else {
      console.error(
        `⚠️  ${discrepancies.length} discrepancy(ies) found:`,
      );
      for (const d of discrepancies) {
        console.error(
          `   ${d.type}: #${d.issueNumber} — ${d.detail}`,
        );
      }
    }

    // ─── Result ─────────────────────────────────────────
    return makeResult(
      "pm:sweep",
      start,
      {
        openIssues: openIssues.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels.map((l) => l.name),
          updatedAt: i.updated_at,
        })),
        closedIssueCount: closedIssues.length,
        commitsWithIssueRefs: commits.length,
        backlogEntries: backlog.length,
        discrepancies,
        discrepancyCount: discrepancies.length,
      },
      {
        success: true,
      },
    );
  },
};

export default command;
