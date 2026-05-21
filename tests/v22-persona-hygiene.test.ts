import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const personaNames = ["charter-reviewer", "charter-qa"];

function agentText(name: string): string {
  return readFileSync(join(projectDir, "agents", `${name}.md`), "utf8");
}

function verificationHygiene(name: string): string {
  const text = agentText(name);
  const match = text.match(/## Verification Hygiene\n[\s\S]*?(?=\n## |\n---\n|$)/);
  if (!match) {
    throw new Error(`${name} is missing Verification Hygiene section`);
  }
  return match[0].trim();
}

describe("v2.2 persona verification hygiene", () => {
  test("Verification Hygiene rule in personas", () => {
    for (const name of personaNames) {
      const text = agentText(name);
      const codeQualityIndex = text.indexOf("## Code Quality Principles");
      const hygieneIndex = text.indexOf("## Verification Hygiene");

      expect(codeQualityIndex).toBeGreaterThanOrEqual(0);
      expect(hygieneIndex).toBeGreaterThan(codeQualityIndex);
      expect(verificationHygiene(name)).toContain("never pipe test/validator output through");
    }
  });

  test("rule mentions exit-code masking", () => {
    for (const name of personaNames) {
      const section = verificationHygiene(name);

      expect(section).toContain("masks exit codes");
      expect(section).toContain("shell reports the truncation command's status");
      expect(section).toContain("hiding test or validator failures");
    }
  });

  test("rule points to scripts/charter-named-test.sh", () => {
    for (const name of personaNames) {
      const section = verificationHygiene(name);

      expect(section).toContain("scripts/charter-named-test.sh");
      expect(section).toContain("bun test -t");
      expect(section).toContain("Prefer narrower test selection over output truncation");
    }
  });

  test("hygiene section verbatim across reviewer and qa personas", () => {
    expect(verificationHygiene("charter-reviewer")).toBe(verificationHygiene("charter-qa"));
  });
});
