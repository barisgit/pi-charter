import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const promptPath = join(projectDir, "agents", "charter-planner-critic.md");

function promptText(): string {
  return readFileSync(promptPath, "utf8");
}

describe("v2.2 critic four-question gate", () => {
  test("critic teaches the four-question gate", () => {
    const text = promptText();

    expect(text).toContain(`For every feature, the plan body must independently answer:
- What does it do?
- What are its boundaries?
- Where does complexity concentrate?
- How would an independent party verify it works?`);
  });

  test("critic declares feature-underspecified verdict with whichQuestion", () => {
    const text = promptText();

    expect(text).toContain("feature-underspecified");
    expect(text).toContain("whichQuestion: 'does'|'boundaries'|'complexity'|'verification'");
    expect(text).toContain("BLOCK feature-underspecified");
  });

  test("critic prompt references feature plan body not charter.md for the gate", () => {
    const text = promptText();

    expect(text).toContain("FEATURE PLAN BODY");
    expect(text).toContain("The four-question gate applies to FEATURE PLAN BODY content");
    expect(text).toContain("does NOT apply to charter.md");
  });
});
