import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff } from "../src/application/record-service";
import { recordEvidence } from "../src/application/record-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-handoff-"));
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

async function makeActiveCharter(projectDir: string, charterId = "cha-handoff-1") {
  const charterMd = [
    "# Charter cha-handoff-1",
    "",
    "## Objective",
    "Wire the auth flow.",
    "",
    "## Criteria",
    "",
    "### VAL-H-001 — Token exchange works",
    "Verifier: manual",
    "",
    "### VAL-H-002 — Tokens persist",
    "Verifier: manual",
    "",
    "## Scope and constraints",
    "",
    "- Stay inside auth module.",
    "",
  ].join("\n");
  const feature = (id: string, fulfills: string[]) =>
    [
      "---",
      `id: ${id}`,
      "milestone: m1",
      "order: 1",
      `fulfills: [${fulfills.join(", ")}]`,
      "preconditions: []",
      "---",
      "",
      `# ${id}`,
      "",
      VALIDATION_MD,
    ].join("\n");
  await createCharter(projectDir, { objective: "Wire auth", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1.md"), feature("f1", ["VAL-H-001"]), "utf8");
  await writeFile(join(dir, "plan", "f2.md"), feature("f2", ["VAL-H-002"]), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z", legacy: true });
}

describe("charter_record handoff_apply", () => {
  test("writes handoff envelope, applies evidence per criterion, and updates feature-state", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");

      const result = await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "sess_worker_42",
        handoffNote: "Worker completed token exchange.",
        completedCriteria: [
          {
            criterionId: "VAL-H-001",
            outcome: "pass",
            summary: "Token exchange returns access_token",
            artifacts: ["src/auth/callback.ts"],
            details: { reviewer: "self" },
          },
        ],
        now: "2026-05-15T02:00:00.000Z",
      });

      expect(result.charterId).toBe("cha-handoff-1");
      expect(result.featureId).toBe("f1");
      expect(result.handoffPath).toMatch(/handoffs\/.*__f1__sess_worker_42\.json$/);
      expect(result.appliedCount).toBe(1);

      const handoffDir = join(dir, "handoffs");
      const entries = await readdir(handoffDir);
      expect(entries.length).toBe(1);
      const envelope = JSON.parse(await readFile(join(handoffDir, entries[0]), "utf8"));
      expect(envelope.subagentSessionId).toBe("sess_worker_42");
      expect(envelope.handoffNote).toContain("token exchange");

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-H-001"].outcome).toBe("pass");
      expect(criterionState.criteria["VAL-H-001"].source).toBe("subagent");

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f1"].lastWorkerSessionId).toBe("sess_worker_42");
      expect(featureState.features["f1"].status).toBe("completed");
      expect(featureState.features["f1"].completedAt).toBe("2026-05-15T02:00:00.000Z");
    });
  });

  test("keeps feature in progress until every fulfilled criterion has pass evidence", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");
      await writeFile(
        join(dir, "plan", "f3.md"),
        [
          "---",
          "id: f3",
          "milestone: m1",
          "order: 3",
          "fulfills: [VAL-H-001, VAL-H-002]",
          "preconditions: []",
          "---",
          "# f3",
          "",
        ].join("\n"),
      );

      await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f3",
        subagentSessionId: "sess_worker_partial",
        handoffNote: "Worker completed only token exchange.",
        completedCriteria: [
          {
            criterionId: "VAL-H-001",
            outcome: "pass",
            summary: "Token exchange returns access_token",
          },
        ],
        now: "2026-05-15T02:00:00.000Z",
      });

      const featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f3"].status).toBe("in_progress");
      expect(featureState.features["f3"].completedAt).toBeUndefined();
    });
  });

  test("preserves prior implementer lastWorkerSessionId across charter-reviewer review handoffs", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");

      // First handoff: real implementer.
      await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "sess_worker_real",
        handoffNote: "Worker completed feature.",
        completedCriteria: [
          { criterionId: "VAL-H-001", outcome: "pass", summary: "Implementation done" },
        ],
        now: "2026-05-15T02:00:00.000Z",
      });
      let fs = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(fs.features["f1"].lastWorkerSessionId).toBe("sess_worker_real");

      // Second handoff: charter-reviewer review must NOT overwrite implementer.
      await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "charter-reviewer-r1",
        handoffNote: "Independent review.",
        completedCriteria: [
          { criterionId: "VAL-H-001", outcome: "pass", summary: "Reviewed" },
        ],
        now: "2026-05-15T03:00:00.000Z",
      });
      fs = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(fs.features["f1"].lastWorkerSessionId).toBe("sess_worker_real");
    });
  });

  test("leaves lastWorkerSessionId unset when only charter-reviewer handoffs exist", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");

      await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "charter-reviewer-only",
        handoffNote: "Review of root-implemented feature.",
        completedCriteria: [
          { criterionId: "VAL-H-001", outcome: "pass", summary: "Reviewed" },
        ],
        now: "2026-05-15T03:00:00.000Z",
      });
      const fs = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(fs.features["f1"].lastWorkerSessionId).toBeUndefined();
    });
  });

  test("recordEvidence flips feature-state to completed once every fulfilled criterion has pass evidence", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");
      await writeFile(
        join(dir, "plan", "f4.md"),
        [
          "---",
          "id: f4",
          "milestone: m1",
          "order: 4",
          "fulfills: [VAL-H-001, VAL-H-002]",
          "preconditions: []",
          "---",
          "# f4",
          "",
        ].join("\n"),
      );

      await recordEvidence(projectDir, {
        charterId: "cha-handoff-1",
        criterionId: "VAL-H-001",
        featureId: "f4",
        outcome: "pass",
        summary: "criterion one passed",
        because: "manual sign-off, criterion one",
        now: "2026-05-15T03:00:00.000Z",
      });
      let featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f4"]?.status).toBeUndefined();

      await recordEvidence(projectDir, {
        charterId: "cha-handoff-1",
        criterionId: "VAL-H-002",
        featureId: "f4",
        outcome: "pass",
        summary: "criterion two passed",
        because: "manual sign-off, criterion two",
        now: "2026-05-15T03:01:00.000Z",
      });
      featureState = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8"));
      expect(featureState.features["f4"].status).toBe("completed");
      expect(featureState.features["f4"].completedAt).toBe("2026-05-15T03:01:00.000Z");
    });
  });

  test("writes recordedBy='subagent:charter-reviewer:<sessionId>' on every evidence record it appends", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi", "charters", "cha-handoff-1");

      const result = await applyHandoff(projectDir, {
        charterId: "cha-handoff-1",
        featureId: "f1",
        subagentSessionId: "rev-1",
        handoffNote: "verifier reviewed",
        completedCriteria: [
          {
            criterionId: "VAL-H-001",
            outcome: "pass",
            summary: "reviewed by charter-reviewer",
          },
        ],
        now: "2026-05-15T04:00:00.000Z",
      });
      expect(result.appliedCount).toBe(1);

      const evidenceDir = join(dir, "work", "f1", "evidence");
      const entries = await readdir(evidenceDir);
      expect(entries.length).toBe(1);
      const stored = JSON.parse(await readFile(join(evidenceDir, entries[0]!, "evidence.json"), "utf8"));
      expect(stored.recordedBy).toBe("subagent:charter-reviewer:rev-1");
      expect(stored.source).toBe("subagent");

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-H-001"].recordedBy).toBe("subagent:charter-reviewer:rev-1");
    });
  });

  // Empty-completedCriteria rejection moved to tests/handoff-schema.test.ts:
  // it is now enforced at the charter_record tool boundary (CharterToolError
  // with code 'handoff_apply.empty_completedCriteria'), not inside the
  // record-service applyHandoff function. See VAL-HANDOFF-SCHEMA.

  test("rejects unknown criterion in completedCriteria", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        applyHandoff(projectDir, {
          charterId: "cha-handoff-1",
          featureId: "f1",
          subagentSessionId: "sess",
          handoffNote: "x",
          completedCriteria: [{ criterionId: "VAL-XYZ", outcome: "pass", summary: "bogus" }],
          now: "2026-05-15T02:00:00.000Z",
        }),
      ).rejects.toThrow(/unknown criterion/i);
    });
  });
});
