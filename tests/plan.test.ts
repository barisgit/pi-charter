import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCharter } from "../src/application/service";
import { lockPlan, viewPlan } from "../src/application/plan-service";
import { charterDir, loadCharterState } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-plan-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

describe("charter plan view", () => {
  test("computes features, uncovered criteria, and orphan features", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Implement OAuth callback",
        charterId: "00000000-0000-4000-8000-000000000201",
        now: "2026-05-15T02:00:00.000Z",
      });
      const dir = charterDir(projectDir, created.charterId);
      await writeFile(join(dir, "charter.md"), `# Charter\n\n## Objective\n\nImplement OAuth callback.\n\n## Criteria\n\n### VAL-AUTH-001 — Callback validates state\n\nDescription: Invalid state is rejected.\nVerifier: command\n\n### VAL-AUTH-002 — Tokens are persisted\n\nDescription: Tokens are stored.\nVerifier: manual\n\n## Scope and constraints\n\n- Keep existing sessions valid.\n`, "utf8");
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1-callback-state.md"), `---\nid: f1-callback-state\nmilestone: m1-auth\norder: 1\nfulfills:\n  - VAL-AUTH-001\npreconditions: []\n---\n\n# Callback state\n\nValidate OAuth state.\n`, "utf8");
      await writeFile(join(dir, "plan", "f2-orphan.md"), `---\nid: f2-orphan\nmilestone: m1-auth\norder: 2\nfulfills: []\npreconditions:\n  - f1-callback-state\n---\n\n# Orphan\n\nNo criteria yet.\n`, "utf8");

      const plan = await viewPlan(projectDir, { charterId: created.charterId });
      expect(plan.criteria.map((criterion) => criterion.id)).toEqual(["VAL-AUTH-001", "VAL-AUTH-002"]);
      expect(plan.features.map((feature) => feature.id)).toEqual(["f1-callback-state", "f2-orphan"]);
      expect(plan.drift.uncovered.map((criterion) => criterion.id)).toEqual(["VAL-AUTH-002"]);
      expect(plan.drift.orphanFeatures.map((feature) => feature.id)).toEqual(["f2-orphan"]);
      expect(plan.nextActions.map((a) => `${a.tool}:${a.action}`)).toContain("charter_plan:update_feature");
    });
  });

  test("lock_plan refuses to transition when drift exists", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Implement OAuth callback",
        charterId: "00000000-0000-4000-8000-000000000202",
        now: "2026-05-15T02:00:00.000Z",
      });
      const dir = charterDir(projectDir, created.charterId);
      await writeFile(join(dir, "charter.md"), `# Charter\n\n## Objective\n\nImplement OAuth callback.\n\n## Criteria\n\n### VAL-AUTH-001 — Callback validates state\n\nDescription: Invalid state is rejected.\nVerifier: command\n\n### VAL-AUTH-002 — Tokens are persisted\n\nDescription: Tokens are stored.\nVerifier: manual\n`, "utf8");
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1-only.md"), `---\nid: f1-only\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-AUTH-001\npreconditions: []\n---\n\n# Only one\n`, "utf8");

      await expect(lockPlan(projectDir, { charterId: created.charterId })).rejects.toThrow(/uncovered|drift|orphan/i);
      const state = await loadCharterState(projectDir, created.charterId);
      expect(state.status).toBe("planning");
    });
  });

  test("lock_plan transitions to active when plan is clean", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Implement OAuth callback",
        charterId: "00000000-0000-4000-8000-000000000203",
        now: "2026-05-15T02:00:00.000Z",
      });
      const dir = charterDir(projectDir, created.charterId);
      await writeFile(join(dir, "charter.md"), `# Charter\n\n## Objective\n\nImplement OAuth callback.\n\n## Criteria\n\n### VAL-AUTH-001 — Callback validates state\n\nDescription: Invalid state is rejected.\nVerifier: command\n\n### VAL-AUTH-002 — Tokens are persisted\n\nDescription: Tokens are stored.\nVerifier: manual\n`, "utf8");
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1-state.md"), `---\nid: f1-state\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-AUTH-001\npreconditions: []\n---\n\n# State\n\n${VALIDATION_MD}`, "utf8");
      await writeFile(join(dir, "plan", "f2-tokens.md"), `---\nid: f2-tokens\nmilestone: m1\norder: 2\nfulfills:\n  - VAL-AUTH-002\npreconditions:\n  - f1-state\n---\n\n# Tokens\n\n${VALIDATION_MD}`, "utf8");

      const result = await lockPlan(projectDir, { charterId: created.charterId, now: "2026-05-15T02:30:00.000Z", legacy: true });
      expect(result.status).toBe("active");
      expect(result.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const state = await loadCharterState(projectDir, created.charterId);
      expect(state.status).toBe("active");
      expect(state.planDigest).toBe(result.planDigest);
      expect(result.nextActions.map((action) => `${action.tool}:${action.action ?? ""}`)).toContain("charter_status:");
    });
  });

  test("lock_plan detects precondition cycles", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Cycle test",
        charterId: "00000000-0000-4000-8000-000000000204",
        now: "2026-05-15T02:00:00.000Z",
      });
      const dir = charterDir(projectDir, created.charterId);
      await writeFile(join(dir, "charter.md"), `# Charter\n\n## Objective\n\nCycle.\n\n## Criteria\n\n### VAL-CYC-001 — X\n\nDescription: x.\nVerifier: manual\n`, "utf8");
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "a.md"), `---\nid: a\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-CYC-001\npreconditions:\n  - b\n---\n\n# A\n`, "utf8");
      await writeFile(join(dir, "plan", "b.md"), `---\nid: b\nmilestone: m1\norder: 2\nfulfills:\n  - VAL-CYC-001\npreconditions:\n  - a\n---\n\n# B\n`, "utf8");

      await expect(lockPlan(projectDir, { charterId: created.charterId })).rejects.toThrow(/cycle/i);
    });
  });
});
