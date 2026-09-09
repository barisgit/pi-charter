import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { appendEvent, charterDir, chartersRoot, createCharterWorkspace, listCharters, loadCharterState, loadParsedCharter, pathExists, readEvents, writeCharterState, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-store-"));
}

describe("charter store", () => {
  test("creates a phase-schema workspace without criterion sequence state", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, {
      charterId: "20260702-000000-ship-runtime", objective: "Ship runtime", now: "2026-07-02T00:00:00.000Z", sessionId: "s1",
    });
    expect(created.charterDir).toBe(charterDir(project, created.charterId));
    expect(created.state).toMatchObject({ schemaVersion: "phases", objective: "Ship runtime", status: "active", sessionId: "s1" });
    expect(created.state).not.toHaveProperty("nextSeq");
    expect(created.state).not.toHaveProperty("criteriaSnapshot");
    expect(await pathExists(join(created.charterDir, "work"))).toBe(false);
    const parsed = await loadParsedCharter(created.charterDir);
    expect(parsed.phases).toEqual([{ number: 1, title: "Explore phases", status: "current", body: "" }]);
  });

  test("lists legacy charters read-only and marks them legacy", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, { charterId: "20260702-000000-new", objective: "New", now: "2026-07-02T00:00:00.000Z" });
    const legacyDir = charterDir(project, "20260701-000000-old");
    await writeTextAtomic(join(legacyDir, "charter.md"), "## Objective\n\nOld\n\n## Criteria\n");
    await writeTextAtomic(join(legacyDir, "state.json"), `${JSON.stringify({
      charterId: "20260701-000000-old", schemaVersion: "file-interface", objective: "Old", status: "active",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", sessionId: "s1",
      nextSeq: 8, latestSourceSeq: 7, criteriaSnapshot: [], snapshotHash: "legacy-hash",
    })}\n`);
    const rows = await listCharters(project);
    expect(rows.map((row) => [row.charterId, row.legacy])).toEqual([[created.charterId, false], ["20260701-000000-old", true]]);
    const legacy = await loadCharterState(legacyDir);
    expect(legacy).toMatchObject({ schemaVersion: "file-interface", objective: "Old", status: "active", sessionId: "s1" });
    expect(legacy).not.toHaveProperty("nextSeq");
    await expect(writeCharterState(legacyDir, legacy)).rejects.toThrow("Legacy charters are read-only");
  });

  test("lists charters reverse-sorted by id", async () => {
    const project = await tempProject();
    await createCharterWorkspace(project, { charterId: "20260702-000000-a", objective: "A", now: "2026-07-02T00:00:00.000Z" });
    await createCharterWorkspace(project, { charterId: "20260703-000000-b", objective: "B", now: "2026-07-03T00:00:00.000Z" });
    expect((await listCharters(project)).map((row) => row.charterId)).toEqual(["20260703-000000-b", "20260702-000000-a"]);
    expect(await pathExists(join(chartersRoot(project), "index.json"))).toBe(false);
  });

  test("appends journal events", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, { charterId: "20260702-000000-a", objective: "A", now: "2026-07-02T00:00:00.000Z" });
    await appendEvent(created.charterDir, { type: "custom", ts: "2026-07-02T00:00:01.000Z", charterId: created.charterId, value: 1 });
    expect((await readEvents(created.charterDir)).map((event) => event.type)).toEqual(["charter_created", "custom"]);
  });

  test("atomic text write replaces full contents", async () => {
    const project = await tempProject();
    const path = join(project, "file.txt");
    await writeTextAtomic(path, "old");
    await writeTextAtomic(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).isFile()).toBe(true);
  });
});
