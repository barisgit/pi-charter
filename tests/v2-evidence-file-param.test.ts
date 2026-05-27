import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPlan } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";
import { registerCharterTools } from "../src/application/registration";
import { logger, type LogEntry } from "../src/infrastructure/logger";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-evidence-file-param-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Evidence file import probe",
    charterId,
    now: "2026-05-21T10:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Evidence file import probe.",
      "",
      "## Criteria",
      "",
      "### VAL-COMMAND — Command evidence",
      "Description: Command evidence records pass/fail from check results.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-REVIEW — Review evidence",
      "Description: Review evidence records explicit outcome.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-READINESS — Readiness evidence",
      "Description: Readiness evidence records explicit outcome.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
      "### VAL-QA — QA evidence",
      "Description: QA evidence records artifact captures.",
      "Verifier: manual",
      "Because: test fixture rationale",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(join(dir, "library", "architecture.md"), `# Architecture\n\n${"Evidence file test fixture. ".repeat(12)}\n`, "utf8");
  await writeFeature(dir, "f-command", "VAL-COMMAND");
  await writeFeature(dir, "f-review", "VAL-REVIEW");
  await writeFeature(dir, "f-readiness", "VAL-READINESS");
  await writeFeature(dir, "f-qa", "VAL-QA");
  await lockPlan(projectDir, { charterId, now: "2026-05-21T10:10:00.000Z" });
  return dir;
}

async function writeFeature(dir: string, featureId: string, criterionId: string): Promise<void> {
  await writeFile(
    join(dir, "plan", `${featureId}.md`),
    `---\nid: ${featureId}\nmilestone: m1\norder: 1\nfulfills:\n  - ${criterionId}\npreconditions: []\n---\n\n# ${featureId}\n\n${VALIDATION_MD}`,
    "utf8",
  );
}

async function callRecord(projectDir: string, params: Record<string, unknown>): Promise<any> {
  const tools: Array<{ name: string; execute: Function }> = [];
  const fakePi: any = {
    registerTool(desc: any) {
      tools.push(desc);
    },
  };
  registerCharterTools(fakePi);
  const recordTool = tools.find((tool) => tool.name === "charter_record")!;
  const ctx: any = {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => undefined },
  };
  return await recordTool.execute("call-1", params, undefined, () => {}, ctx);
}

