/**
 * proposals.ts — API module for ADR-026b safe mutation proposals (#93).
 */

import { apiFetch, apiPost, qs } from "./fetch.js";

// ─── Types ──────────────────────────────────────────────────

export interface ProposalSummary {
  id: string;
  tool: string;
  status: string;
  changesPreview?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  risk?: { bulkCount: number; warnings: string[] };
  expiresAt: string;
}

export interface ProposalDetail {
  id: string;
  tool: string;
  status: string;
  argsJson: Record<string, unknown>;
  argsHash: string;
  proposalJson: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  appliedAt: string | null;
  declinedAt: string | null;
}

// ─── API Functions ──────────────────────────────────────────

/** Create a new mutation proposal for the given tool + args. */
export async function createProposal(
  tool: string,
  args: Record<string, unknown>,
): Promise<ProposalSummary> {
  return apiPost<ProposalSummary>("/api/mutations/proposals", { tool, args });
}

/** Apply (confirm) a pending proposal. */
export async function applyProposal(
  id: string,
): Promise<{ applied: boolean; proposal_id: string; receipt_id: number }> {
  return apiPost<{ applied: boolean; proposal_id: string; receipt_id: number }>(
    `/api/mutations/proposals/${encodeURIComponent(id)}/apply`,
    {},
  );
}

/** Decline a pending proposal with an optional reason. */
export async function declineProposal(
  id: string,
  reason?: string,
): Promise<{ declined: boolean; proposal_id: string }> {
  return apiPost<{ declined: boolean; proposal_id: string }>(
    `/api/mutations/proposals/${encodeURIComponent(id)}/decline`,
    { reason },
  );
}

/** List proposals, optionally filtered by status and limited. */
export async function listProposals(
  status?: string,
  limit?: number,
): Promise<ProposalDetail[]> {
  return apiFetch<ProposalDetail[]>(
    `/api/mutations/proposals${qs({ status, limit })}`,
  );
}

/** Fetch a single proposal by ID. */
export async function getProposal(id: string): Promise<ProposalDetail> {
  return apiFetch<ProposalDetail>(
    `/api/mutations/proposals/${encodeURIComponent(id)}`,
  );
}
