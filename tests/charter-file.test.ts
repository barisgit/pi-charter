import { describe, expect, test } from "bun:test";
import { parseCharterFile } from "../src/domain/charter-file";
import { renderCharterTemplate } from "../src/domain/template";

describe("charter.md Objective/Phases parser", () => {
  test("Objective subheadings preserve constraints until a recognized charter section", () => {
    const objective = "Ship the recovery flow.\n\n## Constraints\n\nDo not change login.\n\n### Verification\n\nVerify desktop and mobile widths.\n\n#### Evidence\n\nCapture both views.";
    const parsed = parseCharterFile(`# Objective\n\n${objective}\n\n## References\n\nApproved plan.\n\n### Authority\n\nAll requirements remain binding.\n\n## Phases\n\n1. Explore phases\n`);
    expect(parsed.objective).toBe(objective);
    expect(parsed.references).toContain("### Authority\n\nAll requirements remain binding.");
    expect(parsed.objective).not.toContain("Approved plan");
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  test("an unrelated top-level heading still ends the Objective", () => {
    expect(parseCharterFile("# Objective\n\nShip.\n\n### Constraints\n\nPreserve login.\n\n# Appendix\n\nOther notes.\n").objective)
      .toBe("Ship.\n\n### Constraints\n\nPreserve login.");
  });
  test("parses phase titles, statuses, and indented bodies", () => {
    const parsed = parseCharterFile([
      "# Objective",
      "",
      "Ship a bounded redesign that removes stale-first verification loops.",
      "",
      "## References",
      "",
      "- `docs/spec.md` — approved design",
      "",
      "## Scope",
      "",
      "Core runtime only.",
      "",
      "## Phases",
      "",
      "1. Explore the current behavior — done",
      "   Findings are recorded in `work/explore.md`.",
      "2. Implement the redesign — current",
      "   Preserve lifecycle behavior.",
      "3. Verify it — upcoming",
      "   Capture user-visible evidence at verification time.",
    ].join("\n"));

    expect(parsed).toEqual({
      objective: "Ship a bounded redesign that removes stale-first verification loops.",
      references: "- `docs/spec.md` — approved design",
      scope: "Core runtime only.",
      phases: [
        { number: 1, title: "Explore the current behavior", status: "done", body: "Findings are recorded in `work/explore.md`." },
        { number: 2, title: "Implement the redesign", status: "current", body: "Preserve lifecycle behavior." },
        { number: 3, title: "Verify it", status: "upcoming", body: "Capture user-visible evidence at verification time." },
      ],
      warnings: [],
    });
  });

  test("infers the first unfinished bare phase as current", () => {
    const parsed = parseCharterFile("# Objective\n\nShip it.\n\n## Phases\n\n1. Explore — done\n2. Build\n3. Verify\n");
    expect(parsed.phases.map((phase) => phase.status)).toEqual(["done", "current", "upcoming"]);
  });

  test("a scaffold has the exact initial Explore phase and teaches artifact capture", () => {
    const markdown = renderCharterTemplate("Ship a clearly bounded outcome.");
    const parsed = parseCharterFile(markdown);
    expect(parsed.objective).toBe("Ship a clearly bounded outcome.");
    expect(parsed.phases).toEqual([{ number: 1, title: "Explore phases", status: "current", body: "" }]);
    expect(markdown).toContain("1. Explore phases");
    expect(markdown).toContain("screenshots or recordings");
    expect(markdown).toContain("work/");
  });

  test("warns tolerantly without rejecting unknown prose", () => {
    const parsed = parseCharterFile("Unknown\n\n## Phases\n\n2. Later — maybe\n");
    expect(parsed.phases).toEqual([{ number: 2, title: "Later — maybe", status: "current", body: "" }]);
    expect(parsed.warnings).toContain("missing `# Objective` section");
  });
});
