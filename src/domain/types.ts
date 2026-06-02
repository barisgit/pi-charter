import type { Verifier, VerifierKind } from "./verifier";
export type { EvidenceExistsVerifier, SubagentVerifier, Verifier, VerifierKind } from "./verifier";

export type CharterStatus = "active" | "paused" | "completed" | "abandoned";

/** Legacy statuses persisted by v2 charters; normalized on read to v3. */
export type LegacyCharterStatus =
  | "planning"
  | "review"
  | "awaiting-clarification"
  | "budget_limited";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
]);

export type CharterSchemaVersion = "v2" | "v1-needs-replan";

export interface NextAction {
  tool: "charter" | "charter_record" | "charter_status" | "subagent";
  action?: string;
  hint: string;
  /** Optional structured metadata for tool-specific routing. */
  metadata?: Record<string, unknown>;
}

export interface Budget {
  tokens?: number;
  wallclockMs?: number;
  turns?: number;
}

export type CharterCommands = Record<string, string>;



export interface CharterState {
  charterId: string;
  schemaVersion?: CharterSchemaVersion;
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
  sessionId?: string;
  budget?: Budget;
  previousStatus?: CharterStatus;
  completedAt?: string;
  terminatedAt?: string;
  completionReason?: string;
  /** ISO timestamp of the last pi-charter tool write to this sidecar. */
  lastToolWriteAt?: string;
}


export interface CharterCriterion {
  id: string;
  title: string;
  description?: string;
  verifier: VerifierKind;
  verifierSpec?: Verifier;
  command?: string;
  requireFreshEvidence: boolean;
  /**
   * Tri-state: `true`/`false` when the charter.md criterion explicitly sets
   * `Review subagent required:`, `undefined` when the line is omitted. This is
   * a display-only authoring annotation; it does not block completion.
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

export type ParseWarningReason = "missing-verifier" | "invalid-verifier" | "missing-because" | "duplicate-command" | "malformed-command" | "weak-verifier-phrase-coupled";

export interface ParseWarning {
  criterionId?: string;
  reason: ParseWarningReason;
  section?: string;
  key?: string;
  line?: string;
  /** Human-readable specifics, e.g. the validator error for invalid-verifier. */
  detail?: string;
}

export interface CharterMilestone {
  id: string;
  title: string;
  criterionIds: string[];
}

export interface ParsedCharterMarkdown {
  objective: string;
  criteria: CharterCriterion[];
  milestones: CharterMilestone[];
  constraints: string[];
  commands: CharterCommands;
  qaSection?: string;
  readinessSection?: string;
  warnings: ParseWarning[];
}

/**
 * Identity of the actor that produced an evidence record. Distinguishing the
 * root agent from a delegated subagent (or a human) is surfaced for display and
 * audit; per ADR-0013 it is not a completion gate (no identity-disjoint review).
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
  /** Required: who wrote this record. Populated at every recordEvidence/recordEvidenceFromFile call site. */
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
