import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-drift-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const VALIDATION_MD = `## Validation

### Happy
- check: smoke-happy
  command: true

### Edge
- check: smoke-edge
  command: true
`;

async function makeActiveCharter(projectDir: string, charterId = "cha-drift-1") {
  const charterMd = [
    "# Charter cha-drift-1",
    "",
    "## Objective",
    "Ship the auth module.",
    "",
    "## Criteria",
    "",
    "### VAL-D-001 — Callback works",
    "Verifier: manual",
    "",
    "### VAL-D-002 — Tokens persisted",
    "Verifier: manual",
    "Require fresh evidence: true",
    "",
    "### VAL-D-003 — Logging",
    "Verifier: manual",
    "",
    "## Scope and constraints",
    "",
    "- Stay inside auth module.",
    "",
  ].join("\n");
  const feature = (id: string, fulfills: string[], preconditions: string[] = []) =>
    [
      "---",
      `id: ${id}`,
      "milestone: m1",
      "order: 1",
      `fulfills: [${fulfills.join(", ")}]`,
      `preconditions: [${preconditions.join(", ")}]`,
      "---",
      "",
      `# ${id}`,
      "",
      VALIDATION_MD,
    ].join("\n");
  await createCharter(projectDir, { objective: "Ship auth", charterId, now: "2026-05-15T00:00:00.000Z" });
  const dir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(dir, "charter.md"), charterMd, "utf8");
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(join(dir, "plan", "f1-callback.md"), feature("f1-callback", ["VAL-D-001"]), "utf8");
  await writeFile(join(dir, "plan", "f2-tokens.md"), feature("f2-tokens", ["VAL-D-002"], ["f1-callback"]), "utf8");
  await writeFile(join(dir, "plan", "f3-logging.md"), feature("f3-logging", ["VAL-D-003"]), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z", legacy: true });
}

describe("charter_status drift views", () => {
  test("reports uncovered criteria, readyNext features, and stale fresh-evidence criteria", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      // Record stale evidence for VAL-D-002 (requires fresh evidence): older than 24h window.
      await recordEvidence(projectDir, {
        charterId: "cha-drift-1",
        criterionId: "VAL-D-002",
        featureId: "f2-tokens",
        outcome: "pass",
        summary: "tokens persisted (long ago)",
        because: "manual sign-off (stale on purpose)",
        now: "2024-01-01T00:00:00.000Z",
      });
      const status = await getCharterStatus(projectDir, { charterId: "cha-drift-1" });
      const uncoveredIds = status.drift.uncovered.map((entry: any) => entry.criterionId);
      expect(uncoveredIds).toContain("VAL-D-001");
      expect(uncoveredIds).toContain("VAL-D-003");
      expect(uncoveredIds).not.toContain("VAL-D-002");
      const staleIds = status.drift.stale.map((entry: any) => entry.criterionId);
      expect(staleIds).toContain("VAL-D-002");
      const readyIds = status.drift.readyNext.map((entry: any) => entry.featureId);
      // f1-callback has no preconditions and fulfills uncovered VAL-D-001 -> ready
      expect(readyIds).toContain("f1-callback");
      // f2-tokens preconditioned on f1-callback (not completed) -> not ready
      expect(readyIds).not.toContain("f2-tokens");
      // f3-logging has no preconditions and fulfills uncovered VAL-D-003 -> ready
      expect(readyIds).toContain("f3-logging");
    });
  });
});
