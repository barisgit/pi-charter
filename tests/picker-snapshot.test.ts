import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { abandonCharter, createCharter, getCharterStatus, pauseCharter } from "../src/application/service";
import { buildPickerRows, buildPickerSnapshot, evidenceSummary, listAllCharters } from "../src/ui/picker-snapshot";
import { charterDir, charterFilePath, loadCharterState, reportPath, writeCharterState } from "../src/infrastructure/store";

const CRITERIA = `# Charter: newest

## Objective

Ship the picker.

## Criteria

### C1. Passing check
Evidence: pass — ok

### C2. Failing check
Depends: C1
Evidence: fail — nope

### C3. Missing check
Evidence: none
`;

describe("picker snapshot", () => {
  test("projects sorted charter rows with state, evidence, stale, binding, and open-ended markers", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-snapshot-"));
    const old = await createCharter(project, { objective: "Watch deployments", now: "2026-07-01T09:00:00.000Z", sessionId: "other" });
    await pauseCharter(project, { charterId: old.charterId, sessionId: "other" });

    const newest = await createCharter(project, { objective: "Ship the picker", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(charterFilePath(charterDir(project, newest.charterId)), CRITERIA, "utf8");
    await getCharterStatus(project, { charterId: newest.charterId });
    const state = await loadCharterState(project, newest.charterId);
    state.latestSourceSeq = state.nextSeq;
    await writeCharterState(charterDir(project, newest.charterId), state);

    const rows = await buildPickerRows(project, { sessionId: "session-1", now: new Date("2026-07-02T12:00:00.000Z") });

    expect(rows.map((row) => row.charterId)).toEqual([newest.charterId, old.charterId]);
    expect(rows[0]).toMatchObject({
      status: "active",
      slug: "ship-the-picker",
      sessionBound: true,
      evidenceCounts: { pass: 1, fail: 1, none: 1 },
      staleCount: 1,
      criteriaCount: 3,
      openEnded: false,
      age: "2h",
    });
    expect(evidenceSummary(rows[0])).toBe("pass=1 fail=1 none=1 stale=1");
    expect(rows[1]).toMatchObject({
      status: "paused",
      slug: "watch-deployments",
      sessionBound: false,
      evidenceCounts: { pass: 0, fail: 0, none: 0 },
      openEnded: true,
    });
    expect(evidenceSummary(rows[1])).toContain("open-ended");
  });

  test("builds a flat detail plan from ADR-0014 criteria", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-detail-"));
    const created = await createCharter(project, { objective: "Ship the picker", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(charterFilePath(charterDir(project, created.charterId)), CRITERIA, "utf8");

    const snapshot = await buildPickerSnapshot(project, created.charterId);

    expect(snapshot?.header).toMatchObject({
      name: "ship-the-picker",
      status: "active",
      passCount: 1,
      totalCount: 3,
    });
    expect(snapshot?.objective).toBe("Ship the picker");
    expect(snapshot?.blockingForComplete.length).toBeGreaterThan(0);
    expect(snapshot?.plan).toEqual({
      status: "in_progress",
      passCount: 1,
      totalCount: 3,
      criteria: [
        { criterionId: "C1", titleFromH3: "Passing check", depends: [], outcome: "pass" },
        { criterionId: "C2", titleFromH3: "Failing check", depends: ["C1"], outcome: "fail" },
        { criterionId: "C3", titleFromH3: "Missing check", depends: [], outcome: null },
      ],
    });
    expect(snapshot?.recentEvidence.map((row) => row.criterionId)).toEqual(["C1", "C2"]);
  });

  test("includes REPORT.md content when present", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-report-"));
    const created = await createCharter(project, { objective: "Archive done work", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(reportPath(charterDir(project, created.charterId)), "# Final report\n\n- work/output.txt\n", "utf8");
    await abandonCharter(project, { charterId: created.charterId, sessionId: "session-1", note: "done enough" });

    const snapshot = await buildPickerSnapshot(project, created.charterId);

    expect(snapshot?.header.status).toBe("abandoned");
    expect(snapshot?.report?.markdown).toContain("# Final report");
    expect(snapshot?.report?.markdown).toContain("work/output.txt");
  });

  test("marks scaffolded REPORT.md for non-terminal charters without changing live status", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-report-active-"));
    const created = await createCharter(project, { objective: "Finish active work", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(reportPath(charterDir(project, created.charterId)), "# Draft report\n", "utf8");

    const snapshot = await buildPickerSnapshot(project, created.charterId);

    expect(snapshot?.header.status).toBe("active");
    expect(snapshot?.report?.markdown).toBe("# Draft report\n");
  });

  test("omits report data when REPORT.md is missing", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-report-missing-"));
    const created = await createCharter(project, { objective: "No report yet", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });

    const snapshot = await buildPickerSnapshot(project, created.charterId);

    expect(snapshot?.report).toBeUndefined();
  });

  test("listAllCharters keeps non-terminal rows before terminal rows", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-list-"));
    const olderActive = await createCharter(project, { objective: "Older active", now: "2026-07-01T10:00:00.000Z", sessionId: "s1" });
    const abandoned = await createCharter(project, { objective: "Abandoned work", now: "2026-07-02T10:00:00.000Z", sessionId: "s2" });
    await abandonCharter(project, { charterId: abandoned.charterId, sessionId: "s2", note: "not needed" });

    const rows = await listAllCharters(project);

    expect(rows.map((row) => row.charterId)).toEqual([olderActive.charterId, abandoned.charterId]);
    expect(rows[0]).toMatchObject({ name: "older-active", status: "active", passCount: 0, totalCount: 0 });
    expect(rows[1]).toMatchObject({ name: "abandoned-work", status: "abandoned" });
  });
});
