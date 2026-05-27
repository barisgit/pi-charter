import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCharterStatusText } from "../src/application/registration";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { createCharter, getCharterStatus } from "../src/application/service";
import { charterDir } from "../src/infrastructure/store";

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

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-milestone-status-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(criteriaIds: string[]): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "",
    "Milestone status probe.",
    "",
    "## Criteria",
    "",
    ...criteriaIds.flatMap((id) => [
      `### ${id} — ${id.toLowerCase()}`,
      `${id.startsWith("VAL-QA-") ? "Verifier: command" : "Verifier: manual"}`,
      ...(id.startsWith("VAL-QA-") ? ["Command: true"] : ["Because: author rationale"]),
      `Description: ${id}.`,
      "",
    ]),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

async function writeFeature(
  dir: string,
  input: { id: string; milestone: string; order: number; fulfills: string[] },
): Promise<void> {
  await writeFile(
    join(dir, "plan", `${input.id}.md`),
    [
      "---",
      `id: ${input.id}`,
      `milestone: ${input.milestone}`,
      `order: ${input.order}`,
      "fulfills:",
      ...input.fulfills.map((criterionId) => `  - ${criterionId}`),
      "preconditions: []",
      "---",
      "",
      `# ${input.id}`,
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
}

describe("charter_status milestone summaries", () => {
  test("renders milestones in canonical order with compact per-milestone counts", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ms-render";
      await createCharter(projectDir, {
        objective: "Milestone status rendering",
        charterId,
        now: "2026-05-20T00:00:00.000Z",
      });
      const dir = charterDir(projectDir, charterId);
      await writeFile(join(dir, "charter.md"), charterMarkdown(["VAL-A", "VAL-B", "VAL-C", "VAL-D"]), "utf8");
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFeature(dir, { id: "f-alpha", milestone: "m1", order: 2, fulfills: ["VAL-A", "VAL-B"] });
      await writeFeature(dir, { id: "f-beta", milestone: "m1", order: 3, fulfills: ["VAL-C"] });
      await writeFeature(dir, { id: "f-gamma", milestone: "m2", order: 1, fulfills: ["VAL-D"] });
      await mkdir(join(dir, "library"), { recursive: true });
      await writeFile(
        join(dir, "library", "architecture.md"),
        "# Architecture\n\nMilestone status fixture. This test charter intentionally has three implementation features so the architecture gate sees a non-trivial but focused note. The runtime details are irrelevant; the note only satisfies the lock-plan precondition for this fixture.\n",
        "utf8",
      );
      await lockPlan(projectDir, { charterId, now: "2026-05-20T00:30:00.000Z" });

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-A",
        featureId: "f-alpha",
        outcome: "pass",
        summary: "QA covered VAL-A",
        source: "subagent",
        recordedBy: "subagent:charter-qa:qa-render",
        now: "2026-05-20T01:00:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.milestones.map((milestone) => milestone.milestoneId)).toEqual(["m2", "m1"]);
      expect(status.milestones[0]).toMatchObject({
        milestoneId: "m2",
        featureCount: 1,
        fulfilledValCount: 1,
        valPassCount: 0,
        qaEvidenceCount: 0,
        featureIds: ["f-gamma"],
      });
      expect(status.milestones[1]).toMatchObject({
        milestoneId: "m1",
        featureCount: 2,
        fulfilledValCount: 3,
        valPassCount: 1,
        qaEvidenceCount: 1,
        featureIds: ["f-alpha", "f-beta"],
      });

      const text = formatCharterStatusText(status);
      expect(text).toContain("  milestones:");
      expect(text).toContain("    - m2: features=1 VALs=1 pass=0 QA=0 :: f-gamma");
      expect(text).toContain("    - m1: features=2 VALs=3 pass=1 QA=1 :: f-alpha, f-beta");
      const milestoneLines = text.split("\n").filter((line) => line.startsWith("    - m"));
      expect(milestoneLines).toEqual([
        "    - m2: features=1 VALs=1 pass=0 QA=0 :: f-gamma",
        "    - m1: features=2 VALs=3 pass=1 QA=1 :: f-alpha, f-beta",
      ]);
    });
  });
});

