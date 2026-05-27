import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockPlan, viewPlan } from "../src/application/plan-service";
import { recordEvidenceFromFile, verifyCriterion } from "../src/application/record-service";
import { createCharter, getCharterStatus } from "../src/application/service";
import { clearHookSubscribers } from "../src/application/hooks";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import { charterDir } from "../src/infrastructure/store";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir_ = resolve(testDir, "..");
const REVIEWER_PERSONA_PATH = join(projectDir_, "agents", "charter-reviewer.md");
const REVIEWER_V22_SECTIONS = [
  "## Code Quality Principles",
  "## Verification Hygiene",
  "## Returning to orchestrator",
] as const;

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
  opts: { freshRequired?: boolean; freshSince?: string } = {},
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
      ...(opts.freshSince ? [`FreshSince: ${opts.freshSince}`] : []),
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
  await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z" });
  return dir;
}

async function reviewerPersonaText(): Promise<string> {
  return await readFile(REVIEWER_PERSONA_PATH, "utf8");
}

function reviewerSectionsIn(text: string): string[] {
  return REVIEWER_V22_SECTIONS.filter((header) => text.includes(header));
}

function reviewNarrativeFromPersona(personaText: string, runId: string): string {
  const referencedSections = reviewerSectionsIn(personaText);
  if (referencedSections.length < 2) {
    throw new Error(`charter-reviewer persona is missing v2.2 sections: ${REVIEWER_V22_SECTIONS.join(", ")}`);
  }
  return [
    "# Stubbed charter-reviewer smoke review",
    "",
    `Run: ${runId}`,
    "",
    "This stub read the live agents/charter-reviewer.md persona before writing evidence.",
    "The smoke narrative deliberately references the v2.2 sections the persona must internalize:",
    "",
    ...referencedSections.map((header) => `${header}\n- Referenced from the live charter-reviewer persona.`),
    "",
    "## Surprises / Worth noting",
    "",
    "- empty if none.",
    "",
  ].join("\n");
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
  const narrative = reviewNarrativeFromPersona(await reviewerPersonaText(), runId);
  await writeFile(join(runDir, "review.md"), narrative, "utf8");
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
      narrativePath: "review.md",
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
      const reviewMd = await readFile(join(dir, "work", "f-smoke", "evidence", "2026-05-22T01-00-00-000Z", "review.md"), "utf8");
      expect(reviewerSectionsIn(reviewMd).length).toBeGreaterThanOrEqual(2);
    });
  });

  test("smoke confirms no auto-injected features after lock", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e215";
      const dir = await makeSubagentCharter(projectDir, charterId);
      const plan = await viewPlan(projectDir, { charterId });
      const planFiles = (await readdir(join(dir, "plan"))).filter((f) => f.endsWith(".md"));
      expect(plan.criteria).toHaveLength(1);
      expect(plan.criteria[0]!.verifierSpec).toMatchObject({ kind: "subagent", agent: "charter-reviewer" });
      expect(plan.features).toHaveLength(1);
      expect(plan.features.filter((feature) => feature.kind !== "impl")).toHaveLength(0);
      expect(planFiles).toEqual(["f-smoke.md"]);
      expect(planFiles.some((f) => f.includes("review") || f.endsWith("-qa.md"))).toBe(false);
    });
  });

  test("smoke verifies stale evidence + requireFreshEvidence flips to fail", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000e216";
      const dir = await makeSubagentCharter(projectDir, charterId, {
        freshRequired: true,
        freshSince: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      const staleDate = new Date(Date.now() - (24 * 60 * 60 * 1000) - 60_000);
      const stalePath = await writeSubagentReviewEvidence(dir, "f-smoke", "stale-run", "pass", staleDate.toISOString());
      await utimes(stalePath, staleDate, staleDate);
      await recordEvidenceFromFile(projectDir, { charterId, evidenceFile: stalePath, now: staleDate.toISOString() });
      const beforeVerify = await getCharterStatus(projectDir, { charterId });
      expect(beforeVerify.drift.stale.map((entry) => entry.criterionId)).toContain("VAL-SMOKE-SUBAGENT");
      installSubagentStub(() => undefined); // writes nothing new
      await new Promise<void>((res) => setTimeout(res, 10));
      const result = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-SUBAGENT", featureId: "f-smoke",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(result.outcome).toBe("fail");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toContain("no fresh typed evidence");
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
          "### VAL-SMOKE-SUBAGENT — Prior persona output", "Description: charter-reviewer writes prior review evidence.",
          "Verifier: subagent", "Agent: charter-reviewer", "Task: Review {featureId} for evidence-exists follow-up.", "",
          "### VAL-SMOKE-EE — Evidence exists", "Description: Review evidence exists.",
          "Verifier: evidence-exists", "Kind: review", "",
          "## Scope and constraints", "", "- Smoke only.", ""].join("\n"),
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(
        join(dir, "plan", "f-ee.md"),
        ["---", "id: f-ee", "milestone: m1", "order: 1",
          "fulfills:", "  - VAL-SMOKE-SUBAGENT", "  - VAL-SMOKE-EE", "preconditions: []", "---", "", VALIDATION_MD].join("\n"),
        "utf8",
      );
      await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z" });
      installSubagentStub(async () => {
        await writeSubagentReviewEvidence(dir, "f-ee", "prior-persona", "pass", new Date().toISOString());
      });
      const priorPersonaResult = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-SUBAGENT", featureId: "f-ee",
        now: "2026-05-22T00:30:00.000Z",
      });
      expect(priorPersonaResult.outcome).toBe("pass");
      const passResult = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-EE", featureId: "f-ee",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(passResult.outcome).toBe("pass");
      expect(passResult.stdout).toContain("evidence.json");
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
      await lockPlan(projectDir, { charterId, now: "2026-05-22T00:01:00.000Z" });
      const failResult = await verifyCriterion(projectDir, {
        charterId, criterionId: "VAL-SMOKE-EE-FAIL", featureId: "f-ee-fail",
        now: "2026-05-22T01:00:01.000Z",
      });
      expect(failResult.outcome).toBe("fail");
    });
  });

  test("smoke confirms persona internalizes v22 sections", () => {
    expect(existsSync(REVIEWER_PERSONA_PATH)).toBe(true);
    const text = readFileSync(REVIEWER_PERSONA_PATH, "utf8");
    for (const section of REVIEWER_V22_SECTIONS) {
      expect(text).toContain(section);
    }
  });
});
