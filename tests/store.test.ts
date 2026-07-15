import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { appendEvent, charterDir, chartersRoot, createCharterWorkspace, listCharters, loadCharterState, loadParsedCharter, pathExists, readEvents, writeTextAtomic } from "../src/infrastructure/store";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-store-"));
}

describe("charter store", () => {
  test("creates the hard-cut workspace shape", async () => {
    const project = await tempProject();
    const now = "2026-07-02T00:00:00.000Z";
    const created = await createCharterWorkspace(project, {
      charterId: "20260702-000000-ship-runtime",
      objective: "Ship runtime",
      now,
      sessionId: "s1",
    });
    expect(created.charterDir).toBe(charterDir(project, created.charterId));
    expect(await pathExists(join(created.charterDir, "charter.md"))).toBe(true);
    expect(await pathExists(join(created.charterDir, "state.json"))).toBe(true);
    expect(await pathExists(join(created.charterDir, "events.jsonl"))).toBe(true);
    expect(await pathExists(join(created.charterDir, "work"))).toBe(false);
    expect(await pathExists(join(project, ".pi", "charters"))).toBe(false);
    const parsed = await loadParsedCharter(created.charterDir);
    expect(parsed.objective).toBe("Ship runtime");
    expect(parsed.openEnded).toBe(true);
  });

  test("lists charters reverse-sorted by id", async () => {
    const project = await tempProject();
    await createCharterWorkspace(project, { charterId: "20260702-000000-a", objective: "A", now: "2026-07-02T00:00:00.000Z" });
    await createCharterWorkspace(project, { charterId: "20260703-000000-b", objective: "B", now: "2026-07-03T00:00:00.000Z" });
    expect((await listCharters(project)).map((row) => row.charterId)).toEqual([
      "20260703-000000-b",
      "20260702-000000-a",
    ]);
    expect(await pathExists(join(chartersRoot(project), "index.json"))).toBe(false);
  });

  test("appends journal events", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, { charterId: "20260702-000000-a", objective: "A", now: "2026-07-02T00:00:00.000Z" });
    await appendEvent(created.charterDir, { type: "custom", ts: "2026-07-02T00:00:01.000Z", charterId: created.charterId, value: 1 });
    const events = await readEvents(created.charterDir);
    expect(events.map((event) => event.type)).toEqual(["charter_created", "custom"]);
  });

  test("atomic text write replaces full contents", async () => {
    const project = await tempProject();
    const path = join(project, "file.txt");
    await writeTextAtomic(path, "old");
    await writeTextAtomic(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).isFile()).toBe(true);
  });

  test("normalizes legacy evidence snapshots into the unified status model", async () => {
    const project = await tempProject();
    const created = await createCharterWorkspace(project, { charterId: "20260702-000000-legacy", objective: "Legacy", now: "2026-07-02T00:00:00.000Z" });
    const statePath = join(created.charterDir, "state.json");
    await writeTextAtomic(statePath, `${JSON.stringify({
      ...created.state,
      criteriaSnapshot: [{
        id: "C1",
        title: "Works",
        depends: [],
        evidence: { status: "none", note: "" },
        evidenceSeq: 4,
      }],
    })}\n`);

    const loaded = await loadCharterState(created.charterDir);
    expect(loaded.criteriaSnapshot).toEqual([{ id: "C1", title: "Works", depends: [], status: { value: "pending", note: "" }, statusSeq: 4 }]);
  });
});
