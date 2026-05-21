import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { createCharter } from "../src/application/service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-lock-shape-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(criteria: string[]): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "Test lock shape gate.",
    "",
    "## Criteria",
    "",
    ...criteria.flatMap((id) => [
      `### ${id} — ${id}`,
      "Verifier: manual",
      `Because: concrete rationale for ${id}`,
      "",
    ]),
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

function validationBlock(kind: "happy" | "edge" | "both" | "none"): string {
  if (kind === "none") return "";
  const lines = ["", "## Validation", ""];
  if (kind === "happy" || kind === "both") {
    lines.push("### Happy", "- check: happy", "  command: bun test happy", "");
  }
  if (kind === "edge" || kind === "both") {
    lines.push("### Edge", "- check: edge", "  command: bun test edge", "");
  }
  return lines.join("\n");
}

function featureMarkdown(input: { id: string; fulfills: string; validation: "happy" | "edge" | "both" | "none"; kind?: "impl" | "readiness" | "review" | "qa" }): string {
  const kind = input.kind ? [`kind: ${input.kind}`] : [];
  return [
    "---",
    `id: ${input.id}`,
    "milestone: m1",
    "order: 1",
    `fulfills: [${input.fulfills}]`,
    "preconditions: []",
    ...kind,
    "---",
    "",
    `# ${input.id}`,
    validationBlock(input.validation),
  ].join("\n");
}

async function seedPlanningCharter(projectDir: string, charterId: string, features: Array<{ id: string; fulfills: string; validation: "happy" | "edge" | "both" | "none"; kind?: "impl" | "readiness" | "review" | "qa" }>): Promise<void> {
  await createCharter(projectDir, { objective: "lock shape gate", charterId, now: "2026-05-21T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(features.map((feature) => feature.fulfills)), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const feature of features) {
    await writeFile(join(dir, "plan", `${feature.id}.md`), featureMarkdown(feature), "utf8");
  }
}

async function expectLockError(projectDir: string, charterId: string): Promise<CharterToolError> {
  try {
    await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
  } catch (err) {
    expect(err).toBeInstanceOf(CharterToolError);
    return err as CharterToolError;
  }
  throw new Error("Expected lockPlan to fail");
}

describe("v2 lock shape gate", () => {
  test("lock-fails-on-missing-happy: feature with edge-only checks => lock fails, error mentions feature id and happy", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-shape-missing-happy";
      await seedPlanningCharter(projectDir, charterId, [
        { id: "f-edge-only", fulfills: "VAL-SHAPE-001", validation: "edge" },
      ]);

      const err = await expectLockError(projectDir, charterId);

      expect(err.message).toContain("f-edge-only");
      expect(err.message).toMatch(/happy/i);
    });
  });

  test("lock-fails-on-missing-edge: feature with happy-only checks => lock fails, error mentions edge", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-shape-missing-edge";
      await seedPlanningCharter(projectDir, charterId, [
        { id: "f-happy-only", fulfills: "VAL-SHAPE-001", validation: "happy" },
      ]);

      const err = await expectLockError(projectDir, charterId);

      expect(err.message).toContain("f-happy-only");
      expect(err.message).toMatch(/edge/i);
    });
  });

  test("readiness-exempt: kind:readiness feature with no checks => lock passes when other features pass shape", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-shape-readiness";
      await seedPlanningCharter(projectDir, charterId, [
        { id: "f-impl", fulfills: "VAL-SHAPE-001", validation: "both" },
        { id: "f-ready", fulfills: "VAL-SHAPE-002", validation: "none", kind: "readiness" },
      ]);

      const result = await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });

      expect(result.status).toBe("active");
    });
  });

  test("lists-all-offenders: 3 features failing => error lists all 3 ids", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-shape-all-offenders";
      await seedPlanningCharter(projectDir, charterId, [
        { id: "f-no-checks", fulfills: "VAL-SHAPE-001", validation: "none" },
        { id: "f-happy-only", fulfills: "VAL-SHAPE-002", validation: "happy" },
        { id: "f-edge-only", fulfills: "VAL-SHAPE-003", validation: "edge" },
      ]);

      const err = await expectLockError(projectDir, charterId);

      expect(err.message).toContain("f-no-checks");
      expect(err.message).toContain("f-happy-only");
      expect(err.message).toContain("f-edge-only");
    });
  });
});
