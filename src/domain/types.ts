export type CharterStatus =
  | "planning"
  | "active"
  | "review"
  | "paused"
  | "completed"
  | "budget_limited"
  | "abandoned";

export type VerifierKind = "command" | "hook" | "prompt" | "manual";

export interface Budget {
  tokens?: number;
  wallclockMs?: number;
  turns?: number;
}

export interface CharterState {
  charterId: string;
  /**
   * Optional short human-friendly slug shown in widget headers and status
   * output. When absent, callers should fall back to `charterId.slice(0,8)`.
   * Set at creation time; never mutated by lifecycle transitions.
   */
  name?: string;
  objective: string;
  status: CharterStatus;
  createdAt: string;
  updatedAt: string;
  charterDigest?: string;
  planDigest?: string;
  sessionId?: string;
  budget?: Budget;
  previousStatus?: CharterStatus;
  completedAt?: string;
  terminatedAt?: string;
  completionReason?: string;
}

export interface CharterCriterion {
  id: string;
  title: string;
  description?: string;
  verifier: VerifierKind;
  command?: string;
  requireFreshEvidence: boolean;
  requireReviewSubagent: boolean;
}

export interface ParsedCharterMarkdown {
  objective: string;
  criteria: CharterCriterion[];
  constraints: string[];
}

export interface CharterEvent {
  type: string;
  ts: string;
  charterId: string;
  [key: string]: unknown;
}
