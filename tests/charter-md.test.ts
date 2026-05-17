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
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);
  });
});
