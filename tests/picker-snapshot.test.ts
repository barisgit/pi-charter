import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { abandonCharter, createCharter } from "../src/application/service";
import { buildPickerRows, buildPickerSnapshot, listAllCharters, statusSummary } from "../src/ui/picker-snapshot";
import { charterDir, charterFilePath, reportPath } from "../src/infrastructure/store";

const PHASES = `# Objective\n\nShip the picker.\n\n## References\n\ndocs/spec.md\n\n## Scope\n\nPicker only.\n\n## Phases\n\n1. Explore — done\n   Mapped the UI.\n\n2. Build — current\n   Implement dashboard. [capture](work/dashboard.png)\n\n3. Verify\n   Exercise the TUI.\n`;

describe("picker snapshot", () => {
  test("projects phases, current work, and done/total position", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-snapshot-"));
    const created = await createCharter(project, { objective: "Ship the picker", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(charterFilePath(charterDir(project, created.charterId)), PHASES, "utf8");

    const rows = await buildPickerRows(project, { sessionId: "session-1", now: new Date("2026-07-02T12:00:00.000Z") });
    expect(rows[0]).toMatchObject({
      status: "active",
      sessionBound: true,
      phaseCounts: { done: 1, current: 1, upcoming: 1 },
      phaseCount: 3,
      currentPhase: { number: 2, title: "Build" },
      legacy: false,
      age: "2h",
    });
    expect(statusSummary(rows[0]!)).toBe("done=1/3 current=2");

    const snapshot = await buildPickerSnapshot(project, created.charterId);
    expect(snapshot).toMatchObject({
      objective: "Ship the picker.",
      references: "docs/spec.md",
      scope: "Picker only.",
      legacy: false,
      header: { doneCount: 1, totalCount: 3 },
    });
    expect(snapshot?.phases[1]).toEqual({ number: 2, title: "Build", status: "current", body: "Implement dashboard. [capture](work/dashboard.png)" });
  });

  test("includes REPORT.md content when present", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-report-"));
    const created = await createCharter(project, { objective: "Archive work", now: "2026-07-02T10:00:00.000Z", sessionId: "session-1" });
    await writeFile(reportPath(charterDir(project, created.charterId)), "# Final report\n\n- work/output.txt\n", "utf8");
    await abandonCharter(project, { charterId: created.charterId, sessionId: "session-1", note: "done enough" });
    const snapshot = await buildPickerSnapshot(project, created.charterId);
    expect(snapshot?.report?.markdown).toContain("work/output.txt");
  });

  test("keeps legacy charters visible and marks them read-only without projecting criteria", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-picker-legacy-"));
    const id = "20260701-100000-legacy-charter";
    const dir = charterDir(project, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify({ charterId: id, schemaVersion: "file-interface", objective: "Old objective", status: "completed", createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-01T11:00:00.000Z" }), "utf8");
    await writeFile(join(dir, "charter.md"), "# Charter\n\n## Objective\n\nOld objective\n\n## Criteria\n\n### C1. Old content\nStatus: pass — observed\n", "utf8");

    const rows = await listAllCharters(project);
    expect(rows[0]).toMatchObject({ charterId: id, legacy: true, doneCount: 0, totalCount: 0, sessionId: undefined });
    const snapshot = await buildPickerSnapshot(project, id);
    expect(snapshot).toMatchObject({ legacy: true, phases: [], warnings: [] });
    expect(snapshot?.charterMarkdown).toContain("### C1. Old content");
  });
});
