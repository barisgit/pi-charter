import type { ParsedEvidence } from "./charter-file";

export type CharterStatus = "active" | "paused" | "completed" | "abandoned";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
]);

export interface NextAction {
  tool: "charter" | "subagent";
  action?: string;
  hint: string;
  metadata?: Record<string, unknown>;
}

export interface CriterionSnapshot {
  id: string;
  title: string;
  depends: string[];
  evidence: ParsedEvidence;
  /** Sequence at which the current Evidence line was observed. */
  evidenceSeq: number;
}

export interface CharterState {
  charterId: string;
  schemaVersion: "file-interface";
  objective: string;
  status: CharterStatus;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  previousStatus?: CharterStatus;
  completedAt?: string;
  terminatedAt?: string;
  completionNote?: string;
  abandonReason?: string;
  /** Next monotonic sequence number for this charter/session. */
  nextSeq: number;
  /** Latest source-modifying sequence observed outside .charters/. */
  latestSourceSeq: number;
  snapshotHash: string;
  criteriaSnapshot: CriterionSnapshot[];
}

export interface CharterEvent {
  type: string;
  ts: string;
  charterId: string;
  seq?: number;
  [key: string]: unknown;
}
