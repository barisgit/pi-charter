import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendCharter, completeCharter, createCharter, getCharterStatus } from "../src/application/service";
import { formatCharterStatusText } from "../src/application/registration";
import { lockPlan, viewPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { charterDir, loadCharterState, writeJsonAtomic } from "../src/infrastructure/store";
import { CharterToolError } from "../src/application/errors";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v2-migration-"));
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

const V1_CHARTER_MD = [
  "# Charter",
  "",
  "## Objective",
  "",
  "Continue legacy charter.",
  "",
  "## Criteria",
  "",
  "### VAL-X Legacy criterion",
  "Description: old VAL shape.",
  "Verifier: manual",
  "Because: legacy rationale",
  "",
  "## Scope and constraints",
  "",
  "- Preserve files.",
  "",
].join("\n");

const V2_CHARTER_MD = [
  "# Charter",
  "",
  "## Objective",
  "",
  "Ship v2 charter.",
  "",
  "## Criteria",
  "",
  "### VAL-OK v2 criterion",
  "Description: fresh v2 charter still uses current parser until the v2 surface lands.",
  "Verifier: manual",
  "Because: authored rationale",
  "",
  "## Scope and constraints",
  "",
  "- Stay small.",
  "",
].join("\n");

async function writeV1Fixture(projectDir: string, charterId: string): Promise<string> {
  const dir = charterDir(projectDir, charterId);
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeJsonAtomic(join(dir, "state.json"), {
    charterId,
    objective: "Continue legacy charter.",
    status: "active",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T01:00:00.000Z",
  });
  await writeFile(join(dir, "charter.md"), V1_CHARTER_MD, "utf8");
  await writeJsonAtomic(join(dir, "criterion-state.json"), { charterId, criteria: {} });
  await writeJsonAtomic(join(dir, "feature-state.json"), { charterId, features: {} });
  await writeFile(
    join(dir, "plan", "f1.md"),
    [
      "---",
      "id: f1",
      "milestone: m1",
      "order: 1",
      "fulfills:",
      "  - VAL-X",
      "preconditions: []",
      "---",
      "",
      "# Legacy feature",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  return dir;
}

async function makeV2ActiveCharter(projectDir: string, charterId: string): Promise<void> {
  await createCharter(projectDir, {
    objective: "Ship v2 charter.",
    charterId,
    now: "2026-05-20T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(join(dir, "charter.md"), V2_CHARTER_MD, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    [
      "---",
      "id: f1",
      "milestone: m1",
      "order: 1",
      "fulfills:",
      "  - VAL-OK",
      "preconditions: []",
      "---",
      "",
      "# v2 feature",
      "",
      VALIDATION_MD,
    ].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-20T01:00:00.000Z" });
}

async function expectReplanRequired(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected migration.replan_required");
  } catch (error) {
    expect(error).toBeInstanceOf(CharterToolError);
    expect((error as CharterToolError).code).toBe("migration.replan_required");
    expect(String((error as Error).message)).toContain("migration.replan_required");
  }
}

describe("v2 migration", () => {
  test("v1-charter-flagged-on-load", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000f111";
      await writeV1Fixture(projectDir, charterId);

      const state = await loadCharterState(projectDir, charterId);
      expect(state.schemaVersion).toBe("v1-needs-replan");

      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.schemaVersion).toBe("v1-needs-replan");
      expect(status.migrationHint).toContain("amend_charter");
      expect(status.nextActions.map((action) => `${action.tool}:${action.action ?? ""}`)).toContain("charter_manage:amend_charter");
      const text = formatCharterStatusText(status);
      expect(text).toContain("migration:");
      expect(text).toContain("docs/v1-to-v2-migration.md");
    });
  });

  test("v1-charter-refuses-mutating-actions", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000f112";
      await writeV1Fixture(projectDir, charterId);

      await expectReplanRequired(recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-X",
        outcome: "pass",
        summary: "legacy check passed",
        because: "testing migration refusal",
      }));
      await expectReplanRequired(viewPlan(projectDir, { charterId }));
      await expectReplanRequired(lockPlan(projectDir, { charterId }));
      await expectReplanRequired(completeCharter(projectDir, { charterId }));
    });
  });

  test("v2-charter-loads-normally", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000f113";
      await makeV2ActiveCharter(projectDir, charterId);

      const state = await loadCharterState(projectDir, charterId);
      expect(state.schemaVersion).toBe("v2");
      const status = await getCharterStatus(projectDir, { charterId });
      expect(status.migrationHint).toBeUndefined();

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-OK",
        featureId: "f1",
        outcome: "pass",
        summary: "v2-shaped charter can still record evidence",
        because: "fresh create stamped schemaVersion v2",
        now: "2026-05-20T02:00:00.000Z",
      });
      expect(result.outcome).toBe("pass");
    });
  });

  test("amend-from-v1-works", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-00000000f114";
      const dir = await writeV1Fixture(projectDir, charterId);

      const result = await amendCharter(projectDir, {
        charterId,
        reason: "manual v2 replan",
        target: "planning",
        now: "2026-05-20T02:00:00.000Z",
      });
      expect(result.status).toBe("planning");
      const state = await loadCharterState(projectDir, charterId);
      expect(state.schemaVersion).toBe("v2");
      expect(await readFile(join(dir, "criterion-state.json"), "utf8")).toContain(charterId);
    });
  });

  test("migration-doc-exists", async () => {
    const doc = await readFile(join(process.cwd(), "docs", "v1-to-v2-migration.md"), "utf8");
    expect(doc).toContain("manual replan");
  });
});
