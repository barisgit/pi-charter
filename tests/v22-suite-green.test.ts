import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateVerifier } from "../src/domain/verifier";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const testsDir = join(projectDir, "tests");

const V22_TEST_FILES = [
  "v22-architecture-append.test.ts",
  "v22-commands-section.test.ts",
  "v22-critic-four-question.test.ts",
  "v22-critic-mandates.test.ts",
  "v22-no-auto-inject.test.ts",
  "v22-persona-hygiene.test.ts",
  "v22-persona-quality.test.ts",
  "v22-persona-return-to-orch.test.ts",
  "v22-showcase.test.ts",
  "v22-skill-planning.test.ts",
  "v22-smoke-e2e.test.ts",
  "v22-suite-green.test.ts",
  "v22-verifier-evidence-exists.test.ts",
  "v22-verifier-schema.test.ts",
  "v22-verifier-subagent-dispatch.test.ts",
];

describe("v2.2 suite green", () => {
  test("all v22 test files present", () => {
    for (const file of V22_TEST_FILES) {
      expect(existsSync(join(testsDir, file)), `missing: ${file}`).toBe(true);
    }
    expect(V22_TEST_FILES).toHaveLength(15);
  });

  test("no regressions in v2.1 test files", () => {
    const v21Files = readdirSync(testsDir)
      .filter((f) => /^v21-.*\.test\.ts$/.test(f))
      .map((f) => join(testsDir, f));
    expect(v21Files.length).toBeGreaterThan(0);
    const result = Bun.spawnSync(["bun", "test", ...v21Files], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, `v2.1 tests failed:\n${result.stderr.toString()}`).toBe(0);
  });

  test("no new skipped or todo tests beyond v21 baseline", () => {
    const V21_SKIP_TODO_BASELINE = 0;
    const allTestFiles = readdirSync(testsDir)
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => join(testsDir, f));
    let count = 0;
    for (const file of allTestFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        if (/\.(skip|todo)\s*\(/.test(line)) count++;
      }
    }
    expect(count).toBeLessThanOrEqual(V21_SKIP_TODO_BASELINE);
  });

  test("verifier kind switch is exhaustive on all 6 kinds", () => {
    const kinds: Array<[string, unknown]> = [
      ["manual", { kind: "manual" }],
      ["command", { kind: "command" }],
      ["hook", { kind: "hook" }],
      ["prompt", { kind: "prompt" }],
      ["subagent", { kind: "subagent", agent: "charter-reviewer", task: "Review." }],
      ["evidence-exists", { kind: "evidence-exists", evidenceKind: "review" }],
    ];
    for (const [label, verifier] of kinds) {
      const result = validateVerifier(verifier);
      expect(result.ok, `kind '${label}' should be valid`).toBe(true);
    }
    // Unknown kind rejected
    const unknown = validateVerifier({ kind: "unknown-kind-xyz" });
    expect(unknown.ok).toBe(false);
    // Confirm exactly 6 known kinds covered
    expect(kinds).toHaveLength(6);
  });
});
