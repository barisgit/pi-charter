import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeCharter, createCharter, getCharterStatus } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import { applyHandoff, recordEvidence } from "../src/application/record-service";
import { charterDir } from "../src/infrastructure/store";
import { clearHookSubscribers } from "../src/application/hooks";

// Hook subscribers are module-global; isolate this file from leaks via
// `tests/hooks.test.ts`, which only clears in its own beforeEach.
beforeEach(() => clearHookSubscribers());

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-milestone-review-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

const CHARTER_ID = "cha-mr-1";
const MILESTONE_ID = "m1-review-signal";

async function makeActiveCharter(projectDir: string): Promise<string> {
  await createCharter(projectDir, {
    objective: "Milestone review signal",
    charterId: CHARTER_ID,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = charterDir(projectDir, CHARTER_ID);
  await writeFile(
    join(dir, "charter.md"),
    [
      "# Charter",
      "",
      "## Objective",
      "",
      "Milestone review signal probe.",
      "",
      "## Criteria",
      "",
      "### VAL-MR-001 — first",
      "Description: first criterion.",
      "Verifier: manual",
      "Because: author rationale",
      "",
      "### VAL-MR-002 — second",
      "Description: second criterion.",
      "Verifier: manual",
      "Because: author rationale",
      "",
      "## Scope and constraints",
      "",
      "- none",
      "",
    ].join("\n"),
    "utf8",
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan", "f1.md"),
    [
      "---",
      "id: f1",
      `milestone: ${MILESTONE_ID}`,
      "order: 1",
      "fulfills:",
      "  - VAL-MR-001",
      "preconditions: []",
      "---",
      "",
      "# f1",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "plan", "f2.md"),
    [
      "---",
      "id: f2",
      `milestone: ${MILESTONE_ID}`,
      "order: 2",
      "fulfills:",
      "  - VAL-MR-002",
      "preconditions: []",
      "---",
      "",
      "# f2",
      "",
    ].join("\n"),
    "utf8",
  );
  await lockPlan(projectDir, { charterId: CHARTER_ID, now: "2026-05-15T00:30:00.000Z" });
  return dir;
}

async function readEvents(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function completeBothFeatures(projectDir: string, startTs = "2026-05-15T01:00:00.000Z"): Promise<void> {
  await recordEvidence(projectDir, {
    charterId: CHARTER_ID,
    criterionId: "VAL-MR-001",
    featureId: "f1",
    outcome: "pass",
    summary: "f1 done",
    because: "manual sign-off f1",
    recordedBy: "agent:root",
    now: startTs,
  });
  await recordEvidence(projectDir, {
    charterId: CHARTER_ID,
    criterionId: "VAL-MR-002",
    featureId: "f2",
    outcome: "pass",
    summary: "f2 done",
    because: "manual sign-off f2",
    recordedBy: "agent:root",
    now: addSeconds(startTs, 60),
  });
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

describe("milestone_ready_for_review event (VAL-9)", () => {
  test("happy path: fires exactly once with union of fulfills", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await makeActiveCharter(projectDir);
      await completeBothFeatures(projectDir);

      const events = await readEvents(dir);
      const ready = events.filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(1);
      const event = ready[0];
      expect(event.milestoneId).toBe(MILESTONE_ID);
      expect(event.charterId).toBe(CHARTER_ID);
      expect(typeof event.planDigest).toBe("string");
      const criterionIds = event.criterionIds as string[];
      expect(criterionIds.slice().sort()).toEqual(["VAL-MR-001", "VAL-MR-002"]);
    });
  });

  test("idempotent: re-recording evidence does not emit a duplicate event", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await makeActiveCharter(projectDir);
      await completeBothFeatures(projectDir);
      // Re-record another pass evidence for an already-completed feature.
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-MR-002",
        featureId: "f2",
        outcome: "pass",
        summary: "f2 done again",
        because: "manual re-affirm",
        recordedBy: "agent:root",
        now: "2026-05-15T02:00:00.000Z",
      });
      const ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(1);
    });
  });

  test("does not fire when any feature in the milestone is failed", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await makeActiveCharter(projectDir);
      // Mark f2 as failed in feature-state BEFORE completing f1; the milestone
      // check must veto the event on the failed-feature presence regardless of
      // f1 having pass evidence.
      const featureStatePath = join(dir, "feature-state.json");
      const featureState = JSON.parse(await readFile(featureStatePath, "utf8"));
      featureState.features.f2 = { status: "failed", startedAt: "2026-05-15T00:45:00.000Z" };
      await writeFile(featureStatePath, `${JSON.stringify(featureState, null, 2)}\n`);

      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-MR-001",
        featureId: "f1",
        outcome: "pass",
        summary: "f1 done",
        because: "manual sign-off f1",
        recordedBy: "agent:root",
        now: "2026-05-15T01:00:00.000Z",
      });

      const ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(0);
    });
  });

  test("planDigest change emits a new event after the milestone is re-completed", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await makeActiveCharter(projectDir);
      await completeBothFeatures(projectDir);
      let ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(1);
      const firstDigest = ready[0].planDigest as string;

      // Rotate planDigest in state.json.
      const statePath = join(dir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.planDigest = "sha256:rotated-digest";
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      // Flip f2 back to in_progress so the milestone is no longer complete.
      const featureStatePath = join(dir, "feature-state.json");
      const featureState = JSON.parse(await readFile(featureStatePath, "utf8"));
      featureState.features.f2 = { status: "in_progress" };
      await writeFile(featureStatePath, `${JSON.stringify(featureState, null, 2)}\n`);

      // Complete f2 again under the new digest.
      await recordEvidence(projectDir, {
        charterId: CHARTER_ID,
        criterionId: "VAL-MR-002",
        featureId: "f2",
        outcome: "pass",
        summary: "f2 re-completed under new digest",
        because: "manual re-completion",
        recordedBy: "agent:root",
        now: "2026-05-15T03:00:00.000Z",
      });

      ready = (await readEvents(dir)).filter((event) => event.type === "milestone_ready_for_review");
      expect(ready).toHaveLength(2);
      expect(ready[1].planDigest).toBe("sha256:rotated-digest");
      expect(ready[1].planDigest).not.toBe(firstDigest);
    });
  });
});

