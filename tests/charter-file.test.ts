import { describe, expect, test } from "bun:test";
import { parseCharterFile } from "../src/domain/charter-file";
import { renderCharterTemplate } from "../src/domain/template";

describe("charter.md Objective parser", () => {
  test("Objective subheadings preserve constraints until a recognized charter section", () => {
    const objective = "Ship the recovery flow.\n\n## Constraints\n\nDo not change login.\n\n### Verification\n\nVerify desktop and mobile widths.\n\n#### Evidence\n\nCapture both views.";
    const parsed = parseCharterFile(`# Objective\n\n${objective}\n\n## References\n\nApproved plan.\n\n### Authority\n\nAll requirements remain binding.\n\n## Scope\n\nWeb only.\n`);
    expect(parsed).toEqual({
      objective,
      references: "Approved plan.\n\n### Authority\n\nAll requirements remain binding.",
      scope: "Web only.",
      notes: "",
      warnings: [],
    });
  });

  test("an unrelated top-level heading still ends the Objective", () => {
    expect(parseCharterFile("# Objective\n\nShip.\n\n### Constraints\n\nPreserve login.\n\n# Appendix\n\nOther notes.\n").objective)
      .toBe("Ship.\n\n### Constraints\n\nPreserve login.");
  });

  test("notes and historical phase sections stay inert Markdown outside the Objective", () => {
    const parsed = parseCharterFile([
      "# Objective", "", "Ship it.", "",
      "## Scope", "", "Core only.", "",
      "## Phases", "", "1. Explore — done", "   Findings.", "2. Build — current", "",
      "## Notes", "", "Remember the cache.",
    ].join("\n"));
    expect(parsed).toEqual({
      objective: "Ship it.", references: "", scope: "Core only.",
      notes: "## Phases\n\n1. Explore — done\n   Findings.\n2. Build — current\n\n## Notes\n\nRemember the cache.",
      warnings: [],
    });
    const notesFirst = parseCharterFile("# Objective\n\nShip it.\n\n## Notes\n\nScratch.\n\n## Phases\n\n1. Old route\n");
    expect(notesFirst.objective).toBe("Ship it.");
    expect(notesFirst.notes).toBe("## Notes\n\nScratch.\n\n## Phases\n\n1. Old route");
  });

  test("a new charter has the Objective and optional References/Scope without a phase scaffold", () => {
    const markdown = renderCharterTemplate("Ship a clearly bounded outcome.");
    const parsed = parseCharterFile(markdown);
    expect(parsed).toEqual({ objective: "Ship a clearly bounded outcome.", references: "", scope: "", notes: "", warnings: [] });
    expect(markdown).toContain("## References");
    expect(markdown).toContain("## Scope");
    expect(markdown).not.toMatch(/phase/i);
  });

  test("warns tolerantly without rejecting unknown prose", () => {
    const parsed = parseCharterFile("Unknown\n\n## Phases\n\n2. Later — maybe\n");
    expect(parsed).toEqual({ objective: "", references: "", scope: "", notes: "Unknown\n\n## Phases\n\n2. Later — maybe", warnings: ["missing `# Objective` section"] });
  });
});