async function writeJsonEvidence(projectDir: string, name: string, value: unknown): Promise<string> {
  const path = join(projectDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

describe("charter_record evidenceFile parameter", () => {
  test("evidence-file-command-kind-records-pass", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f51";
      const dir = await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "command-evidence", {
        kind: "command",
        featureId: "f-command",
        ts: "2026-05-21T11:00:00.000Z",
        checkResults: {
          "check-types": { outcome: "pass", exitCode: 0, stdoutHead: "ok", durationMs: 100 },
        },
        summary: "Command checks passed.",
        because: "Every command check in checkResults has outcome=pass.",
      });

      const response = await callRecord(projectDir, { action: "evidence", charterId, evidenceFile });

      expect(response.details.entries).toHaveLength(1);
      expect(response.details.entries[0].criterionId).toBe("VAL-COMMAND");
      expect(response.details.entries[0].outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, response.details.entries[0].path), "utf8"));
      expect(stored.summary).toBe("Command checks passed.");
      expect(stored.details.typedEvidence.kind).toBe("command");
      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f-command"].checks["check-types"].status).toBe("passing");
    });
  });

  test("evidence-file-review-kind-records", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f52";
      const dir = await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "review-evidence", {
        kind: "review",
        featureId: "f-review",
        round: 1,
        reviewedAt: "2026-05-21T11:05:00.000Z",
        subagentSessionId: "review-session-1",
        outcome: "partial",
        blockingIssues: [{ file: "src/example.ts", line: 3, description: "Example blocker." }],
        nonBlockingNotes: ["Example note."],
        summary: "Review found one blocker.",
        because: "The review outcome is partial because blockingIssues is non-empty.",
      });

      const response = await callRecord(projectDir, { action: "evidence", charterId, evidenceFile });

      expect(response.details.entries[0].criterionId).toBe("VAL-REVIEW");
      expect(response.details.entries[0].outcome).toBe("partial");
      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-REVIEW"].lastSummary).toBe("Review found one blocker.");
      expect(criterionState.criteria["VAL-REVIEW"].recordedBy).toBe("subagent:charter-reviewer:review-session-1");
    });
  });

  test("evidence-file-readiness-kind-records", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f53";
      const dir = await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "readiness-evidence", {
        kind: "readiness",
        featureId: "f-readiness",
        probeResult: "verified",
        outcome: "pass",
        probedAt: "2026-05-21T11:10:00.000Z",
        details: { dependency: "local" },
        summary: "Readiness probe passed.",
        because: "The readiness probe verified the feature can proceed.",
      });

      const response = await callRecord(projectDir, { action: "evidence", charterId, evidenceFile });

      expect(response.details.entries[0].criterionId).toBe("VAL-READINESS");
      expect(response.details.entries[0].outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, response.details.entries[0].path), "utf8"));
      expect(stored.details.typedEvidence.kind).toBe("readiness");
    });
  });

  test("evidence-file-qa-kind-records-artifacts", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f57";
      const dir = await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "qa-evidence", {
        kind: "qa",
        featureId: "f-qa",
        milestone: "m1",
        surfaces: ["artifact schema"],
        outcome: "pass",
        artifacts: [{ kind: "screenshot", path: "captures/qa.png", caption: "QA capture" }],
        findings: [],
        summary: "QA passed with one artifact.",
        because: "The QA artifact uses the v2.1 artifacts array.",
      });

      const response = await callRecord(projectDir, { action: "evidence", charterId, evidenceFile });

      expect(response.details.entries[0].criterionId).toBe("VAL-QA");
      expect(response.details.entries[0].outcome).toBe("pass");
      const stored = JSON.parse(await readFile(join(dir, response.details.entries[0].path), "utf8"));
      expect(stored.artifacts).toEqual(["captures/qa.png"]);
      expect(stored.details.typedEvidence.kind).toBe("qa");
    });
  });

  test("mixed-inputs-rejected", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f54";
      await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "mixed-evidence", {
        kind: "command",
        featureId: "f-command",
        ts: "2026-05-21T11:00:00.000Z",
        checkResults: { smoke: { outcome: "pass", exitCode: 0 } },
        summary: "Command checks passed.",
        because: "The command check passed.",
      });

      let err: any;
      try {
        await callRecord(projectDir, {
          action: "evidence",
          charterId,
          evidenceFile,
          entries: [{
            criterionId: "VAL-COMMAND",
            outcome: "pass",
            summary: "inline summary",
            because: "inline because",
          }],
        });
      } catch (error) {
        err = error;
      }
      expect(err.code).toBe("evidence.mixed_inputs");
    });
  });

  test("missing-file-rejected", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f55";
      await makeActiveCharter(projectDir, charterId);

      let err: any;
      try {
        await callRecord(projectDir, { action: "evidence", charterId, evidenceFile: join(projectDir, "missing.json") });
      } catch (error) {
        err = error;
      }
      expect(err.code).toBe("evidence.file_read_error");
      expect(err.message).toContain("missing.json");
    });
  });

  test("schema-violation-rejected", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000f56";
      await makeActiveCharter(projectDir, charterId);
      const evidenceFile = await writeJsonEvidence(projectDir, "bad-schema-evidence", {
        kind: "command",
        featureId: "f-command",
        ts: "2026-05-21T11:00:00.000Z",
        summary: "Missing checkResults.",
        because: "This is intentionally malformed.",
      });

      let err: any;
      try {
        await callRecord(projectDir, { action: "evidence", charterId, evidenceFile });
      } catch (error) {
        err = error;
      }
      expect(err.code).toBe("evidence.schema_violation");
      expect(err.message).toContain("/checkResults");
    });
  });
});
