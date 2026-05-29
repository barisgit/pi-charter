import { describe, expect, test } from "bun:test";
import { validateEvidenceFile } from "../src/domain/evidence-schemas";

describe("flat evidence schema", () => {
  test("flat evidence row is valid", () => {
    const result = validateEvidenceFile({
      criterionId: "VAL-EXAMPLE-001",
      outcome: "pass",
      summary: "Checks passed.",
      because: "Verifier exit code was zero.",
      source: "verifier",
      ts: "2026-05-21T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.criterionId).toBe("VAL-EXAMPLE-001");
  });

  test("legacy typed evidence kind is rejected", () => {
    const result = validateEvidenceFile({
      kind: "review",
      featureId: "f4-evidence-schemas",
      outcome: "pass",
      summary: "Legacy shape",
      ts: "2026-05-21T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Legacy typed evidence");
  });

  test("missing required field rejected", () => {
    const result = validateEvidenceFile({
      criterionId: "VAL-EXAMPLE-001",
      outcome: "pass",
      summary: "Missing ts.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ts");
  });

  test("bad outcome value rejected", () => {
    const result = validateEvidenceFile({
      criterionId: "VAL-EXAMPLE-001",
      outcome: "maybe",
      summary: "Invalid outcome.",
      ts: "2026-05-21T12:00:00.000Z",
    });
    expect(result.ok).toBe(false);
  });
});