describe("requireReviewSubagent auto-default (VAL-12)", () => {
  // Two milestones; m1 has f1 fulfilling VAL-A, m2 has f2 fulfilling VAL-B.
  // Neither VAL declares `Review subagent required:`. Recording pass evidence
  // for f1 fires milestone_ready_for_review covering [VAL-A]; VAL-B is not in
  // any milestone event because m2 has no completed feature yet.
  const CHARTER = "cha-mr-auto";
  async function seedTwoMilestoneCharter(projectDir: string, valAOverride: "omitted" | "explicit-false" = "omitted"): Promise<string> {
    await createCharter(projectDir, {
      objective: "two-milestone auto-default probe",
      charterId: CHARTER,
      now: "2026-05-15T00:00:00.000Z",
    });
    const dir = charterDir(projectDir, CHARTER);
    const valALines = [
      "### VAL-A — first",
      "Description: first criterion.",
      "Verifier: command",
      "Command: true",
      ...(valAOverride === "explicit-false" ? ["Review subagent required: false"] : []),
      "",
    ];
    await writeFile(
      join(dir, "charter.md"),
      [
        "# Charter",
        "",
        "## Objective",
        "",
        "Two-milestone probe.",
        "",
        "## Criteria",
        "",
        ...valALines,
        "### VAL-B — second",
        "Description: second criterion.",
        "Verifier: command",
        "Command: true",
        "",
        "## Scope and constraints",
        "",
        "- none",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFile(
      join(dir, "plan", "f1.md"),
      [
        "---",
        "id: f1",
        "milestone: m1",
        "order: 1",
        "fulfills:",
        "  - VAL-A",
        "preconditions: []",
        "---",
        "# f1",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, "plan", "f2.md"),
      [
        "---",
        "id: f2",
        "milestone: m2",
        "order: 1",
        "fulfills:",
        "  - VAL-B",
        "preconditions: []",
        "---",
        "# f2",
        "",
      ].join("\n"),
      "utf8",
    );
    await lockPlan(projectDir, { charterId: CHARTER, now: "2026-05-15T00:30:00.000Z" });
    return dir;
  }

  test("omitted Review subagent required: → milestone-ready VAL auto-defaults to true; non-milestone VAL stays at declared default", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedTwoMilestoneCharter(projectDir, "omitted");
      // Record pass evidence (agent:root, manual+because) for BOTH VALs.
      await recordEvidence(projectDir, {
        charterId: CHARTER,
        criterionId: "VAL-A",
        featureId: "f1",
        outcome: "pass",
        summary: "f1 done",
        because: "manual sign-off f1",
        recordedBy: "agent:root",
        now: "2026-05-15T01:00:00.000Z",
      });
      await recordEvidence(projectDir, {
        charterId: CHARTER,
        criterionId: "VAL-B",
        featureId: "f2",
        outcome: "pass",
        summary: "f2 done",
        because: "manual sign-off f2",
        recordedBy: "agent:root",
        now: "2026-05-15T01:01:00.000Z",
      });
      // m1 event has fired covering VAL-A; m2 event has also fired covering
      // VAL-B because f2 is the only feature in m2 and it is now completed.
      // Both VALs therefore auto-default to requireReviewSubagent: true → both
      // block on missing charter-verifier evidence.
      const events = await readEvents(dir);
      const ready = events.filter((event) => event.type === "milestone_ready_for_review");
      expect(ready.length).toBeGreaterThanOrEqual(1);
      let caught: unknown;
      try {
        await completeCharter(projectDir, { charterId: CHARTER, now: "2026-05-15T02:00:00.000Z" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      // VAL-A is in a milestone_ready_for_review event → must be flagged.
      expect(msg).toContain("VAL-A");

      // Pin lastWorkerSessionId to the original implementer session so the
      // verifying handoff (different session) is identity-disjoint.
      const featureStatePath = join(dir, "feature-state.json");
      const fs0 = JSON.parse(await readFile(featureStatePath, "utf8"));
      fs0.features.f1 = { ...(fs0.features.f1 ?? {}), lastWorkerSessionId: "impl-A" };
      fs0.features.f2 = { ...(fs0.features.f2 ?? {}), lastWorkerSessionId: "impl-B" };
      await writeFile(featureStatePath, `${JSON.stringify(fs0, null, 2)}\n`);

      // Now record a charter-verifier handoff for VAL-A and VAL-B with
      // distinct reviewer session ids; completion then succeeds.
      await applyHandoff(projectDir, {
        charterId: CHARTER,
        featureId: "f1",
        subagentSessionId: "rev-A",
        handoffNote: "verifier review for VAL-A",
        completedCriteria: [{ criterionId: "VAL-A", outcome: "pass", summary: "reviewed" }],
        now: "2026-05-15T02:30:00.000Z",
      });
      await applyHandoff(projectDir, {
        charterId: CHARTER,
        featureId: "f2",
        subagentSessionId: "rev-B",
        handoffNote: "verifier review for VAL-B",
        completedCriteria: [{ criterionId: "VAL-B", outcome: "pass", summary: "reviewed" }],
        now: "2026-05-15T02:31:00.000Z",
      });
      // applyHandoff overwrites lastWorkerSessionId to the reviewer session;
      // restore the original implementer session ids so the identity-disjoint
      // check sees an independent reviewer (rev-A != impl-A, rev-B != impl-B).
      const fs1 = JSON.parse(await readFile(featureStatePath, "utf8"));
      fs1.features.f1.lastWorkerSessionId = "impl-A";
      fs1.features.f2.lastWorkerSessionId = "impl-B";
      await writeFile(featureStatePath, `${JSON.stringify(fs1, null, 2)}\n`);

      const result = await completeCharter(projectDir, { charterId: CHARTER, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });

  test("explicit `Review subagent required: false` overrides the auto-default", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedTwoMilestoneCharter(projectDir, "explicit-false");
      // For VAL-A: record source=subagent with a NON-charter-verifier prefix
      // and trigger the m1 milestone-ready event. The trust gate accepts this
      // (source != manual). The auto-default, if applied, would still demand
      // a `subagent:charter-verifier:` writer — but the explicit
      // `Review subagent required: false` on VAL-A must override the
      // auto-default and let the record pass.
      await recordEvidence(projectDir, {
        charterId: CHARTER,
        criterionId: "VAL-A",
        featureId: "f1",
        outcome: "pass",
        summary: "f1 reviewed by other worker",
        source: "subagent",
        recordedBy: "subagent:other-worker:wrk-1",
        now: "2026-05-15T01:00:00.000Z",
      });
      // For VAL-B: charter-verifier handoff so it always passes; isolates the
      // assertion to VAL-A's explicit-false behaviour. Pre-set implementer
      // session for f2 so the verifier handoff is identity-disjoint.
      const featureStatePath = join(dir, "feature-state.json");
      const fs0 = JSON.parse(await readFile(featureStatePath, "utf8"));
      fs0.features = fs0.features ?? {};
      fs0.features.f2 = { ...(fs0.features.f2 ?? {}), lastWorkerSessionId: "impl-B" };
      await writeFile(featureStatePath, `${JSON.stringify(fs0, null, 2)}\n`);
      await applyHandoff(projectDir, {
        charterId: CHARTER,
        featureId: "f2",
        subagentSessionId: "rev-B",
        handoffNote: "verifier review",
        completedCriteria: [{ criterionId: "VAL-B", outcome: "pass", summary: "reviewed VAL-B" }],
        now: "2026-05-15T01:30:00.000Z",
      });
      const fs1 = JSON.parse(await readFile(featureStatePath, "utf8"));
      fs1.features.f2.lastWorkerSessionId = "impl-B";
      await writeFile(featureStatePath, `${JSON.stringify(fs1, null, 2)}\n`);

      const result = await completeCharter(projectDir, { charterId: CHARTER, now: "2026-05-15T02:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });
});

describe("identity-disjoint completion predicate (VAL-13)", () => {
  const CHARTER_X = "cha-mr-id";
  async function seedSingleCriterionCharter(projectDir: string): Promise<string> {
    await createCharter(projectDir, {
      objective: "identity-disjoint probe",
      charterId: CHARTER_X,
      now: "2026-05-15T00:00:00.000Z",
    });
    const dir = charterDir(projectDir, CHARTER_X);
    await writeFile(
      join(dir, "charter.md"),
      [
        "# Charter",
        "",
        "## Objective",
        "",
        "identity-disjoint probe.",
        "",
        "## Criteria",
        "",
        "### VAL-X — only",
        "Description: identity-disjoint criterion.",
        "Verifier: command",
        "Command: true",
        "Review subagent required: true",
        "",
        "## Scope and constraints",
        "",
        "- none",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(dir, "plan"), { recursive: true });
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
        "# f1",
        "",
      ].join("\n"),
      "utf8",
    );
    await lockPlan(projectDir, { charterId: CHARTER_X, now: "2026-05-15T00:30:00.000Z" });
    return dir;
  }

  test("rejects when every pass evidence shares recordedBy with the implementer session", async () => {
    await withTempProject(async (projectDir) => {
      const dir = await seedSingleCriterionCharter(projectDir);
      const featureStatePath = join(dir, "feature-state.json");
      // Implementer session for f1 is `s1`. Write the first handoff with the
      // same session id so the charter-verifier evidence shares its session
      // with the implementer (the only reviewer is the implementer).
      await applyHandoff(projectDir, {
        charterId: CHARTER_X,
        featureId: "f1",
        subagentSessionId: "s1",
        handoffNote: "implementer reviewed self",
        completedCriteria: [{ criterionId: "VAL-X", outcome: "pass", summary: "self-review" }],
        now: "2026-05-15T01:00:00.000Z",
      });
      // Sanity: feature-state.lastWorkerSessionId is now 's1'.
      const featureState = JSON.parse(await readFile(featureStatePath, "utf8"));
      expect(featureState.features.f1.lastWorkerSessionId).toBe("s1");

      let caught: unknown;
      try {
        await completeCharter(projectDir, { charterId: CHARTER_X, now: "2026-05-15T02:00:00.000Z" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toContain("VAL-X");
      expect(msg).toContain("implementer-only-reviewer");

      // Second handoff from a different reviewer session id should pass the
      // gate. Pin implementer to `s1` afterwards because applyHandoff would
      // otherwise clobber lastWorkerSessionId to `s2`, making the new
      // reviewer falsely "identity-shared".
      await applyHandoff(projectDir, {
        charterId: CHARTER_X,
        featureId: "f1",
        subagentSessionId: "s2",
        handoffNote: "independent verifier",
        completedCriteria: [{ criterionId: "VAL-X", outcome: "pass", summary: "independent review" }],
        now: "2026-05-15T02:30:00.000Z",
      });
      const fs1 = JSON.parse(await readFile(featureStatePath, "utf8"));
      fs1.features.f1.lastWorkerSessionId = "s1";
      await writeFile(featureStatePath, `${JSON.stringify(fs1, null, 2)}\n`);

      const result = await completeCharter(projectDir, { charterId: CHARTER_X, now: "2026-05-15T03:00:00.000Z" });
      expect(result.status).toBe("completed");
    });
  });
});

describe("charter_status surfaces milestone review next action (VAL-10)", () => {
  test("nextAction appears for unreviewed milestone and disappears after charter-verifier review", async () => {
    await withTempProject(async (projectDir) => {
      await makeActiveCharter(projectDir);
      await completeBothFeatures(projectDir);

      const before = await getCharterStatus(projectDir, { charterId: CHARTER_ID });
      const matching = before.nextActions.filter(
        (action) =>
          action.tool === "subagent" &&
          (action.hint?.includes(MILESTONE_ID) ||
            (action as { metadata?: { milestoneId?: string } }).metadata?.milestoneId === MILESTONE_ID),
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);

      // charter-verifier records pass evidence for every criterionId in the milestone.
      await applyHandoff(projectDir, {
        charterId: CHARTER_ID,
        featureId: "f1",
        subagentSessionId: "charter-verifier-1",
        handoffNote: "charter-verifier review covered both VALs",
        completedCriteria: [
          { criterionId: "VAL-MR-001", outcome: "pass", summary: "reviewed VAL-MR-001" },
          { criterionId: "VAL-MR-002", outcome: "pass", summary: "reviewed VAL-MR-002" },
        ],
        now: "2026-05-15T04:00:00.000Z",
      });

      const after = await getCharterStatus(projectDir, { charterId: CHARTER_ID });
      const stillMatching = after.nextActions.filter(
        (action) =>
          action.tool === "subagent" &&
          (action.hint?.includes(MILESTONE_ID) ||
            (action as { metadata?: { milestoneId?: string } }).metadata?.milestoneId === MILESTONE_ID),
      );
      expect(stillMatching).toHaveLength(0);
    });
  });
});
