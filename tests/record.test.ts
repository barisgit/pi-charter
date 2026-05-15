import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence, verifyCriterion } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-charter-record-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Implement OAuth callback",
    charterId,
    now: "2026-05-15T02:00:00.000Z",
  });
  const dir = charterDir(projectDir, charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n\n## Objective\n\nImplement OAuth callback.\n\n## Criteria\n\n### VAL-AUTH-001 — Callback validates state\n\nDescription: Invalid state is rejected.\nVerifier: command\n\n### VAL-AUTH-002 — Tokens are persisted\n\nDescription: Tokens are stored.\nVerifier: manual\n`,
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1-state.md"),
    `---\nid: f1-state\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-AUTH-001\npreconditions: []\n---\n\n# State\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "plan", "f2-tokens.md"),
    `---\nid: f2-tokens\nmilestone: m1\norder: 2\nfulfills:\n  - VAL-AUTH-002\npreconditions:\n  - f1-state\n---\n\n# Tokens\n`,
    "utf8",
  );
  await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z" });
  return dir;
}

describe("charter_record evidence", () => {
  test("writes an evidence record under the feature directory and updates criterion-state", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000301";
      const dir = await makeActiveCharter(projectDir, charterId);

      const result = await recordEvidence(projectDir, {
        charterId,
        criterionId: "VAL-AUTH-001",
        featureId: "f1-state",
        outcome: "pass",
        summary: "bun test tests/auth.test.ts pass",
        artifacts: ["tests/auth.test.ts"],
        now: "2026-05-15T03:00:00.000Z",
      });

      expect(result.criterionId).toBe("VAL-AUTH-001");
      expect(result.featureId).toBe("f1-state");
      expect(result.outcome).toBe("pass");
      expect(result.path.endsWith("__2026-05-15T03-00-00-000Z.json")).toBe(true);

      const stored = JSON.parse(await readFile(join(dir, "work", "f1-state", "evidence", "VAL-AUTH-001__2026-05-15T03-00-00-000Z.json"), "utf8"));
      expect(stored.summary).toBe("bun test tests/auth.test.ts pass");
      expect(stored.artifacts).toEqual(["tests/auth.test.ts"]);

      const criterionState = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8"));
      expect(criterionState.criteria["VAL-AUTH-001"].outcome).toBe("pass");
      expect(criterionState.criteria["VAL-AUTH-001"].lastEvidencePath).toContain("VAL-AUTH-001__");
      expect(result.nextActions.length).toBeGreaterThan(0);
    });
  });

  test("rejects evidence for unknown criterion", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000302";
      await makeActiveCharter(projectDir, charterId);
      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-UNKNOWN-999",
          outcome: "pass",
          summary: "x",
        }),
      ).rejects.toThrow(/unknown criterion/i);
    });
  });

  test("rejects evidence when charter is in planning", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000303";
      await createCharter(projectDir, { objective: "x", charterId, now: "2026-05-15T02:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      await writeFile(
        join(dir, "charter.md"),
        `# Charter\n\n## Objective\n\nx.\n\n## Criteria\n\n### VAL-X-001 — X\n\nDescription: x.\nVerifier: manual\n`,
        "utf8",
      );
      await expect(
        recordEvidence(projectDir, {
          charterId,
          criterionId: "VAL-X-001",
          outcome: "pass",
          summary: "x",
        }),
      ).rejects.toThrow(/planning/i);
    });
  });
});

describe("charter_record verify (command verifier)", () => {
  async function makeCommandCharter(projectDir: string, charterId: string, command: string): Promise<string> {
    await createCharter(projectDir, { objective: "verify", charterId, now: "2026-05-15T02:00:00.000Z" });
    const dir = charterDir(projectDir, charterId);
    await writeFile(
      join(dir, "charter.md"),
      `# Charter\n\n## Objective\n\nverify.\n\n## Criteria\n\n### VAL-CMD-001 — Command runs\n\nDescription: cmd.\nVerifier: command\nCommand: ${command}\n`,
      "utf8",
    );
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFile(
      join(dir, "plan", "f1.md"),
      `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-CMD-001\npreconditions: []\n---\n\n# F1\n`,
      "utf8",
    );
    await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z" });
    return dir;
  }

  test("records pass evidence when command exits 0", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000401";
      const dir = await makeCommandCharter(projectDir, charterId, "echo hello");
      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-CMD-001",
        featureId: "f1",
        now: "2026-05-15T03:00:00.000Z",
      });
      expect(result.outcome).toBe("pass");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
      const stored = JSON.parse(await readFile(join(dir, result.path), "utf8"));
      expect(stored.details.exitCode).toBe(0);
      expect(stored.source).toBe("verifier");
    });
  });

  test("records fail evidence when command exits non-zero", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000402";
      await makeCommandCharter(projectDir, charterId, "sh -c 'echo boom 1>&2; exit 2'");
      const result = await verifyCriterion(projectDir, {
        charterId,
        criterionId: "VAL-CMD-001",
        now: "2026-05-15T03:00:00.000Z",
      });
      expect(result.outcome).toBe("fail");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("boom");
    });
  });

  test("rejects criteria without a command", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = "00000000-0000-4000-8000-000000000403";
      await createCharter(projectDir, { objective: "verify", charterId, now: "2026-05-15T02:00:00.000Z" });
      const dir = charterDir(projectDir, charterId);
      await writeFile(
        join(dir, "charter.md"),
        `# Charter\n\n## Objective\n\nverify.\n\n## Criteria\n\n### VAL-CMD-001 — Manual\n\nDescription: cmd.\nVerifier: manual\n`,
        "utf8",
      );
      await mkdir(join(dir, "plan"), { recursive: true });
      await writeFile(join(dir, "plan", "f1.md"), `---\nid: f1\nmilestone: m1\norder: 1\nfulfills:\n  - VAL-CMD-001\npreconditions: []\n---\n\nx\n`, "utf8");
      await lockPlan(projectDir, { charterId, now: "2026-05-15T02:30:00.000Z" });
      await expect(
        verifyCriterion(projectDir, { charterId, criterionId: "VAL-CMD-001" }),
      ).rejects.toThrow(/not implemented|command verifier/i);
    });
  });
});
