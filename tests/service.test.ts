import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { abandonCharter, completeCharter, createCharter, getBoundCharterStatus, getCharterStatus, pauseCharter, resumeCharter } from "../src/application/service";
import { subscribeHook } from "../src/application/hooks";
import { renderRalphPrompt } from "../src/application/ralph";
import { loadCharterState, writeCharterState } from "../src/infrastructure/store";
import { charterDir, pathExists, reportPath, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> { return mkdtemp(join(tmpdir(), "pi-charter-service-")); }

async function createWithText(project: string, text: string, sessionId = "s1") {
  const created = await createCharter(project, { objective: "Ship it", now: "2026-07-02T00:00:00.000Z", sessionId });
  await writeTextAtomic(join(charterDir(project, created.charterId), "charter.md"), text);
  return created.charterId;
}

describe("Objective service", () => {
  test("active and paused bindings block siblings until complete or abandon", async () => {
    for (const finish of [completeCharter, abandonCharter]) {
      const project = await tempProject();
      const created = await createCharter(project, { objective: "Governing objective", sessionId: "s1" });
      await expect(createCharter(project, { objective: "Sibling", sessionId: "s1" })).rejects.toMatchObject({ code: "create.non_terminal_exists" });
      await pauseCharter(project, { sessionId: "s1" });
      await expect(createCharter(project, { objective: "Sibling", sessionId: "s1" })).rejects.toThrow("complete or abandon");
      expect((await getBoundCharterStatus(project, "s1"))?.charterId).toBe(created.charterId);
      await finish(project, { sessionId: "s1", note: "Finished" });
      expect((await createCharter(project, { objective: "Next", sessionId: "s1" })).status).toBe("active");
    }
  });

  test("mutations cannot target a different charter from the session binding", async () => {
    const project = await tempProject();
    const bound = await createCharter(project, { objective: "Bound", sessionId: "s1" });
    const other = await createCharter(project, { objective: "Other", sessionId: "s2" });
    await pauseCharter(project, { sessionId: "s2" });
    for (const mutate of [pauseCharter, resumeCharter, completeCharter, abandonCharter]) {
      await expect(mutate(project, { charterId: other.charterId, sessionId: "s1", note: "Stop" })).rejects.toThrow(bound.charterId);
    }
    expect((await getCharterStatus(project, { charterId: other.charterId, sessionId: "s1" })).status).toBe("paused");
    expect((await getBoundCharterStatus(project, "s1"))?.charterId).toBe(bound.charterId);
  });

  test("an unbound session can only adopt a paused charter through explicit resume", async () => {
    const project = await tempProject();
    const other = await createCharter(project, { objective: "Previous session", sessionId: "old" });
    await pauseCharter(project, { sessionId: "old" });
    for (const mutate of [pauseCharter, completeCharter, abandonCharter]) {
      await expect(mutate(project, { charterId: other.charterId, sessionId: "new", note: "Stop" })).rejects.toThrow("no bound charter");
    }
    await expect(resumeCharter(project, { sessionId: "new" })).rejects.toThrow("explicit id");
    await resumeCharter(project, { charterId: other.charterId, sessionId: "new" });
    expect((await getBoundCharterStatus(project, "new"))?.charterId).toBe(other.charterId);
    expect(await getBoundCharterStatus(project, "old")).toBeUndefined();
  });
  test("terminal charters leave the widget binding but remain readable", async () => {
    for (const action of [completeCharter, abandonCharter]) {
      const project = await tempProject();
      const id = await createWithText(project, "# Objective\n\nDemo.\n\n## Phases\n");
      await action(project, { sessionId: "s1", note: "Demo finished." });
      expect(await getBoundCharterStatus(project, "s1")).toBeUndefined();
      expect((await getCharterStatus(project, { charterId: id })).charterId).toBe(id);
    }
  });

  test("no-id completion targets the displayed paused charter among historical charters", async () => {
    const project = await tempProject();
    const old = await createWithText(project, "# Objective\n\nOld demo.\n\n## Phases\n", "other");
    await completeCharter(project, { charterId: old, note: "Old demo finished." });
    const current = await createCharter(project, { objective: "Current demo", sessionId: "s1", now: "2026-07-03T00:00:00.000Z" });
    await pauseCharter(project, { sessionId: "s1" });
    expect((await getBoundCharterStatus(project, "s1"))?.charterId).toBe(current.charterId);
    expect((await getCharterStatus(project, { sessionId: "s1" })).charterId).toBe(current.charterId);
    await completeCharter(project, { sessionId: "s1", note: "Audited demo." });
    expect(await getBoundCharterStatus(project, "s1")).toBeUndefined();
  });
  test("an existing writable charter keeps its authored phase text unchanged, uninterpreted and resumable", async () => {
    const project = await tempProject();
    const objective = "Ship recovery.\n\n### Constraints\n\nDo not change login. Verify desktop and mobile widths.";
    const markdown = `# Objective\n\n${objective}\n\n## Phases\n\n1. Inspect behavior — done\n   [capture](work/a.png)\n2. Build — current\n`;
    const id = await createWithText(project, markdown);
    const file = join(charterDir(project, id), "charter.md");
    const status = await getCharterStatus(project, { charterId: id });
    expect(status.objective).toBe(objective);
    expect(status.charterMarkdown).toBe(markdown);
    expect(status.warnings).toEqual([]);
    for (const removed of ["phases", "phaseCounts"]) expect(status).not.toHaveProperty(removed);
    const prompt = renderRalphPrompt(status);
    expect(prompt).toContain(objective);
    expect(prompt).not.toMatch(/phase|Inspect behavior|Build/i);
    await pauseCharter(project, { sessionId: "s1" });
    expect((await resumeCharter(project, { charterId: id, sessionId: "s1" })).status).toBe("active");
    expect((await loadCharterState(project, id)).schemaVersion).toBe("phases");
    await completeCharter(project, { charterId: id, note: "Verified the full recovery flow and preserved login." });
    expect(await readFile(file, "utf8")).toBe(markdown);
  });

  test("a new charter has no phase scaffold", async () => {
    const project = await tempProject();
    const created = await createCharter(project, { objective: "Ship the bounded outcome.", sessionId: "s1" });
    const markdown = await readFile(join(charterDir(project, created.charterId), "charter.md"), "utf8");
    expect(markdown).toContain("Ship the bounded outcome.");
    expect(markdown).not.toMatch(/phase/i);
    expect(created.message).not.toMatch(/phase/i);
  });

  test("ordinary pause and explicit resume retain an outstanding warning until a guard pause", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Inspect behavior\n");
    const state = await loadCharterState(project, id);
    state.ralph = { activations: [1000], warnedAt: 1000 };
    await writeCharterState(charterDir(project, id), state);
    await pauseCharter(project, { charterId: id });
    await resumeCharter(project, { charterId: id, userInitiated: true });
    expect((await loadCharterState(project, id)).ralph).toEqual({ activations: [1000], warnedAt: 1000 });
  });
  test("completion hooks receive the note and can veto completion", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nDeliver safely.\n\n## Phases\n\n1. Inspect behavior\n");
    let observed: unknown;
    const unsubscribe = subscribeHook("charter:before_complete", (payload) => {
      observed = payload;
      return { decision: "block", reason: "Deployment approval required" };
    });
    try {
      await expect(completeCharter(project, { charterId: id, note: "Worker audit" })).rejects.toThrow("Deployment approval required");
      expect(observed).toMatchObject({ type: "charter:before_complete", charterId: id, completionNote: "Worker audit" });
      expect(observed).not.toHaveProperty("phaseCount");
      expect((await getCharterStatus(project, { charterId: id })).status).toBe("active");
      expect(await pathExists(reportPath(charterDir(project, id)))).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("status exposes Objective, References, Scope and raw markdown", async () => {
    const project = await tempProject();
    const markdown = "# Objective\n\nShip it safely.\n\n## References\n\n- docs/spec.md\n\n## Scope\n\nCore only.\n\n## Notes\n\nScratch.\n";
    const id = await createWithText(project, markdown);
    const status = await getCharterStatus(project, { charterId: id });
    expect(status).toMatchObject({
      charterId: id, status: "active", objective: "Ship it safely.", references: "- docs/spec.md", scope: "Core only.",
      legacy: false, charterMarkdown: markdown, reportExists: false, warnings: [],
    });
    expect(status.nextActions.map((action) => action.action)).toEqual(["status", "pause", "complete", "abandon"]);
  });

  test("completion requires a nonblank note and leaves the charter unchanged without one", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nDeliver.\n");
    for (const note of [undefined, "", "   \n"]) {
      await expect(completeCharter(project, { charterId: id, note })).rejects.toThrow("note is required for action=complete");
    }
    expect((await getCharterStatus(project, { charterId: id })).status).toBe("active");
  });

  test("completion records the note without generating REPORT.md", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nDeliver the bounded result.\n");
    const completed = await completeCharter(project, { charterId: id, note: "Delivered after checking the Objective." });
    expect(completed.status).toBe("completed");
    expect(completed.data?.completionNote).toBe("Delivered after checking the Objective.");
    expect(await pathExists(reportPath(charterDir(project, id)))).toBe(false);
    expect((await getCharterStatus(project, { charterId: id })).reportExists).toBe(false);
  });

  test("an existing report is preserved byte-for-byte on completion", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Inspect behavior\n");
    const curated = "# Curated\r\n\nKeep me.  \n\n[shot](work/a.png)";
    await writeTextAtomic(reportPath(charterDir(project, id)), curated);
    await completeCharter(project, { charterId: id, note: "Done." });
    expect(await readFile(reportPath(charterDir(project, id)), "utf8")).toBe(curated);
    expect((await getCharterStatus(project, { charterId: id })).reportExists).toBe(true);
  });

  test("legacy charters remain readable, cannot mutate, and do not block new work", async () => {
    const project = await tempProject();
    const dir = charterDir(project, "20260701-000000-legacy");
    const markdown = "## Objective\n\nOld objective.\n\n## Criteria\n";
    await writeTextAtomic(join(dir, "charter.md"), markdown);
    await writeTextAtomic(join(dir, "events.jsonl"), "");
    await writeTextAtomic(join(dir, "state.json"), `${JSON.stringify({ charterId: "20260701-000000-legacy", schemaVersion: "file-interface", objective: "Old objective.", status: "active", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", sessionId: "s1", snapshotHash: "old" })}\n`);
    const status = await getCharterStatus(project, { charterId: "20260701-000000-legacy" });
    expect(status).toMatchObject({ legacy: true, objective: "Old objective.", charterMarkdown: markdown, warnings: [] });
    expect(status).not.toHaveProperty("phases");
    await expect(pauseCharter(project, { charterId: status.charterId })).rejects.toThrow("Legacy charters are read-only");
    const fresh = await createCharter(project, { objective: "New work", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    expect(fresh.status).toBe("active");
    expect((await getBoundCharterStatus(project, "s1"))?.charterId).toBe(fresh.charterId);
  });

  test("guard pause requires explicit user resume and clears guard history", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Inspect behavior\n");
    await pauseCharter(project, { charterId: id, guard: true });
    await expect(resumeCharter(project, { charterId: id })).rejects.toThrow("/charter resume");
    const resumed = await resumeCharter(project, { charterId: id, userInitiated: true });
    expect(resumed.data?.ralph).toEqual({ activations: [] });
  });

  test("ordinary lifecycle remains active, paused, resumed, abandoned", async () => {
    const project = await tempProject();
    const created = await createCharter(project, { objective: "Lifecycle", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    expect((await pauseCharter(project, { charterId: created.charterId })).status).toBe("paused");
    expect((await resumeCharter(project, { charterId: created.charterId })).status).toBe("active");
    await expect(abandonCharter(project, { charterId: created.charterId })).rejects.toThrow("note is required");
    expect((await abandonCharter(project, { charterId: created.charterId, note: "Stopped" })).status).toBe("abandoned");
  });
});
