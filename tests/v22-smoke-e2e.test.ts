import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockPlan } from "../src/application/plan-service";
import { verifyCriterion } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { clearHookSubscribers } from "../src/application/hooks";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import { charterDir } from "../src/infrastructure/store";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir_ = resolve(testDir, "..");

afterEach(() => {
  clearHookSubscribers();
  __resetSubagentApiForTests();
});

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v22-smoke-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

async function makeSubagentCharter(
  projectDir: string,
  charterId: string,
  opts: { freshRequired?: boolean } = {},
): Promise<string> {
  await createCharter(projectDir, { objective: "v2.2 smoke probe", charterId, now: "2026-05-22T00:00:00.000Z" });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter", "", "## Objective", "", "v2.2 smoke probe.", "",
      "## Criteria", "",
      "### VAL-SMOKE-SUBAGENT — Subagent verifier smoke",
      "Description: charter-reviewer writes typed review evidence.",
      "Verifier: subagent",
      "Agent: charter-reviewer",
      "Task: Review {featureId} for {charterId} and write typed review evidence.",
      `Fresh evidence required: ${opts.freshRequired ? "true" : "false"}`,
      "",
      "## Scope and constraints", "", "- Smoke only.", "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f-smoke.md"),
    ["---", "id: f-smoke", "milestone: m1", "order: 1",
      "fulfills:", "  - VAL-SMOKE-SUBAGENT", "preconditions: []", "---", "", VALIDATION_MD].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z", legacy: true });
  return dir;
}

function installSubagentStub(fn: (input: SpawnRawInput) => Promise<void> | void): { calls: SpawnRawInput[] } {
  const calls: SpawnRawInput[] = [];
  const api: SubagentExposedAPI = {
    async spawnRaw(input) {
      calls.push(input);
      await fn(input);
      return { content: [{ type: "text", text: "stub complete" }] };
    },
    list() { return [{ name: "charter-reviewer", description: "stub" }]; },
  };
  setSubagentApiForBridge(api);
  return { calls };
}

/**
 * Write typed review evidence for the subagent verifier path.
 * newestTypedEvidenceAfterDispatch scans any *.json in the work tree and
 * validates against ReviewEvidenceSchema (additionalProperties:false, no ts).
 * File is named review.json inside a run subdir — same as the working pattern
 * in tests/v22-verifier-subagent-dispatch.test.ts.
 */
