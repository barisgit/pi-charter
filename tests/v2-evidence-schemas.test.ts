import { describe, expect, test } from "bun:test";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";

describe("v2 evidence schemas", () => {
  test("command-kind-valid", () => {
    const result = validateEvidenceFile({
      kind: "command",
      featureId: "f4-evidence-schemas",
      ts: "2026-05-21T12:00:00.000Z",
      checkResults: {
        "check-types": {
          outcome: "pass",
          exitCode: 0,
          stdoutHead: "tsc clean",
          durationMs: 1200,
        },
      },
      summary: "Command checks passed.",
      because: "The check result records exit code 0 for the required command.",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "command") {
      expect(result.value.checkResults["check-types"].outcome).toBe("pass");
    }
  });

  test("review-kind-valid", () => {
    const result = validateEvidenceFile({
      kind: "review",
      featureId: "f4-evidence-schemas",
      round: 1,
      reviewedAt: "2026-05-21T12:05:00.000Z",
      subagentSessionId: "review-session-1",
      commitId: "abc123",
      outcome: "partial",
      blockingIssues: [
        { file: "src/domain/evidence-schemas.ts", line: 12, description: "Example issue." },
      ],
      nonBlockingNotes: ["Consider adding integration once evidenceFile import exists."],
      summary: "Review completed with one blocking issue.",
      because: "The review file includes the required round, session, findings, and rationale.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("review");
  });

  test("qa-kind-valid", () => {
    const result = validateEvidenceFile({
      kind: "qa",
      featureId: "f4-evidence-schemas",
      milestone: "m2-evidence",
      surfaces: ["charter_record evidence import"],
      outcome: "pass",
      screenshots: [".pi/charters/cha/evidence/f4/qa.png"],
      findings: [
        { severity: "low", description: "No UI surface for this feature." },
      ],
      summary: "QA evidence shape is valid.",
      because: "The QA record captures milestone, surfaces, screenshots, findings, and outcome.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("qa");
  });

  test("readiness-kind-valid", () => {
    const result = validateEvidenceFile({
      kind: "readiness",
      featureId: "f4-evidence-schemas",
      probeResult: "deferred-with-fallback",
      probedAt: "2026-05-21T12:10:00.000Z",
      details: { dependency: "typebox", fallback: "Validated with local schema tests." },
      summary: "Readiness probe recorded fallback.",
      because: "The probe result and details explain why work can proceed.",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("readiness");
  });

  test("unknown-kind-rejected", () => {
    const result = validateEvidenceFile({ kind: "mystery", featureId: "f4" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown evidence kind");
  });

  test("missing-required-field-rejected", () => {
    const result = validateEvidenceFile({
      kind: "command",
      featureId: "f4-evidence-schemas",
      ts: "2026-05-21T12:00:00.000Z",
      summary: "Missing check results.",
      because: "This should fail because checkResults is required.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("command");
  });

  test("bad-outcome-value-rejected", () => {
    const result = validateEvidenceFile({
      kind: "qa",
      featureId: "f4-evidence-schemas",
      milestone: "m2-evidence",
      surfaces: ["schema validation"],
      outcome: "maybe",
      screenshots: [],
      findings: [],
      summary: "Invalid QA outcome.",
      because: "Only pass, fail, or partial are valid outcomes.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("qa");
  });
});
