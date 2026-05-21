import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const helper = join(projectDir, "scripts", "charter-named-test.sh");
const fixtureDir = join(testDir, "fixtures", "v21-named-test-helper");
const passingFixture = join(fixtureDir, "passing-fixture.ts");
const failingFixture = join(fixtureDir, "failing-fixture.ts");

function runHelper(args: string[]) {
  return spawnSync(helper, args, { cwd: projectDir, encoding: "utf8" });
}

describe("charter named test helper", () => {
  test("exits zero when one or more tests match", () => {
    const result = runHelper([passingFixture, "fixture matching pass"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 pass");
  });

  test("exits nonzero when zero tests match", () => {
    const result = runHelper([passingFixture, "NONEXISTENT_PHRASE_xyz"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("0 tests matched phrase: NONEXISTENT_PHRASE_xyz");
  });

  test("exits nonzero when a matched test fails", () => {
    const result = runHelper([failingFixture, "fixture matched failure"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture matched failure");
    expect(result.stderr).toContain("fail");
    expect(result.stderr).not.toContain("0 tests matched phrase");
  });

  test("exits nonzero when arguments are missing", () => {
    const result = runHelper([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: scripts/charter-named-test.sh [<test-file>] <phrase>");
  });
});
