/**
 * ax/diff.ts — Uncommitted changes summary.
 *
 * Flags: --staged (staged only), --main (diff against origin/main)
 */

import type { AxCommand, AxResult } from "./types.js";
import { hasFlag, runCapture, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "diff",
  description: "Uncommitted changes summary (--staged, --main)",

  async run(args): Promise<AxResult> {
    const start = Date.now();

    const staged = hasFlag(args, "staged");
    const main = hasFlag(args, "main");
    const base = main ? "origin/main" : staged ? "--cached" : "HEAD";

    const diffArgs = staged
      ? ["diff", "--cached", "--stat", "--no-color"]
      : ["diff", base === "HEAD" ? base : base, "--stat", "--no-color"];

    const stat = runCapture("git", diffArgs, { ignoreExit: true });

    // Full list of changed files with status
    const nameStatusArgs = staged
      ? ["diff", "--cached", "--name-status", "--no-color"]
      : ["diff", base, "--name-status", "--no-color"];
    const nameStatus = runCapture("git", nameStatusArgs, { ignoreExit: true });

    const changedFiles: Array<{ status: string; file: string; insertions?: number; deletions?: number }> = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    // Parse name-status output
    const statusLines = nameStatus.stdout.trim().split("\n").filter(Boolean);
    for (const line of statusLines) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const status = parts[0].charAt(0);
        const file = parts[parts.length - 1];
        changedFiles.push({
          status: status === "M" ? "modified" : status === "A" ? "added" : status === "D" ? "deleted" : status === "R" ? "renamed" : status,
          file,
        });
      }
    }

    // Parse stat for totals
    const statSummary = stat.stdout.trim().split("\n").pop() ?? "";
    const insMatch = statSummary.match(/(\d+)\s+insertion/);
    const delMatch = statSummary.match(/(\d+)\s+deletion/);
    totalInsertions = Number(insMatch?.[1] ?? 0);
    totalDeletions = Number(delMatch?.[1] ?? 0);

    // Per-file stats from numstat
    const numstatArgs = staged
      ? ["diff", "--cached", "--numstat", "--no-color"]
      : ["diff", base, "--numstat", "--no-color"];
    const numstat = runCapture("git", numstatArgs, { ignoreExit: true });
    const numstatLines = numstat.stdout.trim().split("\n").filter(Boolean);
    for (const line of numstatLines) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const file = parts[2];
        const entry = changedFiles.find(f => f.file === file);
        if (entry) {
          entry.insertions = parts[0] === "-" ? undefined : Number(parts[0]);
          entry.deletions = parts[1] === "-" ? undefined : Number(parts[1]);
        }
      }
    }

    return makeResult("diff", start, {
      base: main ? "origin/main" : staged ? "staged" : "HEAD",
      fileCount: changedFiles.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      files: changedFiles,
    });
  },
};

export default command;
