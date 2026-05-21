import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");

function agentText(name: string): string {
  return readFileSync(join(projectDir, "agents", `${name}.md`), "utf8");
}

describe("v2.1 persona bodies", () => {
  test("charter-qa persona teaches surface-specific capture choice", () => {
    const text = agentText("charter-qa");

    expect(text).toContain("qa-briefs/<feature>.md");
    expect(text).toContain("surface");
    expect(text).toContain("skills/pi-charter/references/qa/<surface>.md");
    expect(text).toContain("If no recipe matches");
    expect(text).toContain("closest analog");
  });

  test("charter-qa persona requires stable descriptive artifact filenames", () => {
    const text = agentText("charter-qa");

    expect(text).toContain("Stable descriptive artifact filenames");
    expect(text).toContain("login-form-empty-email.png");
    expect(text).toContain("screenshot-1.png");
  });

  test("charter-qa persona requires every artifact in evidence.json AND qa.md", () => {
    const text = agentText("charter-qa");

    expect(text).toContain(".pi/charters/<id>/work/<feat>/evidence/<ts>/");
    expect(text).toContain("evidence.json artifacts:[]");
    expect(text).toContain("qa.md");
    expect(text).toContain("BOTH");
  });

  test("charter-qa persona requires Surprises section", () => {
    const text = agentText("charter-qa");

    expect(text).toContain("## Surprises / Worth noting");
    expect(text).toContain("empty if none");
  });

  test("charter-reviewer persona requires blockingIssues structure", () => {
    const text = agentText("charter-reviewer");

    expect(text).toContain("blockingIssues");
    expect(text).toContain("{\"file\":\"src/file.ts\",\"line\":42,\"description\":\"issue\"}");
    expect(text).toContain("nonBlockingNotes");
  });

  test("charter-reviewer persona writes review.md companion", () => {
    const text = agentText("charter-reviewer");

    expect(text).toContain("review.md");
    expect(text).toContain("companion");
    expect(text).toContain("## Surprises / Worth noting");
  });

  test("charter-readiness-probe persona verifies ## Readiness items", () => {
    const text = agentText("charter-readiness-probe");

    expect(text).toContain("charter.md ## Readiness");
    expect(text).toContain("verified | deferred-with-fallback | blocking");
    expect(text).toContain("per item");
  });

  test("charter-readiness-probe persona writes readiness.md companion", () => {
    const text = agentText("charter-readiness-probe");

    expect(text).toContain("readiness.md");
    expect(text).toContain("companion");
    expect(text).toContain("## Surprises / Worth noting");
  });
});
