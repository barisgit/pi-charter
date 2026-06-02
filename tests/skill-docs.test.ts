import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillPath = join(process.cwd(), "skills", "pi-charter", "SKILL.md");

async function readSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}

describe("pi-charter skill documentation", () => {
  test("SKILL.md documents dir-per-run evidence layout", async () => {
    const contents = await readSkill();

    expect(contents).toContain("work/<segment>/evidence/<ts>/");
    expect(contents).toContain("evidence.json");
    expect(contents).not.toContain("work/<feat>/evidence/<VAL>__<ts>.json");
  });

  test("SKILL.md points at references/qa.md recipe shelf", async () => {
    const contents = await readSkill();

    expect(contents).toContain("skills/pi-charter/references/qa.md");
    expect(contents).toContain("capture recipe");
  });

  test("SKILL.md teaches behavior-level verifiers over phrase-coupled named tests", async () => {
    const contents = await readSkill();

    // Behavior-level doctrine is the headline guidance.
    expect(contents).toContain("behavior level");
    expect(contents).toContain("file");
    expect(contents).toContain("glob");
    // Command execution is owned by the agent; charter stores evidence only.
    expect(contents).toContain("charter never executes them");
    expect(contents).toContain("records the command string plus real output");
    expect(contents).toContain("weak-verifier-phrase-coupled");
  });

  test("SKILL.md documents optional markdown companions", async () => {
    const contents = await readSkill();

    expect(contents).toContain("review.md");
    expect(contents).toContain("qa.md");
  });
});
