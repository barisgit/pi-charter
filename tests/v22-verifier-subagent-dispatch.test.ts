import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { verifyCriterion } from "../src/application/record-service";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import { charterDir } from "../src/infrastructure/store";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-subagent-verifier-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  __resetSubagentApiForTests();
});

const VALIDATION_MD = `## Validation

### Happy
- check: subagent-verifier
  command: true

### Edge
- check: subagent-verifier-edge
  command: true
`;

async function makeActiveSubagentCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Subagent verifier dispatch probe",
    charterId,
    now: "2026-05-20T01:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Subagent verifier dispatch probe.",
      "",
      "## Criteria",
      "",
      "### VAL-SUBAGENT-001 — Subagent verifier",
      "Description: Subagent verifier dispatches and imports typed review evidence.",
      "Verifier: subagent",
      "Agent: charter-reviewer",
      "Task: Review {charterId} {featureId} {criterionId} into {evidenceDir} using {commands.test}.",
      "Fresh evidence required: true",
      "Review subagent required: false",
      "",
      "## Commands",
      "test: bun test tests/v22-verifier-subagent-dispatch.test.ts",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f4-verifier-subagent-dispatch.md"),
    `---\nid: f4-verifier-subagent-dispatch\nmilestone: m2\norder: 1\nfulfills:\n  - VAL-SUBAGENT-001\npreconditions: []\n---\n\n# F4\n\n${VALIDATION_MD}`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-20T01:10:00.000Z" });
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

async function writeReviewEvidence(dir: string, featureId: string, runId: string, outcome: "pass" | "fail" | "partial", reviewedAt: string): Promise<string> {
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
      blockingIssues: outcome === "pass" ? [] : [{ file: "src/application/record-service.ts", line: 1, description: "stub issue" }],
      nonBlockingNotes: [],
      summary: `${outcome} review from ${runId}`,
      because: "stubbed reviewer evidence for verifier dispatch",
    }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

describe("v2.2 verifier subagent dispatch", () => {
  test("subagent verifier kind round-trips", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002201";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeReviewEvidence(dir, "f4-verifier-subagent-dispatch", "2026-05-20T02-00-00-000Z", "pass", new Date().toISOString());
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-SUBAGENT-001",
        featureId: "f4-verifier-subagent-dispatch",
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.source).toBe("subagent");
      expect(stored.recordedBy).toStartWith("subagent:charter-reviewer:stub-");
      expect(stored.details.kind).toBe("review");
    });
  });

  test("subagent dispatch reads newest evidence by timestamp", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002202";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeReviewEvidence(dir, "f4-verifier-subagent-dispatch", "older", "fail", "2026-05-20T02:00:00.000Z");
        await writeReviewEvidence(dir, "f4-verifier-subagent-dispatch", "newer", "pass", "2026-05-20T02:00:02.000Z");
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-SUBAGENT-001",
        featureId: "f4-verifier-subagent-dispatch",
        now: "2026-05-20T02:00:03.000Z",
      });

      expect(result.outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toBe("pass review from newer");
    });
  });

  test("subagent dispatch fails when persona writes no evidence", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002203";
      await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(() => undefined);

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-SUBAGENT-001",
        featureId: "f4-verifier-subagent-dispatch",
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(result.outcome).toBe("fail");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
    });
  });

  test("subagent dispatch interpolates charterId and featureId in task", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002204";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      const stub = installSubagentStub(async () => {
        await writeReviewEvidence(dir, "f4-verifier-subagent-dispatch", "interp", "pass", new Date().toISOString());
      });

      await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-SUBAGENT-001",
        featureId: "f4-verifier-subagent-dispatch",
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.prompt).toContain(charterId);
      expect(stub.calls[0]!.prompt).toContain("f4-verifier-subagent-dispatch");
      expect(stub.calls[0]!.prompt).toContain("VAL-SUBAGENT-001");
      expect(stub.calls[0]!.prompt).toContain("bun test tests/v22-verifier-subagent-dispatch.test.ts");
      expect(stub.calls[0]!.metadata?.["pi-charter.charterId"]).toBe(charterId);
      expect(stub.calls[0]!.metadata?.["pi-charter.featureId"]).toBe("f4-verifier-subagent-dispatch");
    });
  });

  test("subagent dispatch honors requireFreshEvidence with stale evidence", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002205";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      const stalePath = await writeReviewEvidence(dir, "f4-verifier-subagent-dispatch", "stale", "pass", "2026-05-20T01:30:00.000Z");
      const staleTime = new Date("2026-05-20T01:30:00.000Z");
      await utimes(stalePath, staleTime, staleTime);
      installSubagentStub(() => undefined);

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-SUBAGENT-001",
        featureId: "f4-verifier-subagent-dispatch",
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(result.outcome).toBe("fail");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toContain("no fresh typed evidence");
    });
  });
});
