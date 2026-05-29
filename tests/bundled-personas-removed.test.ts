import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completeCharter } from "../src/application/service";
import { isSubagentRecordedBy } from "../src/application/service";
import { recordEvidence } from "../src/application/record-service";
import { loadCharterState } from "../src/infrastructure/store";
import { makeActiveCharter, seedReportReadyForCompletion } from "./helpers/charter-fixtures";

const BUNDLED_PERSONA_SYMBOLS = [
  "charter-reviewer",
  "charter-qa",
  "charter-planner-critic",
  "charter-readiness-probe",
  "charter-verifier",
  "registerCharterPersonas",
];

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-personas-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("bundled personas removed", () => {
  test("bundled agents/ persona directory is absent", async () => {
    await expect(access(join(import.meta.dir, "..", "agents"))).rejects.toThrow();
  });

  test("runtime src/*.ts has no hardcoded bundled persona names", () => {
    for (const symbol of BUNDLED_PERSONA_SYMBOLS) {
      const result = Bun.spawnSync({
        cmd: ["grep", "-RIn", "--include=*.ts", symbol, "src"],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${symbol}: ${result.stdout.toString()}`).toBe(1);
    }
  });

  test("SKILL.md does not instruct invoking bundled charter personas", async () => {
    const skill = await Bun.file(join(import.meta.dir, "..", "skills", "pi-charter", "SKILL.md")).text();
    for (const symbol of BUNDLED_PERSONA_SYMBOLS.slice(0, 5)) {
      expect(skill).not.toContain(symbol);
    }
    expect(skill).toMatch(/user-owned subagents|your own review subagents/i);
  });

  test("isSubagentRecordedBy accepts any subagent agent name", () => {
    expect(isSubagentRecordedBy("subagent:my-team-reviewer:session-1")).toBe(true);
    expect(isSubagentRecordedBy("subagent:fixer:session-2")).toBe(true);
    expect(isSubagentRecordedBy("agent:root")).toBe(false);
    expect(isSubagentRecordedBy("subagent:only-one-colon")).toBe(false);
  });

  test("requireReviewSubagent clears on generic subagent evidence (not a bundled name)", async () => {
    const charterId = "personas-review-gate";
    await withTempProject(async (projectDir) => {
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "Generic review gate probe",
        now: "2026-05-22T00:00:00.000Z",
        criteria: [{
          id: "VAL-REVIEW-001",
          title: "Review gate satisfied by any subagent",
          requireReviewSubagent: true,
          because: "fixture requires delegated review",
        }],
      });

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-REVIEW-001",
        outcome: "pass",
        summary: "reviewed by user-owned subagent",
        source: "subagent",
        recordedBy: "subagent:team-reviewer:review-session-9",
        now: "2026-05-22T01:00:00.000Z",
      });

      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", charterId));
      const result = await completeCharter(projectDir, { charterId, now: "2026-05-22T02:00:00.000Z" });
      expect(result.status).toBe("completed");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", charterId));
      expect(state.status).toBe("completed");
    });
  });
});
