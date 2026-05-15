import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, completeCharter, forceCompleteCharter, amendCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { recordEvidence } from "../src/application/record-service";
import { loadCharterState } from "../src/infrastructure/store";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-complete-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string, charterId = "cha-complete-1") {
  const charterMd = [
    "# Charter cha-complete-1",
    "",
    "## Objective",
    "Ship the OAuth callback flow.",
    "",
    "## Criteria",
    "",
    "### VAL-AUTH-001 — Callback exchanges code for tokens",
    "Verifier: manual",
    "",
    "### VAL-AUTH-002 — Tokens persisted to keychain",
    "Verifier: manual",
    "",
    "## Scope and constraints",
    "",
    "- Stay within auth module.",
    "",
  ].join("\n");
  const featureMd = (id: string, fulfills: string[]) =>
    [
      "---",
      `id: ${id}`,
      "milestone: m1-oauth",
      "order: 1",
      `fulfills: [${fulfills.join(", ")}]`,
      "preconditions: []",
      "---",
      "",
      `# Feature ${id}`,
      "",
    ].join("\n");
  await createCharter(projectDir, { objective: "Ship OAuth callback", charterId, now: "2026-05-15T00:00:00.000Z" });
  const charterDir = join(projectDir, ".pi", "charters", charterId);
  await writeFile(join(charterDir, "charter.md"), charterMd, "utf8");
  await mkdir(join(charterDir, "plan"), { recursive: true });
  await writeFile(join(charterDir, "plan", "f1-callback.md"), featureMd("f1-callback", ["VAL-AUTH-001"]), "utf8");
  await writeFile(join(charterDir, "plan", "f2-tokens.md"), featureMd("f2-tokens", ["VAL-AUTH-002"]), "utf8");
  await lockPlan(projectDir, { charterId, now: "2026-05-15T01:00:00.000Z" });
}

describe("charter_manage complete", () => {
  test("rejects completion when criteria lack pass evidence", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        completeCharter(projectDir, { charterId: "cha-complete-1", now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/VAL-AUTH-001|VAL-AUTH-002|no pass evidence/i);
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "cha-complete-1"));
      expect(state.status).toBe("active");
    });
  });

  test("completes when all criteria have pass evidence", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: "cha-complete-1",
        criterionId: "VAL-AUTH-001",
        featureId: "f1-callback",
        outcome: "pass",
        summary: "callback works",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: "cha-complete-1",
        criterionId: "VAL-AUTH-002",
        featureId: "f2-tokens",
        outcome: "pass",
        summary: "tokens persisted",
        now: "2026-05-15T02:30:00.000Z",
      });
      const result = await completeCharter(projectDir, { charterId: "cha-complete-1", now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "cha-complete-1"));
      expect(state.status).toBe("completed");
      expect(state.completedAt).toBe("2026-05-15T03:00:00.000Z");
      const events = (await readFile(join(projectDir, ".pi", "charters", "cha-complete-1", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.some((event) => event.type === "charter_completed")).toBe(true);
    });
  });

  test("rejects completion of a paused charter without explicit resume", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      // Force into paused via direct state edit not allowed; use pauseCharter via service indirectly.
      const { pauseCharter } = await import("../src/application/service");
      await pauseCharter(projectDir, { charterId: "cha-complete-1", now: "2026-05-15T02:00:00.000Z" });
      await expect(
        completeCharter(projectDir, { charterId: "cha-complete-1", now: "2026-05-15T02:30:00.000Z" }),
      ).rejects.toThrow(/paused|status/i);
    });
  });
});

describe("charter_manage force_complete", () => {
  test("requires reason and transitions to abandoned by default", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        forceCompleteCharter(projectDir, { charterId: "cha-complete-1", reason: "", now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/reason/i);
      const result = await forceCompleteCharter(projectDir, {
        charterId: "cha-complete-1",
        reason: "Out of scope; superseded by another charter.",
        now: "2026-05-15T02:00:00.000Z",
      });
      expect(result.status).toBe("abandoned");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "cha-complete-1"));
      expect(state.status).toBe("abandoned");
    });
  });

  test("can force into completed status when asked explicitly", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      const result = await forceCompleteCharter(projectDir, {
        charterId: "cha-complete-1",
        reason: "Manually verified by user; skipping evidence.",
        target: "completed",
        now: "2026-05-15T02:00:00.000Z",
      });
      expect(result.status).toBe("completed");
    });
  });
});

describe("charter_manage amend_charter", () => {
  test("reopens a completed charter into review", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: "cha-complete-1",
        criterionId: "VAL-AUTH-001",
        featureId: "f1-callback",
        outcome: "pass",
        summary: "callback works",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: "cha-complete-1",
        criterionId: "VAL-AUTH-002",
        featureId: "f2-tokens",
        outcome: "pass",
        summary: "tokens persisted",
        now: "2026-05-15T02:30:00.000Z",
      });
      await completeCharter(projectDir, { charterId: "cha-complete-1", now: "2026-05-15T03:00:00.000Z" });
      const result = await amendCharter(projectDir, {
        charterId: "cha-complete-1",
        reason: "Discovered VAL-AUTH-003 must be added.",
        now: "2026-05-15T04:00:00.000Z",
      });
      expect(result.status).toBe("review");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "cha-complete-1"));
      expect(state.status).toBe("review");
    });
  });

  test("rejects amending an active charter", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await expect(
        amendCharter(projectDir, {
          charterId: "cha-complete-1",
          reason: "any reason",
          now: "2026-05-15T02:00:00.000Z",
        }),
      ).rejects.toThrow(/active|terminal/i);
    });
  });
});
