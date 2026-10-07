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

export interface RalphGuardState {
  activations: number[];
  warnedAt?: number;
  pausedByGuard?: boolean;
}

export interface CharterState {
  charterId: string;
  /**
   * Storage discriminator. `"phases"` is a historical label for every writable
   * charter (ADR-0018 removed the phase feature but kept the persisted shape, so
   * existing charters resume without migration). `"file-interface"` marks
   * read-only legacy history.
   */
  schemaVersion: "phases" | "file-interface";
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
  snapshotHash?: string;
  ralph?: RalphGuardState;
}

export interface CharterEvent {
  type: string;
  ts: string;
  charterId: string;
  [key: string]: unknown;
}
