import { describe, expect, test, afterEach } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearHookSubscribers, subscribeHook } from "../src/application/hooks";
import { recordEvidence } from "../src/application/record-service";
import { completeCharter, getCharterStatus } from "../src/application/service";
import { loadCharterState } from "../src/infrastructure/store";
import { makeActiveCharter, seedReportReadyForCompletion } from "./helpers/charter-fixtures";

const CHARTER_ID = "report-complete-1";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-report-complete-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function seedCharter(projectDir: string): Promise<string> {
  return makeActiveCharter({
    projectDir,
    charterId: CHARTER_ID,
    objective: "Ship the OAuth callback flow.",
    now: "2026-05-15T00:00:00.000Z",
    criteria: [{
      id: "VAL-REPORT-001",
      title: "Report gate probe",
      requireReviewSubagent: false,
      because: "fixture",
    }],
  });
}

async function recordPass(projectDir: string): Promise<void> {
  await recordEvidence(projectDir, {
    charterId: CHARTER_ID,
    criterionId: "VAL-REPORT-001",
    outcome: "pass",
    summary: "ready to complete",
    source: "subagent",
    recordedBy: "subagent:team-reviewer:report-session",
    now: "2026-05-15T01:00:00.000Z",
  });
}

describe("report completion gate", () => {
  afterEach(() => {
    clearHookSubscribers();
  });
  test("first complete attempt scaffolds REPORT.md and blocks on empty Outcome and Notes", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedCharter(projectDir);
      await recordPass(projectDir);
      const reportPath = join(dir, "REPORT.md");

      await expect(access(reportPath)).rejects.toThrow();

      let caught: unknown;
      try {
        await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("REPORT.md: Outcome section is empty");
      expect(message).toContain("REPORT.md: Notes section is empty");

      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("# Untitled");
      expect(report).toContain("Ship the OAuth callback flow.");
      expect(report).toMatch(/## Outcome\s*\n\s*\n## Notes/s);

      const state = await loadCharterState(dir);
      expect(state.status).toBe("active");
    });
  });

  test("scaffold does not overwrite existing REPORT.md content on later complete attempts", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedCharter(projectDir);
      await recordPass(projectDir);
      const reportPath = join(dir, "REPORT.md");
      await writeFile(reportPath, [
        "# Custom title",
        "",
        "## Objective",
        "",
        "Custom objective.",
        "",
        "## Outcome",
        "",
        "Custom outcome.",
        "",
        "## Notes",
        "",
        "Custom notes.",
        "",
      ].join("\n"), "utf8");

      const result = await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" });
      expect(result.status).toBe("completed");
      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("Custom title");
      expect(report).toContain("Custom notes.");
    });
  });

  test("completes after REPORT.md sections are filled and preserves before_complete hook", async () => {
    await withTempProject(async (projectDir) => {
      clearHookSubscribers();
      let hookFired = false;
      subscribeHook("charter:before_complete", async () => {
        hookFired = true;
        return { decision: "allow" };
      });

      const dir = await seedCharter(projectDir);
      await recordPass(projectDir);
      await expect(
        completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/REPORT\.md: Outcome section is empty/);

      await seedReportReadyForCompletion(dir, {
        outcome: "OAuth callback shipped.",
        notes: "No regressions observed.",
      });

      const result = await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
      expect(hookFired).toBe(true);
    });
  });

  test("charter_status surfaces report blockers with section names", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedCharter(projectDir);
      await recordPass(projectDir);
      await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" }).catch(() => undefined);

      const status = await getCharterStatus(projectDir, { charterId: CHARTER_ID });
      const reportBlockers = status.details?.blockingForComplete.filter((entry) => entry.reason.startsWith("report-")) ?? [];
      expect(reportBlockers.some((entry) => entry.description === "Outcome")).toBe(true);
      expect(reportBlockers.some((entry) => entry.description === "Notes")).toBe(true);
      expect(dir).toBeTruthy();
    });
  });
});
