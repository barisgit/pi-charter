import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { loadCharterState } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-lockplan-"));
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

const FEATURE = (id: string, fulfills: string[]) =>
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

async function seedCharter(projectDir: string, charterId: string, charterMd: string, features: Array<{ id: string; fulfills: string[] }>) {
  await createCharter(projectDir, { objective: "lock-plan test", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  for (const f of features) {
    await writeFile(join(dir, "plan", `${f.id}.md`), FEATURE(f.id, f.fulfills), "utf8");
  }
}

describe("lockPlan weak-verifier BLOCK", () => {
  test("rejects when a VAL has Verifier: manual and no criterion-level Because: (legacy=false)", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-1";
      const charterMd = [
        "# Charter",
        "",
        "## Objective",
        "Test weak verifier block.",
        "",
        "## Criteria",
        "",
        "### VAL-W-001 — Weak manual",
        "Verifier: manual",
        "",
        "### VAL-W-002 — Strong manual",
        "Verifier: manual",
        "Because: author note for VAL-W-002",
        "",
        "## Scope and constraints",
        "",
        "- none",
        "",
      ].join("\n");
      await seedCharter(projectDir, charterId, charterMd, [
        { id: "f1", fulfills: ["VAL-W-001"] },
        { id: "f2", fulfills: ["VAL-W-002"] },
      ]);
      await expect(lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" })).rejects.toThrow(
        /VAL-W-001|weak verifier|because/i,
      );
      const state = await loadCharterState(join(projectDir, ".pi", "charters", charterId));
      expect(state.status).toBe("planning");
    });
  });

  test("passes when every manual criterion has Because: (legacy=false)", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-2";
      const charterMd = [
        "# Charter",
        "",
        "## Objective",
        "Test strong manual passes.",
        "",
        "## Criteria",
        "",
        "### VAL-W-001 — Strong 1",
        "Verifier: manual",
        "Because: rationale 1",
        "",
        "### VAL-W-002 — Strong 2",
        "Verifier: manual",
        "Because: rationale 2",
        "",
        "## Scope and constraints",
        "",
        "- none",
        "",
      ].join("\n");
      await seedCharter(projectDir, charterId, charterMd, [
        { id: "f1", fulfills: ["VAL-W-001"] },
        { id: "f2", fulfills: ["VAL-W-002"] },
      ]);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
      expect(result.status).toBe("active");
    });
  });

  test("legacy: true allows lock_plan even when Verifier: is missing entirely", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-lock-3";
      const charterMd = [
        "# Charter",
        "",
        "## Objective",
        "Legacy lock should pass.",
        "",
        "## Criteria",
        "",
        "### VAL-LEG-001 — Legacy",
        "Description: missing verifier line, legacy charter",
        "",
        "## Scope and constraints",
        "",
        "- none",
        "",
      ].join("\n");
      await seedCharter(projectDir, charterId, charterMd, [
        { id: "f1", fulfills: ["VAL-LEG-001"] },
      ]);
      const result = await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z", legacy: true });
      expect(result.status).toBe("active");
    });
  });
});
