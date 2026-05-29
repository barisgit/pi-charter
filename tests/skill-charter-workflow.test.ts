import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillPath = join(process.cwd(), "skills", "pi-charter", "SKILL.md");

async function readSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}

function section(contents: string, heading: string): string {
  const start = contents.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = contents.indexOf("\n## ", start + heading.length);
  return next === -1 ? contents.slice(start) : contents.slice(start, next);
}

describe("pi-charter skill workflow", () => {
  test("SKILL describes the three-tool surface", async () => {
    const contents = await readSkill();
    expect(contents).toContain("charter action=create");
    expect(contents).toContain("charter_record action=evidence");
    expect(contents).toContain("charter_status");
    expect(contents).not.toContain("charter_manage");
    expect(contents).not.toContain("charter_plan");
    expect(contents).not.toMatch(/charter_plan action=lock_plan|action=lock_plan/);
  });

  test("SKILL documents user-owned subagents (no bundled personas)", async () => {
    const contents = await readSkill();
    expect(contents).toMatch(/zero bundled personas|user-owned subagents/i);
    expect(contents).not.toContain("charter-reviewer");
    expect(contents).not.toContain("charter-planner-critic");
    expect(contents).not.toContain("charter-qa");
    expect(contents).not.toContain("charter-readiness-probe");
    expect(contents).not.toContain("charter-verifier");
  });

  test("SKILL planning section covers criteria-first doctrine", async () => {
    const contents = await readSkill();
    const planning = section(contents, "## Planning is the work");

    expect(planning).toContain("Planning is the work");
    expect(planning).toContain("criteria.md");
    expect(planning).toContain("nextActions[]");
    expect(planning).not.toContain("lock_plan");
  });

  test("SKILL planning section avoids time percentages", async () => {
    const contents = await readSkill();
    const planning = section(contents, "## Planning is the work");
    const percentPattern = new RegExp(String.raw`\d` + "+%", "g");

    expect(planning.match(percentPattern) ?? []).toEqual([]);
  });

  test("research delegation rule landed", async () => {
    const contents = await readSkill();
    const research = section(contents, "## Online research delegation");

    expect(research).toContain("Delegate online research");
    expect(research).toContain("current ecosystem");
    expect(research).toMatch(/foundational,\s*slowly evolving knowledge/);
    expect(research).toContain("library/<topic>.md");
    expect(research).toContain("library/research/<topic>.md");
  });

  test("SKILL references RequireReviewSubagent generic gate", async () => {
    const contents = await readSkill();
    expect(contents).toContain("RequireReviewSubagent");
    expect(contents).toContain("subagent:my-reviewer");
  });
});
