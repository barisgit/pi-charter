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

describe("Objective/Phases service", () => {
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
  test("subheaded Objective constraints reach status, Ralph and the completion report intact", async () => {
    const project = await tempProject();
    const objective = "Ship recovery.\n\n### Constraints\n\nDo not change login. Verify desktop and mobile widths.";
    const id = await createWithText(project, `# Objective\n\n${objective}\n\n## Phases\n\n1. Explore phases\n`);
    const status = await getCharterStatus(project, { charterId: id });
    expect(status.objective).toBe(objective);
    expect(renderRalphPrompt(status)).toContain(objective);
    await completeCharter(project, { charterId: id, note: "Verified the full recovery flow and preserved login." });
    expect(await readFile(reportPath(charterDir(project, id)), "utf8")).toContain(objective);
  });

  test("ordinary pause and explicit resume retain an outstanding warning until a guard pause", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Explore phases\n");
    const state = await loadCharterState(project, id);
    state.ralph = { activations: [1000], warnedAt: 1000 };
    await writeCharterState(charterDir(project, id), state);
    await pauseCharter(project, { charterId: id });
    await resumeCharter(project, { charterId: id, userInitiated: true });
    expect((await loadCharterState(project, id)).ralph).toEqual({ activations: [1000], warnedAt: 1000 });
  });
  test("completion hooks receive phase count and can still veto completion", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nDeliver safely.\n\n## Phases\n\n1. Explore phases\n");
    let observed: unknown;
    const unsubscribe = subscribeHook("charter:before_complete", (payload) => {
      observed = payload;
      return { decision: "block", reason: "Deployment approval required" };
    });
    try {
      await expect(completeCharter(project, { charterId: id, note: "Worker audit" })).rejects.toThrow("Deployment approval required");
      expect(observed).toMatchObject({ phaseCount: 1, completionNote: "Worker audit" });
      expect(observed).not.toHaveProperty("criteriaCount");
      expect((await getCharterStatus(project, { charterId: id })).status).toBe("active");
      expect(await pathExists(reportPath(charterDir(project, id)))).toBe(false);
    } finally {
      unsubscribe();
    }
  });
  test("status exposes the agreed phase projection and raw markdown", async () => {
    const project = await tempProject();
    const markdown = "# Objective\n\nShip it safely.\n\n## References\n\n- docs/spec.md\n\n## Scope\n\nCore only.\n\n## Phases\n\n1. Explore — done\n   Findings: [capture](work/explore.png)\n2. Build\n3. Verify\n";
    const id = await createWithText(project, markdown);
    const status = await getCharterStatus(project, { charterId: id });
    expect(status).toMatchObject({
      charterId: id, status: "active", objective: "Ship it safely.", references: "- docs/spec.md", scope: "Core only.",
      legacy: false, charterMarkdown: markdown, phaseCounts: { upcoming: 1, current: 1, done: 1 }, reportExists: false,
    });
    expect(status.phases.map((phase) => phase.title)).toEqual(["Explore", "Build", "Verify"]);
    for (const removed of ["criteria", "statusCounts", "readyNext", "openEnded", "blockers"]) expect(status).not.toHaveProperty(removed);
    expect(status.nextActions.map((action) => action.action)).toContain("complete");
  });

  test("completion succeeds on the first attempt with zero phases and generates an artifact-rich report", async () => {
    const project = await tempProject();
    const markdown = "# Objective\n\nDeliver the bounded result.\n\n## References\n\n- [Spec](docs/spec.md)\n\n## Phases\n\n";
    const id = await createWithText(project, markdown);
    const completed = await completeCharter(project, { charterId: id, note: "Delivered after auditing the objective and references." });
    expect(completed.status).toBe("completed");
    const report = await readFile(reportPath(charterDir(project, id)), "utf8");
    expect(report).toContain("## Objective\n\nDeliver the bounded result.");
    expect(report).toContain("## Completion\n\nDelivered after auditing");
    expect(report).toContain("## Visual Evidence");
  });

  test("report includes linked image/video evidence from phase bodies without walking work", async () => {
    const project = await tempProject();
    const markdown = "# Objective\n\nShip UI.\n\n## Phases\n\n1. Verify — done\n   Drove the app: [screenshot](work/result.png) and [recording](work/flow.webm).\n   Ignore [external](https://example.com/image.png) and [source](src/file.ts).\n";
    const id = await createWithText(project, markdown);
    await completeCharter(project, { charterId: id, note: "Verified." });
    const report = await readFile(reportPath(charterDir(project, id)), "utf8");
    expect(report).toContain("[screenshot](work/result.png)");
    expect(report).toContain("[recording](work/flow.webm)");
    const evidence = report.slice(report.indexOf("## Visual Evidence"));
    expect(evidence).not.toContain("https://example.com");
    expect(evidence).not.toContain("src/file.ts");
  });

  test("terminal recordings are curated as visual evidence without inventing an audit note", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nVerify the TUI.\n\n## Phases\n\n1. Exercise dashboard — done\n   [Terminal recording](work/session.cast) and [External capture](/tmp/session.cast)\n");
    await completeCharter(project, { charterId: id });
    const report = await readFile(reportPath(charterDir(project, id)), "utf8");
    const evidence = report.slice(report.indexOf("## Visual Evidence"));
    expect(evidence).toContain("[Terminal recording](work/session.cast)");
    expect(evidence).toContain("[External capture](/tmp/session.cast)");
    expect(evidence).not.toContain("No user-visible artifacts");
    expect(report).toContain("No completion note was supplied.");
  });

  test("existing curated report is preserved on completion", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Explore phases\n");
    await writeTextAtomic(reportPath(charterDir(project, id)), "# Curated\n\nKeep me.\n");
    await completeCharter(project, { charterId: id, note: "Done." });
    expect(await readFile(reportPath(charterDir(project, id)), "utf8")).toBe("# Curated\n\nKeep me.\n");
  });

  test("legacy charters remain readable, cannot mutate, and do not block new work", async () => {
    const project = await tempProject();
    const dir = charterDir(project, "20260701-000000-legacy");
    const markdown = "## Objective\n\nOld objective.\n\n## Criteria\n";
    await writeTextAtomic(join(dir, "charter.md"), markdown);
    await writeTextAtomic(join(dir, "events.jsonl"), "");
    await writeTextAtomic(join(dir, "state.json"), `${JSON.stringify({ charterId: "20260701-000000-legacy", schemaVersion: "file-interface", objective: "Old objective.", status: "active", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", sessionId: "s1", snapshotHash: "old" })}\n`);
    const status = await getCharterStatus(project, { charterId: "20260701-000000-legacy" });
    expect(status).toMatchObject({ legacy: true, objective: "Old objective.", charterMarkdown: markdown, phases: [], warnings: [] });
    await expect(pauseCharter(project, { charterId: status.charterId })).rejects.toThrow("Legacy charters are read-only");
    const fresh = await createCharter(project, { objective: "New work", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    expect(fresh.status).toBe("active");
    expect((await getBoundCharterStatus(project, "s1"))?.charterId).toBe(fresh.charterId);
  });

  test("guard pause requires explicit user resume and clears guard history", async () => {
    const project = await tempProject();
    const id = await createWithText(project, "# Objective\n\nShip.\n\n## Phases\n\n1. Explore phases\n");
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
