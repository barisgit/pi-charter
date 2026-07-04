import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { abandonCharter, completeCharter, createCharter, getCharterStatus, pauseCharter, resumeCharter } from "../src/application/service";
import { recordSourceModification } from "../src/application/staleness";
import { charterDir, pathExists, reportPath, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-service-"));
}

function md(evidence: string): string {
  return `## Objective\n\nShip it.\n\n## Criteria\n\n### C1. First works\nEvidence: ${evidence}\n\n### C2. Second works\nDepends: C1\nEvidence: pass — checked second\n`;
}

async function createWithText(project: string, text: string, sessionId = "s1") {
  const created = await createCharter(project, { objective: "Ship it", now: "2026-07-02T00:00:00.000Z", sessionId });
  await writeTextAtomic(join(charterDir(project, created.charterId), "charter.md"), text);
  return created.charterId;
}

describe("service lifecycle", () => {
  test("create status pause resume complete happy path", async () => {
    const project = await tempProject();
    const id = await createWithText(project, md("pass — checked first"));
    let status = await getCharterStatus(project, { charterId: id });
    expect(status.evidenceCounts.pass).toBe(2);
    expect(status.nextActions.map((action) => action.action)).toContain("complete");

    expect((await pauseCharter(project, { charterId: id })).status).toBe("paused");
    expect((await resumeCharter(project, { charterId: id })).status).toBe("active");

    await expect(completeCharter(project, { charterId: id })).rejects.toThrow("REPORT.md scaffolded");
    expect(await pathExists(reportPath(charterDir(project, id)))).toBe(true);
    const completed = await completeCharter(project, { charterId: id, note: "done" });
    expect(completed.status).toBe("completed");
  });

  test("complete rejects fail, none, empty pass note, and stale pass", async () => {
    const project = await tempProject();
    const fail = await createWithText(project, md("fail — broken"), "fail-session");
    await expect(completeCharter(project, { charterId: fail })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: fail })).rejects.toThrow("fail evidence");

    const none = await createWithText(project, md("none"), "none-session");
    await expect(completeCharter(project, { charterId: none })).rejects.toThrow("REPORT.md scaffolded");
    await expect(completeCharter(project, { charterId: none })).rejects.toThrow("no evidence");

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
