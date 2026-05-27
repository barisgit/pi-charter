import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFeature, lockPlan } from "../src/application/plan-service";
import { verifyCriterion } from "../src/application/record-service";
import { createCharter } from "../src/application/service";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import { CharterToolError } from "../src/application/errors";
import {
  forbiddenSubagentWritePaths,
  SUBAGENT_WRITE_RESTRICTION_MESSAGE,
} from "../src/application/subagent-write-audit";
import { charterDir } from "../src/infrastructure/store";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";

const FEATURE_ID = "f1-write-restrictions";
const CRITERION_ID = "VAL-WRITE-001";

const VALIDATION_MD = `## Validation

### Happy
- check: stage-f-write-restrictions
  command: true

### Edge
- check: stage-f-write-restrictions-edge
  command: true
`;

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-write-restrictions-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  __resetSubagentApiForTests();
});

async function makePlanningSubagentCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Gate subagent writes to orchestrator-managed files",
    charterId,
    now: "2026-05-23T01:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Gate subagent writes to orchestrator-managed files.",
      "",
      "## Criteria",
      "",
      `### ${CRITERION_ID} — Subagent write restrictions`,
      "Description: Subagent verifier writes evidence without mutating plan or charter state files.",
      "Verifier: subagent",
      "Agent: charter-reviewer",
      "Task: Review {featureId} for {criterionId} and write typed evidence into {evidenceDir}.",
      "Fresh evidence required: true",
      "Review subagent required: false",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

async function makeActiveSubagentCharter(projectDir: string, charterId: string): Promise<string> {
  const dir = await makePlanningSubagentCharter(projectDir, charterId);
  await addFeature(projectDir, {
    charterId,
    id: FEATURE_ID,
    milestone: "m1",
    order: 1,
    fulfills: [CRITERION_ID],
    body: `# F1\n\nSubagent write restriction verifier.\n\n${VALIDATION_MD}`,
    now: "2026-05-23T01:05:00.000Z",
  });
  await lockPlan(projectDir, { charterId, now: "2026-05-23T01:10:00.000Z", legacy: true });
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
    list() {
      return [{ name: "charter-reviewer", description: "stub" }];
    },
  };
  setSubagentApiForBridge(api);
  return { calls };
}

async function writeReviewEvidence(dir: string, featureId: string, runId: string): Promise<string> {
  const runDir = join(dir, "work", featureId, "evidence", runId);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "review.json");
  await writeFile(
    path,
    `${JSON.stringify({
      kind: "review",
      featureId,
      round: 1,
      reviewedAt: new Date().toISOString(),
      subagentSessionId: `stub-${runId}`,
      outcome: "pass",
      blockingIssues: [],
      nonBlockingNotes: [],
      summary: `pass review from ${runId}`,
      because: "stubbed reviewer evidence for write restriction audit",
    }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

async function expectCharterToolError(promise: Promise<unknown>): Promise<CharterToolError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof CharterToolError)) {
    throw new Error(`expected CharterToolError, got ${caught === undefined ? "no throw" : String(caught)}`);
  }
  return caught;
}

describe("v2.3 subagent write restrictions", () => {
  test("computes the orchestrator-managed deny list for a charter dir", () => {
    const dir = join(tmpdir(), "pi-charter-deny-list", "charter-1");

    expect(forbiddenSubagentWritePaths(dir)).toEqual([
      join(dir, "plan"),
      join(dir, "feature-state.json"),
      join(dir, "criterion-state.json"),
      join(dir, "state.json"),
      join(dir, "charter.md"),
      join(dir, "criteria.md"),
    ]);
  });

  test("subagent verifier fails clearly when it writes plan markdown", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002301";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeFile(join(dir, "plan", "rogue.md"), "# rogue subagent edit\n", "utf8");
      });

      const err = await expectCharterToolError(verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-23T02:00:00.000Z",
      }));

      expect(err.code).toBe("verify.subagent_forbidden_write");
      expect(err.message).toContain(SUBAGENT_WRITE_RESTRICTION_MESSAGE);
      expect(err.message).toContain("plan/rogue.md");
    });
  });

  test("subagent verifier may write typed evidence under work without tripping the audit", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002302";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeReviewEvidence(dir, FEATURE_ID, "allowed");
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-23T02:00:00.000Z",
      });

      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.details.kind).toBe("review");
      expect(stored.details.evidenceFile).toContain("work/f1-write-restrictions/evidence/allowed/review.json");
    });
  });

  test("main-agent add_feature still writes plan markdown", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002303";
      const dir = await makePlanningSubagentCharter(projectDir, charterId);

      const result = await addFeature(projectDir, {
        charterId,
        id: "f-main-add-feature",
        milestone: "m1",
        order: 1,
        fulfills: [CRITERION_ID],
        body: `# Main add_feature\n\nThis write is orchestrator-managed.\n\n${VALIDATION_MD}`,
        now: "2026-05-23T01:05:00.000Z",
      });

      expect(result.path).toBe(join(dir, "plan", "f-main-add-feature.md"));
      expect(await readFile(result.path, "utf8")).toContain("id: f-main-add-feature");
    });
  });
});
