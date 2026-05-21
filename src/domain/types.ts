export type CharterStatus =
  | "planning"
  | "active"
  | "review"
  | "paused"
  | "completed"
  | "budget_limited"
  | "abandoned";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "budget_limited",
  "abandoned",
]);

export interface NextAction {
  tool: "charter_manage" | "charter_plan" | "charter_record" | "charter_status" | "subagent";
  action?: string;
  hint: string;
  /**
   * Optional structured metadata for tool-specific routing. Currently used by
   * milestone-review next actions ({ milestoneId, criterionIds }) so the
   * agent can spawn a charter-reviewer subagent with the right scope without
   * re-parsing the hint string.
   */
  metadata?: Record<string, unknown>;
}

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
  /**
   * Tri-state: `true`/`false` when the charter.md criterion explicitly sets
   * `Review subagent required:`, `undefined` when the line is omitted. The
   * completion gate uses the explicit-vs-omitted distinction to auto-default
   * the flag to true for VALs covered by a `milestone_ready_for_review`
   * event (see `effectiveRequireReviewSubagent` in service.ts). Authors who
   * want to opt OUT of the auto-default must write `Review subagent required: false`.
   */
  requireReviewSubagent: boolean | undefined;
  /**
   * Criterion-level author note ("why this verifier is sufficient"). Distinct
   * from the per-evidence `because` on EvidenceRecord: this annotation is set
   * once at charter-authoring time and read by the lock_plan weak-verifier
   * check (manual+no-because BLOCKs unless the charter is loaded as legacy).
   */
  because?: string;
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
  qaSection?: string;
  readinessSection?: string;
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
