import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const promptPath = join(projectDir, "agents", "charter-planner-critic.md");
const helper = join(projectDir, "scripts", "charter-named-test.sh");
const passingFixture = join(testDir, "fixtures", "v21-named-test-helper", "passing-fixture.ts");

function promptText(): string {
  return readFileSync(promptPath, "utf8");
}

describe("v2.1 planner critic rewrite", () => {
  test("critic exits zero when one or more tests match", () => {
    const result = spawnSync("bash", [helper, passingFixture, "fixture matching pass"], {
      cwd: projectDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 pass");
  });

  test("critic flags feature with zero edge checks", () => {
    const text = promptText();

    expect(text).toContain("Flag features with zero edge checks as **BLOCK validation-underspecified**");
    expect(text).toContain("count edge checks");
  });

  test("critic grandfathers pre-f10 plans on verifier-robustness", () => {
    const text = promptText();

    expect(text).toContain("Grandfather clause");
    expect(text).toContain("schemaVersion < 2.2");
    expect(text).toContain("[ADVISORY] verifier-not-robust");
    expect(text).toContain("grandfathered for future migration");
  });

  test("critic flags bare bun test -t verifier in v2.2+ plan", () => {
    const text = promptText();

    expect(text).toContain("`bun test -t '<phrase>'`");
    expect(text).toContain("scripts/charter-named-test.sh");
    expect(text).toContain("[BLOCK] verifier-not-robust");
    expect(text).toContain("schemaVersion` >= 2.2");
  });

  test("critic returns validation-underspecified verdict shape", () => {
    const text = promptText();

    expect(text).toContain("{kind:'validation-underspecified', featureId, missing:['edge'|'happy'|'depth']}");
    expect(text).toContain("validation-underspecified:");
  });

  test("critic mandates ≥1 happy + ≥1 edge per feature", () => {
    const text = promptText();

    expect(text).toContain("A feature requires **≥1 happy + ≥1 edge per feature**");
    expect(text).toContain("count happy checks");
    expect(text).toContain("count edge checks");
  });
});
