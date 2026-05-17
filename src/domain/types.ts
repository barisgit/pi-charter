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

export type ParseWarningReason = "missing-verifier" | "missing-because";

export interface ParseWarning {
  criterionId: string;
  reason: ParseWarningReason;
}

export interface ParsedCharterMarkdown {
  objective: string;
  criteria: CharterCriterion[];
  constraints: string[];
  warnings: ParseWarning[];
}

/**
 * Identity of the actor that produced an evidence record. Distinguishing the
 * root agent from a delegated subagent (or a human) is what lets the
 * completion gate enforce identity-disjoint review without re-deriving the
 * writer from event history.
 */
export type RecordedBy = `agent:root` | `subagent:${string}:${string}` | `user`;

export type EvidenceSource = "manual" | "verifier" | "hook" | "subagent";

export interface EvidenceRecord {
  charterId: string;
  criterionId: string;
  featureId?: string;
  outcome: "pass" | "fail" | "partial";
  summary: string;
  artifacts: string[];
  details: Record<string, unknown>;
  source: EvidenceSource;
  /** Required: who wrote this record. Populated at every recordEvidence/verifyCriterion/applyHandoff call site. */
  recordedBy: RecordedBy;
  /** Optional rationale; REQUIRED when source === 'manual'. */
  because?: string;
  verifier: VerifierKind;
  ts: string;
}

export interface CharterEvent {
  type: string;
  ts: string;
  charterId: string;
  [key: string]: unknown;
}
