import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const personaNames = [
  "charter-reviewer",
  "charter-qa",
  "charter-readiness-probe",
  "charter-planner-critic",
];
const triggers = [
  "blocked by missing dependency",
  "scope violation",
  "broken upstream state can't restore",
  "service won't healthcheck",
  "decision needed from main agent",
];

function agentText(name: string): string {
  return readFileSync(join(projectDir, "agents", `${name}.md`), "utf8");
}

function returningToOrchestrator(name: string): string {
  const text = agentText(name);
  const match = text.match(/## Returning to orchestrator\n[\s\S]*?(?=\n## |\n---\n|$)/);
  if (!match) {
    throw new Error(`${name} is missing Returning to orchestrator section`);
  }
  return match[0].trim();
}

describe("v2.2 persona return to orchestrator", () => {
  test("returnToOrchestrator triggers in personas", () => {
    for (const name of personaNames) {
      expect(agentText(name)).toContain("## Returning to orchestrator");
    }
  });

  test("all 5 triggers enumerated in each persona", () => {
    for (const name of personaNames) {
      const section = returningToOrchestrator(name);

      for (const trigger of triggers) {
        expect(section).toContain(`- ${trigger}`);
      }
    }
  });

  test("must-not-spin rule present in each persona", () => {
    for (const name of personaNames) {
      const section = returningToOrchestrator(name);

      expect(section).toContain("Must-not-spin rule");
      expect(section).toContain("do not retry infrastructure fixes the persona can't resolve");
      expect(section).toContain("After 1 attempt to fix and re-verify, return with the reason");
    }
  });

  test("triggers section verbatim across personas", () => {
    const [firstName, ...remainingNames] = personaNames;
    const firstSection = returningToOrchestrator(firstName);

    for (const name of remainingNames) {
      expect(returningToOrchestrator(name)).toBe(firstSection);
    }
  });
});
