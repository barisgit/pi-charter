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

function codeQualityPrinciples(name: string): string {
  const text = agentText(name);
  const match = text.match(/## Code Quality Principles\n[\s\S]*?(?=\n## |\n---\n|$)/);
  if (!match) {
    throw new Error(`${name} is missing Code Quality Principles section`);
  }
  return match[0].trim();
}

describe("v2.2 persona quality principles", () => {
  test("Code Quality Principles in personas", () => {
    for (const name of personaNames) {
      expect(agentText(name)).toContain("## Code Quality Principles");
    }
  });

  test("all 4 principles enumerated in each persona", () => {
    for (const name of personaNames) {
      const section = codeQualityPrinciples(name);

      expect(section).toContain("Avoid god files");
      expect(section).toContain("Prefer reusable components");
      expect(section).toContain("Keep changes focused");
      expect(section).toContain("Stay in scope");
    }
  });

  test("stay-in-scope rule references discoveredIssues with non_blocking severity", () => {
    for (const name of personaNames) {
      const section = codeQualityPrinciples(name);

      expect(section).toContain("discoveredIssues");
      expect(section).toContain("severity:non_blocking");
      expect(section).toContain("description");
      expect(section).toContain("Pre-existing:");
    }
  });

  test("principles section verbatim across reviewer and qa personas", () => {
    expect(codeQualityPrinciples("charter-reviewer")).toBe(codeQualityPrinciples("charter-qa"));
  });
});
