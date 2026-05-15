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
  objective: string;
  status: CharterStatus;
  createdAt: string;
  updatedAt: string;
  charterDigest?: string;
  planDigest?: string;
  sessionId?: string;
  budget?: Budget;
  previousStatus?: CharterStatus;
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
