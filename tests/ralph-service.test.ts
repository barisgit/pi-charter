import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonCharter, createCharter, pauseCharter } from "../src/application/service";
import {
  buildRalphPromptForCharter,
  ralphCaseForStatus,
  renderTemplate,
  RALPH_SKIP_STATUSES,
} from "../src/application/ralph-service";
import type { CharterStatus } from "../src/domain/types";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-ralph-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function makeActiveCharter(projectDir: string): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Ralph active objective",
    now: "2026-05-20T00:00:00.000Z",
  });
  return charter.charterId;
}

async function makeCharterInStatus(projectDir: string, status: CharterStatus): Promise<string> {
  const charterId = await makeActiveCharter(projectDir);
  if (status === "paused") {
    await pauseCharter(projectDir, { charterId, reason: "test", now: "2026-05-20T00:02:00.000Z" });
    return charterId;
  }
  if (status === "completed" || status === "abandoned") {
    await abandonCharter(projectDir, {
      charterId,
      reason: status === "abandoned" ? "test abandon" : "test complete fixture",
      now: "2026-05-20T00:02:00.000Z",
    });
    if (status === "completed") {
      const dir = join(projectDir, ".pi/charters", charterId);
      const { loadCharterState, writeCharterState } = await import("../src/infrastructure/store");
      const state = await loadCharterState(dir);
      state.status = "completed";
      await writeCharterState(dir, state);
    }
  }
  return charterId;
}

const SKIP_STATUSES: CharterStatus[] = ["completed", "abandoned", "paused"];

describe("ralph-service: deterministic reprompt", () => {
  it("renderTemplate substitutes known vars and leaves unknown ones alone", () => {
    const out = renderTemplate("{{ objective }} :: {{ charterId }} :: {{ wat }}", {
      objective: "obj",
      charterId: "cid",
    });
    expect(out).toBe("obj :: cid :: {{ wat }}");
  });

  it("ralphCaseForStatus always returns active in v3", () => {
    expect(ralphCaseForStatus("active")).toBe("active");
    expect(ralphCaseForStatus("paused")).toBe("active");
  });

  it("RALPH_SKIP_STATUSES includes completed, abandoned, paused", () => {
    for (const s of SKIP_STATUSES) {
      expect(RALPH_SKIP_STATUSES.has(s)).toBe(true);
    }
    expect(RALPH_SKIP_STATUSES.has("active")).toBe(false);
  });

  it("returns undefined in every Ralph skip status", async () => {
    for (const skippedStatus of SKIP_STATUSES) {
      await withTempProject(async (projectDir) => {
        const charterId = await makeCharterInStatus(projectDir, skippedStatus);
        const built = await buildRalphPromptForCharter({ projectDir, charterId });
        expect(built).toBeUndefined();
      });
    }
  });

  it("builds an active prompt with objective, charterId, and status block", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built).toBeDefined();
      expect(built?.promptCase).toBe("active");
      expect(built?.content).toContain("Ralph active objective");
      expect(built?.content).toContain(charterId);
      expect(built?.content).toContain("status: active");
    });
  });

  it("repo-level override wins over the charter-local override", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const dir = join(projectDir, ".pi/charters", charterId);
      await mkdir(join(dir, "prompts/ralph"), { recursive: true });
      await writeFile(join(dir, "prompts/ralph/active.md"), "CHARTER-LOCAL", "utf8");
      await mkdir(join(projectDir, ".pi/charter-prompts/ralph"), { recursive: true });
      await writeFile(join(projectDir, ".pi/charter-prompts/ralph/active.md"), "REPO-LEVEL", "utf8");
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built?.content).toContain("REPO-LEVEL");
      expect(built?.content).not.toContain("CHARTER-LOCAL");
    });
  });
});
