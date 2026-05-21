import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillPath = join(process.cwd(), "skills", "pi-charter", "SKILL.md");

async function readSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}

describe("v2.1 SKILL.md update", () => {
  test("SKILL.md references qa-briefs not qa", async () => {
    const contents = await readSkill();

    expect(contents).toContain("qa-briefs/<surface>.md");
    expect(contents).toContain("not `qa/`");
    expect(contents).not.toContain("qa/<surface>.md");
  });

  test("SKILL.md points at references/qa.md recipe shelf", async () => {
    const contents = await readSkill();

    expect(contents).toContain("skills/pi-charter/references/qa.md");
    expect(contents).toContain("capture recipe selection");
  });

  test("SKILL.md documents dir-per-run evidence layout", async () => {
    const contents = await readSkill();

    expect(contents).toContain("work/<feat>/evidence/<ts>/");
    expect(contents).toContain("evidence.json");
    expect(contents).toContain("work/<feat>/evidence/<ts>/{evidence.json, qa.md, artifacts...}");
    expect(contents).not.toContain("work/<feat>/evidence/<VAL>__<ts>.json");
  });

  test("SKILL.md mentions named-test helper script", async () => {
    const contents = await readSkill();

    expect(contents).toContain("scripts/charter-named-test.sh");
    expect(contents).toContain("instead of bare");
    expect(contents).toContain("bun test -t");
    expect(contents).toContain("0-match pass");
  });

  test("SKILL.md documents qa.md and review.md companions", async () => {
    const contents = await readSkill();

    expect(contents).toContain("qa.json / qa.md");
    expect(contents).toContain("review.json / review.md");
  });
});
