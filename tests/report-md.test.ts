import { describe, expect, test } from "bun:test";
import {
  checkReportCompletion,
  extractCharterTitleFromMarkdown,
  parseReportMarkdown,
  renderReportScaffold,
} from "../src/domain/report-md";

describe("report-md", () => {
  test("renderReportScaffold prefills title and objective with empty outcome and notes", () => {
    const markdown = renderReportScaffold({
      title: "OAuth callback",
      objective: "Ship the OAuth callback flow.",
    });
    expect(markdown).toContain("# OAuth callback");
    expect(markdown).toContain("## Objective");
    expect(markdown).toContain("Ship the OAuth callback flow.");
    expect(markdown).toContain("## Outcome");
    expect(markdown).toContain("## Notes");
    const check = checkReportCompletion(markdown);
    expect(check.ok).toBe(false);
    expect(check.emptySections).toEqual(["Outcome", "Notes"]);
  });

  test("checkReportCompletion requires non-empty content under every heading", () => {
    const filled = [
      "# OAuth callback",
      "",
      "## Objective",
      "",
      "Ship the OAuth callback flow.",
      "",
      "## Outcome",
      "",
      "Callback shipped.",
      "",
      "## Notes",
      "",
      "None.",
      "",
    ].join("\n");
    expect(checkReportCompletion(filled).ok).toBe(true);

    const missingNotes = filled.replace("None.", "");
    const check = checkReportCompletion(missingNotes);
    expect(check.ok).toBe(false);
    expect(check.failures).toContain("REPORT.md: Notes section is empty");
  });

  test("extractCharterTitleFromMarkdown reads Charter: prefix", () => {
    expect(extractCharterTitleFromMarkdown("# Charter: pi-charter-v3-refactor\n")).toBe("pi-charter-v3-refactor");
    expect(extractCharterTitleFromMarkdown("# OAuth callback\n")).toBe("OAuth callback");
  });

  test("parseReportMarkdown round-trips scaffold sections", () => {
    const scaffold = renderReportScaffold({ title: "Probe", objective: "Objective text." });
    expect(parseReportMarkdown(scaffold)).toEqual({
      title: "Probe",
      objective: "Objective text.",
      outcome: "",
      notes: "",
    });
  });
});
