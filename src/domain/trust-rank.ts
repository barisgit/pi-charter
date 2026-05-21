import type { EvidenceSource } from "./types";

export interface TrustRankInput {
  recordedBy: string;
  source: EvidenceSource;
  hasBecause: boolean;
}

/**
 * Integer ranking of evidence trustworthiness consumed by the completion gate.
 *
 * Ordering: subagent (3) > command|hook (2) > manual+because (1) > manual (0).
 * Subagent records ignore `hasBecause` because the review itself covers
 * rationale; we'd otherwise punish good handoffs with strict-but-empty
 * `because` propagation rules.
 */
export function trustRank(input: TrustRankInput): number {
  switch (input.source) {
    case "subagent":
      return 3;
    case "verifier":
    case "hook":
      return 2;
    case "manual":
      return input.hasBecause ? 1 : 0;
    default:
      return assertNever(input.source);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled evidence source: ${String(value)}`);
}
