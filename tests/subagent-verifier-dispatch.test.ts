import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCriterion } from "../src/application/record-service";
import { __resetSubagentApiForTests, setSubagentApiForBridge } from "../src/application/subagent-api";
import type { SpawnRawInput, SubagentExposedAPI } from "../src/infrastructure/subagent-bridge";
import { makeActiveCharter } from "./helpers/charter-fixtures";

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

const FEATURE_ID = "f4-verifier-subagent-dispatch";
const CRITERION_ID = "VAL-SUBAGENT-001";

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

async function writeReviewEvidence(
  dir: string,
  featureId: string,
  runId: string,
  outcome: "pass" | "fail" | "partial",
  reviewedAt: string,
): Promise<string> {
  const runDir = join(dir, "work", featureId, "evidence", runId);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "evidence.json");
  await writeFile(
    path,
    `${JSON.stringify({
      criterionId: CRITERION_ID,
      featureId,
      outcome,
      summary: `${outcome} review from ${runId}`,
      because: "stubbed reviewer evidence for verifier dispatch",
      source: "subagent",
      recordedBy: `subagent:review:stub-${runId}`,
      ts: reviewedAt,
    }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

async function makeActiveSubagentCharter(projectDir: string, charterId: string): Promise<string> {
  return makeActiveCharter({
    projectDir,
    charterId,
    objective: "Subagent verifier dispatch probe",
    now: "2026-05-20T01:00:00.000Z",
    criteria: [{
      id: CRITERION_ID,
      title: "Subagent verifier",
      verifier: "subagent",
      agent: "charter-reviewer",
      task: "Review {charterId} {featureId} {criterionId} into {evidenceDir} using {commands.test}.",
      requireFreshEvidence: true,
    }],
    commands: {
      test: "bun test tests/subagent-verifier-dispatch.test.ts",
    },
  });
}

describe("subagent verifier dispatch", () => {
  test("subagent verifier kind round-trips", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002201";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeReviewEvidence(dir, FEATURE_ID, "2026-05-20T02-00-00-000Z", "pass", new Date().toISOString());
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.source).toBe("subagent");
      expect(stored.recordedBy).toStartWith("subagent:review:stub-");
    });
  });

  test("subagent dispatch reads newest evidence by timestamp", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002202";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      installSubagentStub(async () => {
        await writeReviewEvidence(dir, FEATURE_ID, "older", "fail", "2026-05-20T02:00:00.000Z");
        await writeReviewEvidence(dir, FEATURE_ID, "newer", "pass", "2026-05-20T02:00:02.000Z");
      });

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
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
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
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
        await writeReviewEvidence(dir, FEATURE_ID, "interp", "pass", new Date().toISOString());
      });

      await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.prompt).toContain(charterId);
      expect(stub.calls[0]!.prompt).toContain(FEATURE_ID);
      expect(stub.calls[0]!.prompt).toContain(CRITERION_ID);
      expect(stub.calls[0]!.prompt).toContain("bun test tests/subagent-verifier-dispatch.test.ts");
      expect(stub.calls[0]!.metadata?.["pi-charter.charterId"]).toBe(charterId);
      expect(stub.calls[0]!.metadata?.["pi-charter.featureId"]).toBe(FEATURE_ID);
    });
  });

  test("subagent dispatch honors requireFreshEvidence with stale evidence", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000002205";
      const dir = await makeActiveSubagentCharter(projectDir, charterId);
      const stalePath = await writeReviewEvidence(dir, FEATURE_ID, "stale", "pass", "2026-05-20T01:30:00.000Z");
      const staleTime = new Date("2026-05-20T01:30:00.000Z");
      await utimes(stalePath, staleTime, staleTime);
      installSubagentStub(() => undefined);

      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: CRITERION_ID,
        featureId: FEATURE_ID,
        now: "2026-05-20T02:00:01.000Z",
      });

      expect(result.outcome).toBe("fail");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.summary).toContain("no fresh flat evidence");
    });
  });
});
