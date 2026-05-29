import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCharterStatusText } from "../src/application/registration";
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

function criteriaMarkdown(): string {
  return [
    "# Criteria",
    "",
    "## m2 Second milestone",
    "",
    "### VAL-D — fourth",
    "Verifier: manual",
    "Because: author rationale",
    "Description: VAL-D.",
    "",
    "## m1 First milestone",
    "",
    "### VAL-A — first",
    "Verifier: manual",
    "Because: author rationale",
    "Description: VAL-A.",
    "",
    "### VAL-B — second",
    "Verifier: manual",
    "Because: author rationale",
    "Description: VAL-B.",
    "",
    "### VAL-C — third",
    "Verifier: manual",
    "Because: author rationale",
    "Description: VAL-C.",
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
  test("renders milestones from criteria.md with compact per-milestone VAL counts", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-ms-render";
      await createCharter(projectDir, {
        objective: "Milestone status rendering",
        charterId,
        now: "2026-05-20T00:00:00.000Z",
      });
      const dir = charterDir(projectDir, charterId);
      await writeFile(join(dir, "criteria.md"), criteriaMarkdown(), "utf8");

      await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-A",
        outcome: "pass",
        summary: "VAL-A pass",
        because: "manual sign-off",
        now: "2026-05-20T01:00:00.000Z",
      });

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.milestones.map((milestone) => milestone.milestoneId)).toEqual(["m2", "m1"]);
      expect(status.milestones[0]).toMatchObject({
        milestoneId: "m2",
        valCount: 1,
        valPassCount: 0,
        criterionIds: ["VAL-D"],
      });
      expect(status.milestones[1]).toMatchObject({
        milestoneId: "m1",
        valCount: 3,
        valPassCount: 1,
        criterionIds: ["VAL-A", "VAL-B", "VAL-C"],
      });

      const text = formatCharterStatusText(status);
      expect(text).toContain("  milestones:");
      expect(text).toContain("    - m2: VALs=1 pass=0 :: VAL-D");
      expect(text).toContain("    - m1: VALs=3 pass=1 :: VAL-A, VAL-B, VAL-C");
      const milestoneLines = text.split("\n").filter((line) => line.startsWith("    - m"));
      expect(milestoneLines).toEqual([
        "    - m2: VALs=1 pass=0 :: VAL-D",
        "    - m1: VALs=3 pass=1 :: VAL-A, VAL-B, VAL-C",
      ]);
    });
  });
});
