import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { abandonCharter, completeCharter, countStatusFailures, createCharter, getCharterStatus, pauseCharter, resumeCharter } from "../src/application/service";
import { recordSourceModification } from "../src/application/staleness";
import { charterDir, pathExists, reportPath, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-service-"));
}

function md(status: string): string {
  return `## Objective\n\nShip it.\n\n## Criteria\n\n### C1. First works\nStatus: ${status}\n\n### C2. Second works\nDepends: C1\nStatus: pass — checked second\n`;
}

async function createWithText(project: string, text: string, sessionId = "s1") {
  const created = await createCharter(project, { objective: "Ship it", now: "2026-07-02T00:00:00.000Z", sessionId });
  await writeTextAtomic(join(charterDir(project, created.charterId), "charter.md"), text);
  return created.charterId;
}

describe("service lifecycle", () => {
  test("counts new Status and legacy Evidence journal failures", () => {
    const base = { type: "criterion_changed", ts: "2026-07-02T00:00:00.000Z", charterId: "c", criterion: "C1", new: "fail" };
    const counts = countStatusFailures([
      { ...base, field: "status.value" },
      { ...base, field: "evidence.status" },
      { ...base, field: "status.note" },
    ]);
    expect(counts.get("C1")).toBe(2);
  });

  test("create status pause resume complete happy path", async () => {
    const project = await tempProject();
    const id = await createWithText(project, md("pass — checked first"));
    let status = await getCharterStatus(project, { charterId: id });
    expect(status.statusCounts.pass).toBe(2);
    expect(status.nextActions.map((action) => action.action)).toContain("complete");

    expect((await pauseCharter(project, { charterId: id })).status).toBe("paused");
    expect((await resumeCharter(project, { charterId: id })).status).toBe("active");

    await expect(completeCharter(project, { charterId: id })).rejects.toThrow("REPORT.md scaffolded");
    expect(await pathExists(reportPath(charterDir(project, id)))).toBe(true);
    const completed = await completeCharter(project, { charterId: id, note: "done" });
    expect(completed.status).toBe("completed");
  });

  test("projects all five statuses and scaffolds the full authored contract", async () => {
    const project = await tempProject();
    const text = `## Objective\n\nDeliver a durable outcome.\n\n## References\n\n- docs/spec.md\n\n## Scope\n\nIn: runtime. Out: scheduler.\n\n## Criteria\n\n### C1. Pending\nPending semantics.\nStatus: pending\n\n### C2. Active\nActive semantics.\nStatus: in-progress — implementing\n\n### C3. Blocked\nBlocked semantics.\nStatus: blocked — waiting on access\n\n### C4. Passing\nPassing semantics.\nStatus: pass — observed output\n\n### C5. Failing\nFailing semantics.\nStatus: fail — observed error\n`;
    const id = await createWithText(project, text, "five-status-session");
    const status = await getCharterStatus(project, { charterId: id });
    expect(status.statusCounts).toEqual({ pending: 1, "in-progress": 1, blocked: 1, pass: 1, fail: 1 });
    expect(status).toMatchObject({ references: "- docs/spec.md", scope: "In: runtime. Out: scheduler." });

    await expect(completeCharter(project, { charterId: id })).rejects.toThrow("REPORT.md scaffolded");
    const report = await readFile(reportPath(charterDir(project, id)), "utf8");
    expect(report).toContain("## References\n\n- docs/spec.md");
    expect(report).toContain("## Scope\n\nIn: runtime. Out: scheduler.");
    expect(report).toContain("Passing semantics.");
    expect(report).toContain("Status: pass — observed output");
  });

  test("complete rejects fail, none, empty pass note, and stale pass", async () => {
    const project = await tempProject();
    const fail = await createWithText(project, md("fail — broken"), "fail-session");
    await expect(completeCharter(project, { charterId: fail })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: fail })).rejects.toThrow("status is fail");

    const pending = await createWithText(project, md("pending"), "pending-session");
    await expect(completeCharter(project, { charterId: pending })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: pending })).rejects.toThrow("status is pending");

    const blocked = await createWithText(project, md("blocked — waiting for access"), "blocked-session");
    const blockedStatus = await getCharterStatus(project, { charterId: blocked });
    expect(blockedStatus.criteria[0]).toMatchObject({ status: "blocked", note: "waiting for access" });
    await expect(completeCharter(project, { charterId: blocked })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: blocked })).rejects.toThrow("status is blocked");

    const active = await createWithText(project, md("in-progress — implementing"), "active-session");
    await expect(completeCharter(project, { charterId: active })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: active })).rejects.toThrow("status is in-progress");

    const empty = await createWithText(project, md("pass"), "empty-session");
    await expect(completeCharter(project, { charterId: empty })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: empty })).rejects.toThrow("empty note");

    const stale = await createWithText(project, md("pass — checked first"), "stale-session");
    await getCharterStatus(project, { charterId: stale });
    await recordSourceModification(project, { files: ["src/changed.ts"], sessionId: "stale-session" });
    await expect(completeCharter(project, { charterId: stale })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: stale })).rejects.toThrow("stale");
  });

  test("open-ended charters cannot complete", async () => {
    const project = await tempProject();
    const created = await createCharter(project, { objective: "Watch CI", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    const status = await getCharterStatus(project, { charterId: created.charterId });
    expect(status.openEnded).toBe(true);
    expect(status.nextActions.map((action) => action.action)).not.toContain("complete");
    await expect(completeCharter(project, { charterId: created.charterId })).rejects.toThrow("Open-ended");
  });

  test("one active charter per session", async () => {
    const project = await tempProject();
    await createCharter(project, { objective: "One", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    await expect(createCharter(project, { objective: "Two", now: "2026-07-02T00:00:01.000Z", sessionId: "s1" })).rejects.toThrow("already has active");
  });

  test("abandon requires note", async () => {
    const project = await tempProject();
    const created = await createCharter(project, { objective: "Drop it", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    await expect(abandonCharter(project, { charterId: created.charterId })).rejects.toThrow("note is required");
    expect((await abandonCharter(project, { charterId: created.charterId, note: "not needed" })).status).toBe("abandoned");
  });
});
