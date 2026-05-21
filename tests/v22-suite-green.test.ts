import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const testsDir = join(projectDir, "tests");
const verifierPath = join(projectDir, "src", "domain", "verifier.ts");
const recordServicePath = join(projectDir, "src", "application", "record-service.ts");

const V21_SKIP_TODO_BASELINE = 0;

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

const EXPECTED_VERIFIER_KINDS = [
  "command",
  "evidence-exists",
  "hook",
  "manual",
  "prompt",
  "subagent",
];

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function filesMatching(pattern: RegExp): string[] {
  return readdirSync(testsDir).filter((file) => pattern.test(file)).sort((a, b) => a.localeCompare(b));
}

function extractVerifierUnionKinds(source: string): string[] {
  const schemaKinds = new Map<string, string>();
  for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Za-z]+VerifierSchema)\s*=\s*Type\.Object\(\{\s*kind:\s*Type\.Literal\("([^"]+)"\)/g)) {
    schemaKinds.set(match[1], match[2]);
  }

  const unionMatch = source.match(/export const VerifierSchema = Type\.Union\(\[([\s\S]*?)\]\);/);
  if (!unionMatch) throw new Error("VerifierSchema union not found");

  return [...unionMatch[1].matchAll(/\b([A-Za-z]+VerifierSchema)\b/g)].map((match) => {
    const kind = schemaKinds.get(match[1]);
    if (!kind) throw new Error(`No kind literal found for ${match[1]}`);
    return kind;
  });
}

function extractVerifyCriterionBody(source: string): string {
  const match = source.match(/export async function verifyCriterion\([\s\S]*?\n}\n\nasync function verifySubagentCriterion/);
  if (!match) throw new Error("verifyCriterion body not found");
  return match[0];
}

function verifierKindsHandledByVerifyCriterion(body: string, unionKinds: string[]): string[] {
  const handled = new Set<string>();

  if (/criterion\.verifier === "evidence-exists"[\s\S]*verifyEvidenceExistsCriterion/.test(body)) {
    handled.add("evidence-exists");
  }
  if (/criterion\.verifier === "subagent"[\s\S]*verifySubagentCriterion/.test(body)) {
    handled.add("subagent");
  }
  if (/criterion\.verifier !== "command"[\s\S]*runCommand\(criterion\.command/.test(body)) {
    handled.add("command");
  }
  if (/criterion\.verifier !== "command"/.test(body)) {
    for (const kind of unionKinds) {
      if (!handled.has(kind) && kind !== "command") handled.add(kind);
    }
  }

  return sorted(handled);
}

describe("v2.2 suite green", () => {
  test("all v22 test files present", () => {
    const discovered = new Set(readdirSync(testsDir));

    for (const file of V22_TEST_FILES) {
      expect(discovered.has(file), `missing: ${file}`).toBe(true);
    }
    expect(V22_TEST_FILES).toHaveLength(15);
  });

  test("no regressions in v2.1 test files", () => {
    const v2Files = filesMatching(/^v2-.*\.test\.ts$/);
    const v21Files = filesMatching(/^v21-.*\.test\.ts$/);

    expect(v2Files.length).toBeGreaterThan(0);
    expect(v21Files.length).toBeGreaterThan(0);
    for (const file of [...v2Files, ...v21Files]) {
      expect(statSync(join(testsDir, file)).size, `${file} should not be empty`).toBeGreaterThan(0);
    }

    const result = Bun.spawnSync(["bun", "test", ...v2Files.map((file) => join("tests", file)), ...v21Files.map((file) => join("tests", file))], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, `v2/v2.1 tests failed:\n${stdout}\n${stderr}`).toBe(0);
  });

  test("no new skipped or todo tests beyond v21 baseline", () => {
    const allTestFiles = filesMatching(/.*\.test\.ts$/);
    let count = 0;
    for (const file of allTestFiles) {
      const content = readFileSync(join(testsDir, file), "utf8");
      count += [...content.matchAll(/\b(?:test|it)\.(?:skip|todo)\b/g)].length;
    }

    expect(count).toBeLessThanOrEqual(V21_SKIP_TODO_BASELINE);
  });

  test("verifier kind switch is exhaustive on all 6 kinds", () => {
    const verifierSource = readFileSync(verifierPath, "utf8");
    const recordServiceSource = readFileSync(recordServicePath, "utf8");
    const unionKinds = sorted(extractVerifierUnionKinds(verifierSource));

    expect(unionKinds).toEqual(EXPECTED_VERIFIER_KINDS);
    expect(unionKinds).toHaveLength(6);

    const verifyCriterionBody = extractVerifyCriterionBody(recordServiceSource);
    expect(verifierKindsHandledByVerifyCriterion(verifyCriterionBody, unionKinds)).toEqual(unionKinds);
  });
});