async function writeSubagentReviewEvidence(
  dir: string,
  featureId: string,
  runId: string,
  outcome: "pass" | "fail" | "partial",
  reviewedAt: string,
): Promise<string> {
  const runDir = join(dir, "work", featureId, "evidence", runId);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "review.json");
  await writeFile(
    path,
    `${JSON.stringify({
      kind: "review",
      featureId,
      round: 1,
      reviewedAt,
      subagentSessionId: `stub-${runId}`,
      outcome,
      blockingIssues: outcome === "pass" ? [] : [{ file: "src/app.ts", line: 1, description: "stub issue" }],
      nonBlockingNotes: [],
      summary: `${outcome} review from ${runId}`,
      because: "stubbed for smoke test",
    }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

/**
 * Write a legacy-flat evidence record for the evidence-exists verifier path.
 * loadFeatureEvidence reads work/<featureId>/evidence/<runId>/evidence.json
 * and requires a top-level `ts` field for sorting; evidenceKindFromRecord
 * checks the top-level `kind` field.
 */
async function writeEvidenceExistsRecord(
  dir: string,
  featureId: string,
  runId: string,
  outcome: "pass" | "fail",
  ts: string,
): Promise<string> {
  const runDir = join(dir, "work", featureId, "evidence", runId);
  await mkdir(runDir, { recursive: true });
  // Use evidence.json — loadFeatureEvidence only picks up this filename from subdirs
  const path = join(runDir, "evidence.json");
  await writeFile(
    path,
    `${JSON.stringify({
      kind: "review",
      featureId,
      round: 1,
      reviewedAt: ts,
      subagentSessionId: `stub-ee-${runId}`,
      outcome,
      blockingIssues: [],
      nonBlockingNotes: [],
      summary: `${outcome} review`,
      because: "evidence-exists smoke stub",
      // ts required by loadFeatureEvidence indexer
      ts,
    }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

describe("v2.2 smoke e2e", () => {
  test("v22 smoke e2e exercises subagent verifier", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e214";
      const dir = await makeSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeSubagentReviewEvidence(dir, "f-smoke", "2026-05-22T01-00-00-000Z", "pass", new Date().toISOString());
      });
      const result = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-SUBAGENT", featureId: "f-smoke",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
    });
  });

  test("smoke confirms no auto-injected features after lock", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e215";
      await createCharter(projectDir, { objective: "No auto-inject smoke", charterId, now: "2026-05-22T00:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      await writeFile(
        join(dir, "charter.md"),
        ["# Charter", "", "## Objective", "", "No auto-inject smoke.", "",
          "## Criteria", "",
          "### VAL-NO-INJECT-A — First", "Description: A.", "Verifier: manual", "Because: sign-off A", "",
          "### VAL-NO-INJECT-B — Second", "Description: B.", "Verifier: manual", "Because: sign-off B", "",
          "## Scope and constraints", "", "- Smoke only.", ""].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      for (const [id, val] of [["f-alpha", "VAL-NO-INJECT-A"], ["f-beta", "VAL-NO-INJECT-B"]] as const) {
        await writeFile(
          join(dir, "plan", `${id}.md`),
          ["---", `id: ${id}`, "milestone: m1", `order: ${id === "f-alpha" ? 1 : 2}`,
            "fulfills:", `  - ${val}`, "preconditions: []", "---", "", VALIDATION_MD].join("\n"),
          "utf8",
        );
      }
      await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z", legacy: true });
      const planFiles = (await readdir(join(dir, "plan"))).filter((f) => f.endsWith(".md"));
      expect(planFiles).toHaveLength(2);
      expect(planFiles.some((f) => f.includes("review") || f.endsWith("-qa.md"))).toBe(false);
    });
  });

  test("smoke verifies stale evidence + requireFreshEvidence flips to fail", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e216";
      const dir = await makeSubagentCharter(projectDir, charterId, { freshRequired: true });
      const staleDate = new Date(Date.now() - 86_400_000);
      const stalePath = await writeSubagentReviewEvidence(dir, "f-smoke", "stale-run", "pass", staleDate.toISOString());
      await utimes(stalePath, staleDate, staleDate);
      installSubagentStub(() => undefined); // writes nothing new
      await new Promise<void>((res) => setTimeout(res, 10));
      const result = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-SUBAGENT", featureId: "f-smoke",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(result.outcome).toBe("fail");
    });
  });

  test("smoke exercises evidence-exists verifier on prior persona output", async () => {
    // Pass: review evidence present
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e217";
      await createCharter(projectDir, { objective: "EE smoke pass", charterId, now: "2026-05-22T00:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      await writeFile(
        join(dir, "charter.md"),
        ["# Charter", "", "## Objective", "", "EE smoke.", "",
          "## Criteria", "",
          "### VAL-SMOKE-EE — Evidence exists", "Description: Review evidence exists.",
          "Verifier: evidence-exists", "Kind: review", "",
          "## Scope and constraints", "", "- Smoke only.", ""].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(
        join(dir, "plan", "f-ee.md"),
        ["---", "id: f-ee", "milestone: m1", "order: 1",
          "fulfills:", "  - VAL-SMOKE-EE", "preconditions: []", "---", "", VALIDATION_MD].join("\n"),
        "utf8",
      );
      await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z", legacy: true });
      await writeEvidenceExistsRecord(dir, "f-ee", "run-pass", "pass", new Date().toISOString());
      const passResult = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-EE", featureId: "f-ee",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(passResult.outcome).toBe("pass");
    });

    // Fail: no evidence
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e218";
      await createCharter(projectDir, { objective: "EE smoke fail", charterId, now: "2026-05-22T00:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      await writeFile(
        join(dir, "charter.md"),
        ["# Charter", "", "## Objective", "", "EE smoke fail.", "",
          "## Criteria", "",
          "### VAL-SMOKE-EE-FAIL — No evidence", "Description: No evidence.",
          "Verifier: evidence-exists", "Kind: review", "",
          "## Scope and constraints", "", "- Smoke only.", ""].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(
        join(dir, "plan", "f-ee-fail.md"),
        ["---", "id: f-ee-fail", "milestone: m1", "order: 1",
          "fulfills:", "  - VAL-SMOKE-EE-FAIL", "preconditions: []", "---", "", VALIDATION_MD].join("\n"),
        "utf8",
      );
      await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z", legacy: true });
      const failResult = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-EE-FAIL", featureId: "f-ee-fail",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(failResult.outcome).toBe("fail");
    });
  });

  test("smoke confirms persona internalizes v22 sections", () => {
    const personaPath = join(projectDir_, "agents", "charter-reviewer.md");
    expect(existsSync(personaPath)).toBe(true);
    const text = readFileSync(personaPath, "utf8");
    expect(text).toContain("## Code Quality Principles");
    expect(text).toContain("## Verification Hygiene");
    expect(text).toContain("## Returning to orchestrator");
  });
});
