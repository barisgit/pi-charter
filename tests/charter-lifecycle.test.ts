import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonCharter,
  createCharter,
  getCharterStatus,
  pauseCharter,
  resumeCharter,
} from "../src/application/service";
import { formatCharterStatusText } from "../src/application/registration";
import { RALPH_SKIP_STATUSES, ralphCaseForStatus } from "../src/application/ralph-service";
import { loadCharterState } from "../src/infrastructure/store";
import type { CharterStatus } from "../src/domain/types";
import { TERMINAL_STATUSES } from "../src/domain/types";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-lifecycle-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const V3_STATUSES: CharterStatus[] = ["active", "paused", "completed", "abandoned"];

describe("charter lifecycle", () => {
  test("create starts in active with active-phase nextActions", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Collapse lifecycle to four states",
        charterId: "lifecycle-create",
        now: "2026-05-22T00:00:00.000Z",
      });
      expect(created.status).toBe("active");
      expect(created.message).toMatch(/active state/i);
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "lifecycle-create"));
      expect(state.status).toBe("active");
      const status = await getCharterStatus(projectDir, { charterId: created.charterId });
      expect(status.phase).toBe("active");
      expect(status.status).toBe("active");
      expect(status.nextActions.some((a) => a.tool === "charter" && a.action === "abandon")).toBe(true);
      const blob = JSON.stringify({ status, guidelines: status.guidelines, nextActions: status.nextActions });
      expect(blob).not.toMatch(/\bplanning\b|budget_limited|awaiting-clarification|lock_plan|force_complete|amend_charter/);
    });
  });

  test("pause and resume only transition between active and paused", async () => {
    await withTempProject(async (projectDir) => {
      const created = await createCharter(projectDir, {
        objective: "Pause resume probe",
        charterId: "lifecycle-pause",
        now: "2026-05-22T00:00:00.000Z",
      });
      const paused = await pauseCharter(projectDir, { charterId: created.charterId, now: "2026-05-22T00:01:00.000Z" });
      expect(paused.status).toBe("paused");
      const resumed = await resumeCharter(projectDir, { charterId: created.charterId, now: "2026-05-22T00:02:00.000Z" });
      expect(resumed.status).toBe("active");
    });
  });

  test("abandon requires a reason and lands in abandoned", async () => {
    await withTempProject(async (projectDir) => {
      await createCharter(projectDir, {
        objective: "Abandon probe",
        charterId: "lifecycle-abandon",
        now: "2026-05-22T00:00:00.000Z",
      });
      await expect(
        abandonCharter(projectDir, { charterId: "lifecycle-abandon", reason: "  " }),
      ).rejects.toThrow(/reason/i);
      const result = await abandonCharter(projectDir, {
        charterId: "lifecycle-abandon",
        reason: "Superseded by another effort.",
        now: "2026-05-22T00:01:00.000Z",
      });
      expect(result.status).toBe("abandoned");
      const state = await loadCharterState(join(projectDir, ".pi", "charters", "lifecycle-abandon"));
      expect(state.completionReason).toBe("Superseded by another effort.");
    });
  });

  test("terminal statuses and Ralph skip set match the lifecycle contract", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["abandoned", "completed"]);
    expect(V3_STATUSES.sort()).toEqual(["abandoned", "active", "completed", "paused"]);
    for (const status of V3_STATUSES) {
      expect(RALPH_SKIP_STATUSES.has(status)).toBe(status === "completed" || status === "abandoned" || status === "paused");
    }
    expect(ralphCaseForStatus("active")).toBe("active");
    expect(ralphCaseForStatus("paused")).toBe("active");
  });
});
