import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, completeCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { clearHookSubscribers, subscribeHook } from "../src/application/hooks";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-hooks-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = [
  "## Validation",
  "",
  "### Happy",
  "- check: smoke-happy",
  "  command: true",
  "",
  "### Edge",
  "- check: smoke-edge",
  "  command: true",
  "",
].join("\n");

async function writeCharter(projectDir: string, charterId: string, body: string) {
  const dir = join(projectDir, ".pi/charters", charterId);
  await writeFile(join(dir, "charter.md"), body);
}

async function writeFeature(projectDir: string, charterId: string, file: string, body: string) {
  const planDir = join(projectDir, ".pi/charters", charterId, "plan");
  await mkdir(planDir, { recursive: true });
  await writeFile(join(planDir, file), body);
}

describe("charter hook bus", () => {
  beforeEach(() => clearHookSubscribers());

  it("blocks lock_plan when a charter:before_lock_plan subscriber returns block", async () => {
    await withTempProject(async (projectDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Ship hook bus",
        now: "2026-05-15T00:00:00.000Z",
      });
      await writeCharter(
        projectDir,
        charter.charterId,
        `# Charter\n## Objective\nShip hook bus\n## Criteria\n### VAL-HOOK-001 — covered\nVerifier: manual\nBecause: hook bus probe is exercised by hand\n## Scope and constraints\n- none\n`,
      );
      await writeFeature(
        projectDir,
        charter.charterId,
        "f1.md",
        `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-HOOK-001]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}\n`,
      );

      subscribeHook("charter:before_lock_plan", () => ({ decision: "block", reason: "manual review pending" }));

      await expect(lockPlan(projectDir, { charterId: charter.charterId })).rejects.toThrow(/manual review pending/i);
    });
  });

  it("allows lock_plan when subscriber returns allow", async () => {
    await withTempProject(async (projectDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Ship hook bus",
        now: "2026-05-15T00:00:00.000Z",
      });
      await writeCharter(
        projectDir,
        charter.charterId,
        `# Charter\n## Objective\nShip hook bus\n## Criteria\n### VAL-HOOK-001 — covered\nVerifier: manual\nBecause: hook bus probe is exercised by hand\n## Scope and constraints\n- none\n`,
      );
      await writeFeature(
        projectDir,
        charter.charterId,
        "f1.md",
        `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-HOOK-001]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}\n`,
      );

      const seen: string[] = [];
      subscribeHook("charter:before_lock_plan", (payload) => {
        seen.push(payload.charterId);
        return { decision: "allow" };
      });

      const result = await lockPlan(projectDir, { charterId: charter.charterId });
      expect(result.status).toBe("active");
      expect(seen).toEqual([charter.charterId]);
    });
  });

  it("blocks complete when charter:before_complete subscriber returns block", async () => {
    await withTempProject(async (projectDir) => {
      const charter = await createCharter(projectDir, {
        objective: "Ship hook bus",
        now: "2026-05-15T00:00:00.000Z",
      });
      await writeCharter(
        projectDir,
        charter.charterId,
        `# Charter\n## Objective\nShip hook bus\n## Criteria\n### VAL-HOOK-001 — covered\nVerifier: manual\nBecause: hook bus probe is exercised by hand\n## Scope and constraints\n- none\n`,
      );
      await writeFeature(
        projectDir,
        charter.charterId,
        "f1.md",
        `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-HOOK-001]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}\n`,
      );
      await lockPlan(projectDir, { charterId: charter.charterId });
      await recordEvidence(projectDir, {
        charterId: charter.charterId,
        criterionId: "VAL-HOOK-001",
        outcome: "pass",
        summary: "reviewed by subagent",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-hook",
        now: "2026-05-15T01:00:00.000Z",
      });

      subscribeHook("charter:before_complete", () => ({ decision: "block", reason: "external gate not passed" }));

      await expect(
        completeCharter(projectDir, { charterId: charter.charterId, now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/external gate not passed/i);
    });
  });
});
