import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askCharter, createCharter, getCharterStatus, resumeCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { formatCharterStatusText } from "../src/application/registration";
import { CharterToolError } from "../src/application/errors";
import { RALPH_SKIP_STATUSES } from "../src/application/ralph-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-ask-state-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
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

async function createPlanningCharter(projectDir: string, charterId = "ask-state-1") {
  return createCharter(projectDir, {
    objective: "Clarify the charter plan",
    charterId,
    now: "2026-05-21T01:00:00.000Z",
  });
}

async function makeActiveCharter(projectDir: string, charterId = "ask-state-active") {
  await createPlanningCharter(projectDir, charterId);
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), [
    `# Charter ${charterId}`,
    "",
    "## Objective",
    "Clarify the charter plan.",
    "",
    "## Criteria",
    "",
    "### VAL-ASK-ACTIVE — Active criterion",
    "Verifier: manual",
    "Because: enough rationale",
    "",
    "## Scope and constraints",
    "",
    "- Keep it small.",
    "",
  ].join("\n"), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1.md"), [
    "---",
    "id: f1",
    "milestone: m1-ask",
    "order: 1",
    "fulfills: [VAL-ASK-ACTIVE]",
    "preconditions: []",
    "---",
    "",
    "# Feature f1",
    "",
    VALIDATION_MD,
  ].join("\n"), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-21T01:01:00.000Z" });
}

async function writeAutonomousConfig(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".pi", "charter");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "charter-config.json"), JSON.stringify({ policy: "autonomous" }), "utf8");
}

describe("v2 ask state", () => {
  test("ask flips status from planning", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createPlanningCharter(projectDir);

      const asked = await askCharter(projectDir, {
        charterId: created.charterId,
        note: "Which scope should ship first?",
        now: "2026-05-21T01:02:00.000Z",
      });

      expect(asked.status).toBe("awaiting-clarification");
      expect(asked.nextActions).toEqual([
        { tool: "charter_manage", action: "resume", hint: "Resume after the user provides clarification." },
      ]);
      const status = await getCharterStatus(projectDir, { charterId: created.charterId });
      expect(status.status).toBe("awaiting-clarification");
      expect(status.phase).toBe("planning");
    });
  });

  test("resume restores planning", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createPlanningCharter(projectDir);
      await askCharter(projectDir, { charterId: created.charterId, now: "2026-05-21T01:02:00.000Z" });

      const resumed = await resumeCharter(projectDir, { charterId: created.charterId, now: "2026-05-21T01:03:00.000Z" });

      expect(resumed.status).toBe("planning");
      const status = await getCharterStatus(projectDir, { charterId: created.charterId });
      expect(status.status).toBe("planning");
    });
  });

  test("ralph skips awaiting-clarification", () => {
    expect(RALPH_SKIP_STATUSES.has("awaiting-clarification")).toBe(true);
  });

  test("rejected outside planning", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);

      let caught: unknown;
      try {
        await askCharter(projectDir, { charterId: "ask-state-active" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CharterToolError);
      expect((caught as CharterToolError).code).toBe("ask.not_planning");
    });
  });

  test("rejected when autonomous", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createPlanningCharter(projectDir);
      await writeAutonomousConfig(projectDir);

      let caught: unknown;
      try {
        await askCharter(projectDir, { charterId: created.charterId });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CharterToolError);
      expect((caught as CharterToolError).code).toBe("ask.policy_autonomous");
    });
  });

  test("clarificationNote surfaced in status", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createPlanningCharter(projectDir);
      await askCharter(projectDir, {
        charterId: created.charterId,
        note: "Need one crisp answer.",
        now: "2026-05-21T01:02:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId: created.charterId });
      expect(status.clarificationNote).toBe("Need one crisp answer.");
      const text = formatCharterStatusText(status);
      expect(text).toContain("clarification: Need one crisp answer.");
    });
  });
});
