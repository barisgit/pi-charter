import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { refreshCharterSnapshot, refreshSessionSnapshots } from "../src/application/snapshots";
import { charterDir, createCharterWorkspace, loadCharterState, readEvents, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-snapshot-"));
}

describe("whole-file snapshots", () => {
  test("journals one event when charter.md changes and none when unchanged", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, { charterId: "20260702-000000-observe", objective: "Observe", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    await writeTextAtomic(join(created.charterDir, "charter.md"), "# Objective\n\nObserve.\n\n## Phases\n\n1. Explore phases — done\n2. Build\n");
    const first = await refreshCharterSnapshot(project, created.charterId);
    expect(first.changed).toBe(true);
    expect((await readEvents(created.charterDir)).map((event) => event.type)).toEqual(["charter_created", "charter_file_changed"]);
    const second = await refreshCharterSnapshot(project, created.charterId);
    expect(second.changed).toBe(false);
    expect((await readEvents(created.charterDir)).filter((event) => event.type === "charter_file_changed")).toHaveLength(1);
  });

  test("refreshSessionSnapshots observes only matching new charters", async () => {
    const project = await tempProject();
    const match = await createCharterWorkspace(project, { charterId: "20260702-000000-match", objective: "Match", now: "2026-07-02T00:00:00.000Z", sessionId: "s1" });
    const other = await createCharterWorkspace(project, { charterId: "20260702-000001-other", objective: "Other", now: "2026-07-02T00:00:01.000Z", sessionId: "s2" });
    await writeTextAtomic(join(match.charterDir, "charter.md"), "# Objective\nMatch changed\n## Phases\n1. Explore phases");
    await writeTextAtomic(join(other.charterDir, "charter.md"), "# Objective\nOther changed\n## Phases\n1. Explore phases");
    await refreshSessionSnapshots(project, "s1");
    expect((await readEvents(match.charterDir)).some((event) => event.type === "charter_file_changed")).toBe(true);
    expect((await readEvents(other.charterDir)).some((event) => event.type === "charter_file_changed")).toBe(false);
  });

  test("legacy charters are parsed for display without state or event writes", async () => {
    const project = await tempProject();
    const dir = charterDir(project, "20260701-000000-legacy");
    await writeTextAtomic(join(dir, "charter.md"), "## Objective\nLegacy\n## Criteria\n");
    await writeTextAtomic(join(dir, "events.jsonl"), "");
    await writeTextAtomic(join(dir, "state.json"), `${JSON.stringify({ charterId: "20260701-000000-legacy", schemaVersion: "file-interface", objective: "Legacy", status: "active", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", snapshotHash: "old" }, null, 2)}\n`);
    const before = await readFile(join(dir, "state.json"), "utf8");
    await refreshSessionSnapshots(project);
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(before);
    expect(await readEvents(dir)).toEqual([]);
    expect((await loadCharterState(dir)).schemaVersion).toBe("file-interface");
  });
});
