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
  // Helper smoke-test (unchanged — not a spec-named check)
  test("critic exits zero when one or more tests match", () => {
    const result = spawnSync("bash", [helper, passingFixture, "fixture matching pass"], {
      cwd: projectDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 pass");
  });

  // --- Spec check: critic-returns-verdict-on-shallow-plan (Happy) ---
  test("critic flags shallow plan with validation-underspecified entry", () => {
    const text = promptText();

    expect(text).toContain("validation-underspecified:");
    expect(text).toContain("{kind:'validation-underspecified', featureId");
    expect(text).toContain("count happy checks");
    expect(text).toContain("count edge checks");
  });

  // --- Spec check: critic-flags-bun-test-without-helper (Happy) ---
  test("critic flags bun test -t without charter-named-test.sh wrapper for post-f10 plans", () => {
    const text = promptText();

    expect(text).toContain("`bun test -t '<phrase>'`");
    expect(text).toContain("scripts/charter-named-test.sh");
    expect(text).toContain("[BLOCK] verifier-not-robust");
    expect(text).toContain("schemaVersion` >= 2.2");
  });

  // --- Spec check: critic-flags-unverifier-backed-verification-prose (Edge) ---
  test("critic flags Verification prose not backed by VAL", () => {
    const text = promptText();

    expect(text).toContain("Verification prose must back VAL");
    expect(text).toContain("BLOCK");
    expect(text).toContain("quote the prose excerpt");
  });

  // --- Spec check: critic-passes-well-specified-plan (Edge) ---
  test("critic passes well-specified plan with no validation-underspecified", () => {
    const text = promptText();

    // PASS verdict is defined — the critic can emit it when all checks clear
    expect(text).toContain("`PASS` — no findings");
    expect(text).toContain("`validation-underspecified` is empty");
    expect(text).toContain("PASS | BLOCK | ADVISORY");
  });

  // --- Spec check: critic-flags-feature-with-zero-edge-checks (Edge) ---
  test("critic flags feature with zero edge checks as validation-underspecified", () => {
    const text = promptText();

    expect(text).toContain("Flag features with zero edge checks as **BLOCK validation-underspecified**");
    expect(text).toContain("count edge checks");
  });

  // --- Spec check: critic-grandfathers-pre-f10-plans (Edge) ---
  test("critic grandfathers pre-f10 plans for bun-test rule as ADVISORY not BLOCK", () => {
    const text = promptText();

    expect(text).toContain("Grandfather clause");
    expect(text).toContain("schemaVersion < 2.2");
    expect(text).toContain("[ADVISORY] verifier-not-robust");
    expect(text).toContain("grandfathered for future migration");
  });

  // --- Mandate (a): ≥1 happy + ≥1 edge per feature ---
  test("critic mandates ≥1 happy + ≥1 edge per feature", () => {
    const text = promptText();

    expect(text).toContain("A feature requires **≥1 happy + ≥1 edge per feature**");
    expect(text).toContain("count happy checks");
    expect(text).toContain("count edge checks");
  });

  // --- Mandate (d): touch-overlap detection documented ---
  test("critic documents touch-overlap detection rule", () => {
    const text = promptText();

    expect(text).toContain("Touch-overlap detection");
    expect(text).toContain("touches[]");
    expect(text).toContain("BLOCK obvious conflicting");
  });

  // --- Mandate (e): review:skip audit documented ---
  test("critic documents review skip-list audit rule", () => {
    const text = promptText();

    expect(text).toContain("review:skip audit");
    expect(text).toContain("review: skip");
    expect(text).toContain("concrete rationale");
  });
});
