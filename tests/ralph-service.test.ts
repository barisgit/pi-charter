import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCharter, getCharterStatus, pauseCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import {
  buildRalphPromptForCharter,
  ralphCaseForStatus,
  renderTemplate,
  RALPH_SKIP_STATUSES,
} from "../src/application/ralph-service";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-ralph-"));
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

async function makePlanningCharter(projectDir: string): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Ralph planning objective",
    now: "2026-05-20T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", charter.charterId);
  // Planning state: no criteria authored yet, so drift surfaces uncovered/empty plan.
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nRalph planning objective\n## Criteria\n### VAL-PLN-001 — bootstrap\nVerifier: manual\n## Scope and constraints\n- none\n`,
  );
  return charter.charterId;
}

async function makeActiveCharter(projectDir: string): Promise<string> {
  const charter = await createCharter(projectDir, {
    objective: "Ralph active objective",
    now: "2026-05-20T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", charter.charterId);
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nRalph active objective\n## Criteria\n### VAL-ACT-001 — go\nVerifier: manual\n## Scope and constraints\n- none\n`,
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [VAL-ACT-001]\npreconditions: []\n---\nbody\n\n${VALIDATION_MD}`,
  );
  await lockPlan(projectDir, { charterId: charter.charterId, legacy: true });
  return charter.charterId;
}

describe("ralph-service: deterministic reprompt", () => {
  it("renderTemplate substitutes known vars and leaves unknown ones alone", () => {
    const out = renderTemplate("{{ objective }} :: {{ charterId }} :: {{ wat }}", {
      objective: "obj",
      charterId: "cid",
    });
    expect(out).toBe("obj :: cid :: {{ wat }}");
  });

  it("ralphCaseForStatus maps planning → planning and active/review → active", () => {
    expect(ralphCaseForStatus("planning")).toBe("planning");
    expect(ralphCaseForStatus("active")).toBe("active");
    expect(ralphCaseForStatus("review")).toBe("active");
  });

  it("RALPH_SKIP_STATUSES includes all terminal/dormant states", () => {
    for (const s of ["completed", "abandoned", "paused", "budget_limited"] as const) {
      expect(RALPH_SKIP_STATUSES.has(s)).toBe(true);
    }
  });

  it("builds a planning prompt that embeds objective, charterId, and status block", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makePlanningCharter(projectDir);
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built).toBeDefined();
      expect(built?.promptCase).toBe("planning");
      expect(built?.content).toContain("Ralph planning objective");
      expect(built?.content).toContain(charterId);
      expect(built?.content).toContain("status: planning");
      // First-line headline matches the bundled template.
      expect(built?.content.startsWith("Continue planning the active charter.")).toBe(true);
    });
  });

  it("builds an active prompt with readyNext / nextActions surface", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built).toBeDefined();
      expect(built?.promptCase).toBe("active");
      expect(built?.content).toContain("Ralph active objective");
      expect(built?.content).toContain("status: active");
      expect(built?.content).toContain("nextActions:");
      expect(built?.content.startsWith("Continue working toward the active charter.")).toBe(true);
    });
  });

  it("returns undefined for paused charters (charter must never auto-continue when paused)", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      await pauseCharter(projectDir, { charterId, reason: "manual pause" });
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built).toBeUndefined();
    });
  });

  it("charter-local prompt override wins over the bundled template", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const overrideDir = join(projectDir, ".pi/charters", charterId, "prompts/ralph");
      await mkdir(overrideDir, { recursive: true });
      await writeFile(
        join(overrideDir, "active.md"),
        "OVERRIDDEN ACTIVE PROMPT for {{ charterId }}\n",
      );
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built?.content).toContain("OVERRIDDEN ACTIVE PROMPT");
      expect(built?.content).toContain(charterId);
    });
  });

  it("repo-level override wins over the charter-local override", async () => {
    await withTempProject(async (projectDir) => {
      const charterId = await makeActiveCharter(projectDir);
      const charterOverride = join(projectDir, ".pi/charters", charterId, "prompts/ralph");
      await mkdir(charterOverride, { recursive: true });
      await writeFile(join(charterOverride, "active.md"), "CHARTER LEVEL\n");
      const repoOverride = join(projectDir, ".pi/charter-prompts/ralph");
      await mkdir(repoOverride, { recursive: true });
      await writeFile(join(repoOverride, "active.md"), "REPO LEVEL WINS\n");
      const built = await buildRalphPromptForCharter({ projectDir, charterId });
      expect(built?.content.trim()).toBe("REPO LEVEL WINS");
    });
  });
});
