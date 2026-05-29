import { describe, expect, test } from "bun:test";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";

function flatEvidence(artifacts?: string[]) {
  return {
    criterionId: "VAL-ARTIFACTS-001",
    outcome: "pass" as const,
    summary: "Flat evidence with artifact paths.",
    because: "Artifacts are optional string paths on the flat row.",
    ts: "2026-05-21T12:00:00.000Z",
    ...(artifacts ? { artifacts } : {}),
  };
}

describe("flat evidence artifacts", () => {
  test("accepts relative artifact paths", () => {
    const result = validateEvidenceFile(flatEvidence(["captures/homepage.png", "captures/trace.zip"]));
    expect(result.ok).toBe(true);
  });

  test("accepts empty artifacts array", () => {
    const result = validateEvidenceFile(flatEvidence([]));
    expect(result.ok).toBe(true);
  });

  test("rejects legacy typed qa evidence", () => {
    const result = validateEvidenceFile({
      kind: "qa",
      featureId: "f1-artifacts-schema",
      outcome: "pass",
      summary: "Legacy shape",
      ts: "2026-05-21T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Legacy typed evidence");
  });
});