describe("charter_status milestone QA nextAction", () => {
  const charterId = "cha-ms-qa";
  const milestoneId = "m1-qa";

  async function seedQaCharter(projectDir: string): Promise<void> {
    await createCharter(projectDir, {
      objective: "Milestone QA action",
      charterId,
      now: "2026-05-20T00:00:00.000Z",
    });
    const dir = charterDir(projectDir, charterId);
    await writeFile(join(dir, "charter.md"), charterMarkdown(["VAL-QA-001", "VAL-QA-002"]), "utf8");
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFeature(dir, { id: "f-one", milestone: milestoneId, order: 1, fulfills: ["VAL-QA-001"] });
    await writeFeature(dir, { id: "f-two", milestone: milestoneId, order: 2, fulfills: ["VAL-QA-002"] });
    await lockPlan(projectDir, { charterId, now: "2026-05-20T00:30:00.000Z" });
  }

  function milestoneQaActions(status: Awaited<ReturnType<typeof getCharterStatus>>) {
    return status.nextActions.filter(
      (action) => action.tool === "subagent" && action.hint.includes("charter-qa") && action.hint.includes(milestoneId),
    );
  }

  function milestoneReviewActions(status: Awaited<ReturnType<typeof getCharterStatus>>) {
    return status.nextActions.filter(
      (action) => action.tool === "subagent" && action.hint.includes("charter-reviewer") && action.hint.includes(milestoneId),
    );
  }

  async function recordTypedCommandImplementation(projectDir: string): Promise<void> {
    await recordEvidence(projectDir, {
      charterId,
      criterionId: "VAL-QA-001",
      featureId: "f-one",
      outcome: "pass",
      summary: "f-one command evidence",
      source: "verifier",
      details: { kind: "command" },
      now: "2026-05-20T01:00:00.000Z",
    });
    await recordEvidence(projectDir, {
      charterId,
      criterionId: "VAL-QA-002",
      featureId: "f-two",
      outcome: "pass",
      summary: "f-two command evidence",
      source: "verifier",
      details: { kind: "command" },
      now: "2026-05-20T01:01:00.000Z",
    });
  }

  test("fires after every feature has implementation evidence and coexists with milestone review", async () => {
    await withTempProject(async (projectDir) => {
      await seedQaCharter(projectDir);
      await recordTypedCommandImplementation(projectDir);

      const status = await getCharterStatus(projectDir, { charterId });
      const qa = milestoneQaActions(status);
      expect(qa).toHaveLength(1);
      expect(qa[0]!.hint).toContain(`milestone ${milestoneId}`);
      expect(qa[0]!.hint).toContain("charter-qa");
      expect(milestoneReviewActions(status).length).toBeGreaterThanOrEqual(1);
    });
  });

  test("disappears once charter-qa pass evidence covers every VAL in the milestone", async () => {
    await withTempProject(async (projectDir) => {
      await seedQaCharter(projectDir);
      await recordTypedCommandImplementation(projectDir);

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-QA-001",
        featureId: "f-one",
        outcome: "pass",
        summary: "QA covered f-one",
        source: "subagent",
        recordedBy: "subagent:charter-qa:qa-session",
        now: "2026-05-20T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-QA-002",
        featureId: "f-two",
        outcome: "pass",
        summary: "QA covered f-two",
        source: "subagent",
        recordedBy: "subagent:charter-qa:qa-session",
        now: "2026-05-20T02:01:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(milestoneQaActions(status)).toHaveLength(0);
    });
  });

  test("does not fire when a completed feature lacks implementation evidence", async () => {
    await withTempProject(async (projectDir) => {
      await seedQaCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-QA-001",
        featureId: "f-one",
        outcome: "pass",
        summary: "manual f-one",
        because: "manual sign-off does not count as implementation evidence",
        now: "2026-05-20T01:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-QA-002",
        featureId: "f-two",
        outcome: "pass",
        summary: "manual f-two",
        because: "manual sign-off does not count as implementation evidence",
        now: "2026-05-20T01:01:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(milestoneReviewActions(status).length).toBeGreaterThanOrEqual(1);
      expect(milestoneQaActions(status)).toHaveLength(0);
    });
  });
});
