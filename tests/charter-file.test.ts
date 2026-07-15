import { describe, expect, test } from "bun:test";
import {
  parseCharterFile,
  readyCriteria,
} from "../src/domain/charter-file";
import { renderCharterTemplate } from "../src/domain/template";

const SAMPLE = `# Charter: streaming parser migration

## Objective

Migrate the parser to streaming without breaking the public API.

## Scope

- In: src/parser/
- Out: lexer rewrite

## Criteria

### C1. Nested blocks parse correctly on the streaming path

All existing parser fixtures pass against the streaming implementation.

Status: pass — bun test parser: 42/42 pass (2026-07-02)

### C2. Memory stays flat on large inputs

Run bench:memory with the 500MB fixture. Budget: <100MB.

Status: fail — peak RSS 340MB, buffers full blocks before emit
(2026-07-02)

### C3. No public API change
Depends: C1

check-types clean against the published .d.ts.

Status: pending

### C4. Docs updated with new streaming notes
Depends: C1, C3

Status: pending
`;

describe("charter.md parser", () => {
  test("parses rich sections and unified criterion statuses", () => {
    const parsed = parseCharterFile([
      "## Objective",
      "",
      "Deliver a durable outcome with enough detail to resume later.",
      "",
      "## References",
      "",
      "- `docs/spec.md` — canonical requirements",
      "",
      "## Scope",
      "",
      "- In: runtime and UI",
      "- Out: task scheduling",
      "",
      "## Criteria",
      "",
      "### C1. Active work is visible",
      "Status: in-progress — implementing the compact widget",
      "",
      "The widget names the criteria being worked on without rendering the full charter.",
      "",
      "### C2. Verified work records evidence",
      "",
      "The note captures the observed result and artifact path.",
      "Status: pass — drove the picker; screenshot: work/picker.png",
    ].join("\n"));

    expect(parsed.references).toContain("docs/spec.md");
    expect(parsed.scope).toContain("runtime and UI");
    expect(parsed.criteria[0].status).toEqual({
      value: "in-progress",
      note: "implementing the compact widget",
    });
    expect(parsed.criteria[0].body).toContain("widget names the criteria");
    expect(parsed.criteria[1].status).toEqual({
      value: "pass",
      note: "drove the picker; screenshot: work/picker.png",
    });
  });

  test("parses objective and criteria from the sample", () => {
    const parsed = parseCharterFile(SAMPLE);
    expect(parsed.objective).toContain("Migrate the parser to streaming");
    expect(parsed.criteria.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4"]);
    expect(parsed.openEnded).toBe(false);
    expect(parsed.warnings).toEqual([]);
  });

  test("legacy Evidence lines map into unified statuses", () => {
    const legacy = SAMPLE
      .replace("Status: pass — bun test parser: 42/42 pass (2026-07-02)", "Evidence: pass — bun test parser: 42/42 pass (2026-07-02)")
      .replace("Status: fail — peak RSS 340MB, buffers full blocks before emit", "Evidence: fail — peak RSS 340MB, buffers full blocks before emit")
      .replaceAll("Status: pending", "Evidence: none");
    const byId = new Map(parseCharterFile(legacy).criteria.map((c) => [c.id, c]));
    expect(byId.get("C1")!.status.value).toBe("pass");
    expect(byId.get("C1")!.status.note).toContain("42/42");
    expect(byId.get("C2")!.status.value).toBe("fail");
    // multi-line note reads until next heading
    expect(byId.get("C2")!.status.note).toContain("(2026-07-02)");
    expect(byId.get("C3")!.status.value).toBe("pending");
  });

  test("depends and body extraction", () => {
    const byId = new Map(parseCharterFile(SAMPLE).criteria.map((c) => [c.id, c]));
    expect(byId.get("C4")!.depends).toEqual(["C1", "C3"]);
    expect(byId.get("C3")!.body).toContain("check-types clean");
    expect(byId.get("C3")!.body).not.toContain("Depends");
  });

  test("ready advisory: pass deps unlock, non-pass deps block", () => {
    const ready = readyCriteria(parseCharterFile(SAMPLE)).map((c) => c.id);
    expect(ready).toContain("C2"); // failed, no deps
    expect(ready).toContain("C3"); // C1 passed
    expect(ready).not.toContain("C4"); // blocked on C3 (pending)
    expect(ready).not.toContain("C1"); // already pass
  });

  test("no criteria = open-ended", () => {
    const parsed = parseCharterFile("## Objective\n\nWatch CI.\n\n## Criteria\n");
    expect(parsed.openEnded).toBe(true);
    expect(parsed.criteria).toEqual([]);
  });

  test("tolerance: warnings not errors", () => {
    const parsed = parseCharterFile(
      [
        "## Criteria",
        "### C1. Something",
        "Status: maybe — dunno",
        "### C1. Duplicate",
        "Status: pending",
        "### C2. Dangling and self dep",
        "Depends: C2, C9",
        "### C3. Missing evidence line",
        "",
      ].join("\n"),
    );
    expect(parsed.criteria.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    expect(parsed.criteria[0].status.value).toBe("pending");
    expect(parsed.warnings.join("\n")).toContain("Status line must start with pending, in-progress, blocked, pass, or fail");
    expect(parsed.warnings.join("\n")).toContain("duplicate criterion id C1");
    expect(parsed.warnings.join("\n")).toContain("unknown C9");
    expect(parsed.warnings.join("\n")).toContain("references itself");
    expect(parsed.warnings.join("\n")).toContain("C3: missing Status line");
    expect(parsed.warnings.join("\n")).toContain("missing `## Objective`");
  });

  test("pass with empty note warns", () => {
    const parsed = parseCharterFile(
      "## Objective\nX\n## Criteria\n### C1. T\nStatus: pass\n",
    );
    expect(parsed.criteria[0].status.value).toBe("pass");
    expect(parsed.warnings.join("\n")).toContain("empty note");
  });

  test("cycle detection warns once", () => {
    const parsed = parseCharterFile(
      [
        "## Objective\nX\n## Criteria",
        "### C1. A",
        "Depends: C2",
        "Status: pending",
        "### C2. B",
        "Depends: C1",
        "Status: pending",
      ].join("\n"),
    );
    const cycles = parsed.warnings.filter((w) => w.includes("cycle"));
    expect(cycles.length).toBe(1);
  });

  test("grouping headings are inert; criteria found under them", () => {
    const parsed = parseCharterFile(
      [
        "## Objective\nX\n## Criteria",
        "## Parser work",
        "### C1. A",
        "Status: pass — ok",
        "## Docs",
        "### C2. B",
        "Status: pending",
      ].join("\n"),
    );
    expect(parsed.criteria.map((c) => c.id)).toEqual(["C1", "C2"]);
  });
});

describe("template", () => {
  test("scaffold parses clean, open-ended, objective intact", () => {
    const md = renderCharterTemplate(
      "Migrate parser to streaming without breaking the public API.",
    );
    const parsed = parseCharterFile(md);
    expect(parsed.objective).toContain("Migrate parser to streaming");
    expect(parsed.openEnded).toBe(true); // example criteria are inside comments
    expect(parsed.warnings).toEqual([]);
  });

  test("template teaches the single Status grammar and richer authoring guidance", () => {
    const md = renderCharterTemplate("Do the thing.");
    expect(md).toContain("Status: pending|in-progress|blocked|pass|fail");
    expect(md).not.toMatch(/^\s*Evidence:/m);
    expect(md).toContain("## References");
    expect(md).toContain("10–20 criteria");
    expect(md).toContain("expected behavior, boundaries");
    expect(md).toContain("Use it like a user");
    expect(md).toContain("open-ended");
    expect(md).toContain("work/");
  });
});
