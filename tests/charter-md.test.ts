import { describe, expect, test } from "bun:test";
import { parseCharterMarkdown } from "../src/domain/charter-md";

describe("parseCharterMarkdown warnings", () => {
  test("legacy criterion missing Verifier: line parses without throwing and emits a missing-verifier warning", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "Legacy objective.",
      "",
      "## Criteria",
      "",
      "### VAL-LEGACY-001 — Old criterion with no verifier line",
      "Description: This criterion predates the Verifier requirement.",
      "Fresh evidence required: false",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0].id).toBe("VAL-LEGACY-001");
    expect(parsed.warnings).toEqual([
      { criterionId: "VAL-LEGACY-001", reason: "missing-verifier" },
    ]);
  });

  test("manual criterion without Because: emits a missing-because warning", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "weak.",
      "",
      "## Criteria",
      "",
      "### VAL-W-001 — Weak manual",
      "Verifier: manual",
      "",
      "### VAL-W-002 — Strong manual",
      "Verifier: manual",
      "Because: author note",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.criteria[1].because).toBe("author note");
    expect(parsed.warnings).toEqual([
      { criterionId: "VAL-W-001", reason: "missing-because" },
    ]);
  });

  test("old-style criteria parse without throwing; warnings include missing-verifier", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "legacy.",
      "",
      "## Criteria",
      "",
      "### VAL-LEG-001 — Legacy 1",
      "Description: old style",
      "",
      "### VAL-LEG-002 — Legacy 2",
      "Description: also old style",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);
    expect(parsed.criteria).toHaveLength(2);
    const reasons = parsed.warnings.map((w) => `${w.criterionId}:${w.reason}`).sort();
    expect(reasons).toEqual([
      "VAL-LEG-001:missing-verifier",
      "VAL-LEG-002:missing-verifier",
    ]);
  });

  test("modern criteria with explicit Verifier: emit zero warnings", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "Modern objective.",
      "",
      "## Criteria",
      "",
      "### VAL-MOD-001 — Modern criterion",
      "Description: Modern criterion has a verifier.",
      "Verifier: command",
      "Command: echo hi",
      "",
      "### VAL-MOD-002 — Another modern criterion",
      "Description: Also has a verifier.",
      "Verifier: manual",
      "Because: author note",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);
  });
});
