import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonCharter, completeCharter } from "../src/application/service";
import { amendCharter } from "../src/application/service";
import { recordEvidence } from "../src/application/record-service";
import { loadCharterState } from "../src/infrastructure/store";
import { makeActiveCharter, seedReportReadyForCompletion } from "./helpers/charter-fixtures";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-complete-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const CHARTER_ID = "cha-complete-1";

async function seedCompleteCharter(projectDir: string): Promise<void> {
  await makeActiveCharter({
    projectDir,
    charterId: CHARTER_ID,
    objective: "Ship the OAuth callback flow.",
    now: "2026-05-15T00:00:00.000Z",
    milestones: [{
      id: "m1-oauth",
      criteria: [
        {
          id: "VAL-AUTH-001",
          title: "Callback exchanges code for tokens",
          because: "code-path is too short for a CI verifier; reviewed by hand each time",
        },
        {
          id: "VAL-AUTH-002",
          title: "Tokens persisted to keychain",
          because: "keychain prompt cannot be exercised headlessly",
        },
      ],
    }],
  });
}

describe("charter complete", () => {
  test("rejects completion when criteria lack pass evidence", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await expect(
        completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/VAL-AUTH-001|VAL-AUTH-002|no pass evidence/i);
      const state = await loadCharterState(join(projectDir, ".pi", "charters", CHARTER_ID));
      expect(state.status).toBe("active");
    });
  });

  test("rejects vacuous completion when the register parsed to zero criteria", async () => {
    await withTempProject(async (projectDir) => {
      // No criteria authored => 0 parsed => must not complete as a trivial 0/0.
      await makeActiveCharter({
        projectDir,
        charterId: CHARTER_ID,
        objective: "Charter with an empty register must not complete.",
        now: "2026-05-15T00:00:00.000Z",
        criteria: [],
      });
      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", CHARTER_ID));
      await expect(
        completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/register-empty|no VAL criteria/i);
      const state = await loadCharterState(join(projectDir, ".pi", "charters", CHARTER_ID));
      expect(state.status).toBe("active");
    });
  });

  test("completes when all criteria have pass evidence from a charter-reviewer subagent", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-001",
        outcome: "pass",
        summary: "callback works",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-1",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-002",
        outcome: "pass",
        summary: "tokens persisted",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-2",
        now: "2026-05-15T02:30:00.000Z",
      });
      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", CHARTER_ID));
      const result = await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", CHARTER_ID));
      expect(state.status).toBe("completed");
      expect(state.completedAt).toBe("2026-05-15T03:00:00.000Z");
      const events = (await readFile(join(projectDir, ".pi", "charters", CHARTER_ID, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.some((event) => event.type === "charter_completed")).toBe(true);
    });
  });

  test("rejects completion of a paused charter without explicit resume", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      const { pauseCharter } = await import("../src/application/service");
      await pauseCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:00:00.000Z" });
      await expect(
        completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T02:30:00.000Z" }),
      ).rejects.toThrow(/paused|status/i);
    });
  });
});

describe("charter abandon", () => {
  test("requires reason and transitions to abandoned by default", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await expect(
        abandonCharter(projectDir, { charterId: CHARTER_ID, reason: "", now: "2026-05-15T02:00:00.000Z" }),
      ).rejects.toThrow(/reason/i);
      const result = await abandonCharter(projectDir, {
        charterId: CHARTER_ID,
        reason: "Out of scope; superseded by another charter.",
        now: "2026-05-15T02:00:00.000Z",
      });
      expect(result.status).toBe("abandoned");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", CHARTER_ID));
      expect(state.status).toBe("abandoned");
    });
  });

});

describe("charter complete (completion because-gate)", () => {
  test("completes when all VALs have manual+because evidence from agent:root", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-001",
        outcome: "pass",
        summary: "callback works",
        because: "manual review of callback flow",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-002",
        outcome: "pass",
        summary: "tokens persisted",
        because: "verified token persistence by hand",
        now: "2026-05-15T02:30:00.000Z",
      });
      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", CHARTER_ID));
      const result = await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", CHARTER_ID));
      expect(state.status).toBe("completed");
    });
  });

  test("blocks only manual pass evidence without because", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-001",
        outcome: "pass",
        summary: "manual self-record with rationale",
        because: "manual review of callback flow",
        now: "2026-05-15T02:00:00.000Z",
      });
      const charterDir = join(projectDir, ".pi", "charters", CHARTER_ID);
      const criterionState = JSON.parse(await readFile(join(charterDir, "criterion-state.json"), "utf8"));
      criterionState.criteria["VAL-AUTH-002"] = {
        outcome: "pass",
        lastEvidencePath: "work/manual/evidence/no-because.json",
        lastTs: "2026-05-15T02:30:00.000Z",
        lastSummary: "manual self-record without rationale",
        source: "manual",
        recordedBy: "agent:root",
      };
      await writeFile(join(charterDir, "criterion-state.json"), `${JSON.stringify(criterionState, null, 2)}\n`, "utf8");
      await seedReportReadyForCompletion(charterDir);
      let caught: unknown;
      try {
        await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T03:00:00.000Z" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("VAL-AUTH-002");
      expect(message).not.toContain("VAL-AUTH-001");
      expect(message.toLowerCase()).toContain("because");
      expect(message.toLowerCase()).not.toContain("review subagent");
    });
  });

  test("completes when every VAL has a charter-reviewer-sourced record", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-001",
        outcome: "pass",
        summary: "reviewed by subagent",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-1",
        now: "2026-05-15T02:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-AUTH-002",
        outcome: "pass",
        summary: "reviewed by subagent",
        source: "subagent",
        recordedBy: "subagent:charter-reviewer:sess-2",
        now: "2026-05-15T02:30:00.000Z",
      });
      await seedReportReadyForCompletion(join(projectDir, ".pi", "charters", CHARTER_ID));
      const result = await completeCharter(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });
});

describe("removed amend action", () => {
  test("amend_charter throws amend.removed", async () => {
    await withTempProject(async (projectDir) => {
      await seedCompleteCharter(projectDir);
      await expect(
        amendCharter(projectDir, {
          charterId: CHARTER_ID,
          reason: "any reason",
          now: "2026-05-15T02:00:00.000Z",
        }),
      ).rejects.toThrow(/amend_charter was removed|amend\.removed/i);
    });
  });
});
