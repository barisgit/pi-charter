import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCharterStatus,
  nextActionsForStatus,
} from "../src/application/service";
import { makeActiveCharter } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-nextactions-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

describe("charter_status nextActions", () => {
  test("active base hints are criteria-only (no feature/plan/lock_plan)", () => {
    const hints = nextActionsForStatus("active").map((action) => action.hint ?? "");
    const blob = hints.join("\n");
    expect(blob).not.toMatch(/feature|lock_plan|charter_plan|charter_manage/);
    expect(blob).not.toContain("command verifiers for criteria");
  });

  test("getCharterStatus does not emit legacy milestone_ready_for_review review prompts", async () => {
    const charterId = "nextactions-no-legacy-review";
    await withTempProject(async (projectDir) => {
      await makeActiveCharter({
        projectDir,
        charterId,
        objective: "NextActions cleanup probe",
        criteria: [
          { id: "VAL-A", title: "Done", command: "true" },
          { id: "VAL-B", title: "Next", command: "true" },
        ],
      });
      const dir = join(projectDir, ".pi", "charters", charterId);
      await appendFile(
        join(dir, "events.jsonl"),
        `${JSON.stringify({
          type: "milestone_ready_for_review",
          ts: "2026-05-27T17:58:55.176Z",
          charterId,
          milestoneId: "m1-lifecycle",
          planDigest: "sha256:deadbeef",
          criterionIds: ["VAL-A"],
        })}\n`,
        "utf8",
      );

      const status = await getCharterStatus(projectDir, { charterId });
      const hints = status.nextActions.map((a) => a.hint ?? "").join("\n");
      expect(hints).not.toMatch(/Delegate a review subagent for milestone/);
      expect(status.nextActions.some((a) => a.hint?.includes("Advisory next VAL: VAL-A"))).toBe(false);
    });
  });
});
