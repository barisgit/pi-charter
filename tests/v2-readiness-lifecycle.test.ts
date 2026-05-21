import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterToolError } from "../src/application/errors";
import { lockPlan } from "../src/application/plan-service";
import { createCharter, getCharterStatus } from "../src/application/service";
import { parseFeatureMarkdown } from "../src/domain/feature-md";
import type { ReadinessProbeResult } from "../src/application/readiness-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-readiness-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMarkdown(): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "Test readiness lifecycle.",
    "",
    "## Criteria",
    "",
    "### VAL-READY-001 — Readiness lifecycle",
    "Verifier: manual",
    "Because: author rationale for readiness lifecycle",
    "",
    "## Scope and constraints",
    "",
    "- none",
    "",
  ].join("\n");
}

function readinessFeatureMarkdown(id = "f-ready"): string {
  return [
    "---",
    `id: ${id}`,
    "milestone: m1",
    "order: 1",
    "fulfills: [VAL-READY-001]",
    "preconditions: []",
    "kind: readiness",
    "---",
    "",
    `# ${id}`,
  ].join("\n");
}

async function seedPlanningCharter(projectDir: string, charterId: string, featureId = "f-ready"): Promise<string> {
  await createCharter(projectDir, { objective: "readiness lifecycle", charterId, now: "2026-05-21T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMarkdown(), "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", `${featureId}.md`), readinessFeatureMarkdown(featureId), "utf8");
  return dir;
}

async function writeReadinessEvidence(
  charterDir: string,
  featureId: string,
  probeResult: ReadinessProbeResult,
  probedAt = "2026-05-21T00:02:00.000Z",
): Promise<void> {
  const evidenceDir = join(charterDir, "evidence", featureId);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, `${probedAt}.readiness.json`), JSON.stringify({
    kind: "readiness",
    featureId,
    probeResult,
    probedAt,
    details: { dependency: "test" },
    summary: `Readiness probe ${probeResult}.`,
    because: "The test fixture controls the latest readiness probe result.",
  }, null, 2), "utf8");
}

async function expectLockError(projectDir: string, charterId: string): Promise<CharterToolError> {
  try {
    await lockPlan(projectDir, { charterId, now: "2026-05-21T00:03:00.000Z" });
  } catch (err) {
    expect(err).toBeInstanceOf(CharterToolError);
    return err as CharterToolError;
  }
  throw new Error("Expected lockPlan to fail");
}

describe("v2 readiness lifecycle", () => {
  test("kind parses: kind:readiness feature parses", () => {
    const feature = parseFeatureMarkdown(readinessFeatureMarkdown());

    expect(feature.kind).toBe("readiness");
  });

  test("probe result in status: charter_status shows latest readiness probeResult on row", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-readiness-status";
      const charterDir = await seedPlanningCharter(projectDir, charterId);
      await writeReadinessEvidence(charterDir, "f-ready", "blocking", "2026-05-21T00:01:00.000Z");
      await writeReadinessEvidence(charterDir, "f-ready", "verified", "2026-05-21T00:02:00.000Z");

      const status = await getCharterStatus(projectDir, { charterId });
      const row = status.drift.readyNext.find((entry) => entry.featureId === "f-ready");

      expect(row).toBeDefined();
      expect(row?.probeResult).toBe("verified");
    });
  });

  test("blocking blocks lock: readiness feature with blocking probeResult fails lock", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-readiness-lock";
      const charterDir = await seedPlanningCharter(projectDir, charterId);
      await writeReadinessEvidence(charterDir, "f-ready", "blocking");

      const err = await expectLockError(projectDir, charterId);

      expect(err.code).toBe("lock_plan.readiness_blocking");
      expect(err.message).toContain("f-ready");
    });
  });

  test("blocking flagged completion: active charter status lists blocking readiness feature", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "cha-readiness-complete";
      const charterDir = await seedPlanningCharter(projectDir, charterId);
      await lockPlan(projectDir, { charterId, now: "2026-05-21T00:01:00.000Z" });
      await writeReadinessEvidence(charterDir, "f-ready", "blocking", "2026-05-21T00:02:00.000Z");

      const status = await getCharterStatus(projectDir, { charterId });
      const row = status.details?.blockingForComplete.find((entry) => entry.featureId === "f-ready");

      expect(row).toBeDefined();
      expect(row?.reason).toBe("readiness-blocking");
      expect(row?.probeResult).toBe("blocking");
    });
  });
});
