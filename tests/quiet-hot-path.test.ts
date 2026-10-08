import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import charterExtension from "../src/index";
import { createCharter, getBoundCharterStatus, getCharterStatus, pauseCharter } from "../src/application/service";
import * as store from "../src/infrastructure/store";
import { charterDir, chartersRoot, readEvents, withCharterLock } from "../src/infrastructure/store";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A Pi stand-in that keeps every handler per event, so the real extension registration is exercised. */
function loadExtension() {
  const handlers = new Map<string, Handler[]>();
  const bus = new EventEmitter();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        bus.on(event, handler);
        return () => bus.off(event, handler);
      },
      emit: (event: string, payload: unknown) => bus.emit(event, payload),
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
  };
  charterExtension(pi as never);
  const fire = async (event: string, payload: unknown, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { fire };
}

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) out[name] = await readFile(join(dir, name), "utf8").catch(() => "<dir>");
  return out;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("quiet hot path", () => {
  test("ordinary tool results and turn boundaries neither touch Charter files nor wait for the project lock", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-hot-path-"));
    const created = await createCharter(project, { objective: "Stay quiet", sessionId: "s1" });
    const dir = charterDir(project, created.charterId);
    const before = await snapshotTree(dir);
    const rootBefore = await readdir(chartersRoot(project));
    const ctx = {
      cwd: project,
      hasUI: true,
      isIdle: () => false,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => undefined, setWidget: () => undefined },
    };
    const extension = loadExtension();
    await extension.fire("session_start", {}, ctx);
    cleanups.push(() => void extension.fire("session_shutdown", {}, ctx));

    // The edit must not be journaled or hashed by anything the hot path does.
    await writeFile(join(dir, "charter.md"), "# Objective\nEdited mid-run\n");
    const reads = [spyOn(store, "loadCharterState"), spyOn(store, "loadCharterText"), spyOn(store, "listCharterIds")];
    const locks = spyOn(store, "withCharterLock");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withCharterLock(chartersRoot(project), () => held);
    try {
      const events = [
        ["agent_start", {}], ["message_update", {}], ["tool_call", { toolName: "read" }],
        ["tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }],
        ["tool_result", { toolName: "write", isError: false, content: [] }],
        ["turn_end", {}],
      ] as const;
      const settled = Promise.all(events.map(([event, payload]) => extension.fire(event, payload, ctx))).then(() => "done");
      const outcome = await Promise.race([settled, Bun.sleep(1_000).then(() => "blocked")]);
      expect(outcome).toBe("done");
      expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
      expect(locks.mock.calls.length).toBe(1); // only the test's own holder
    } finally {
      release();
      await holder;
      for (const spy of [...reads, locks]) spy.mockRestore();
    }

    const after = await snapshotTree(dir);
    expect({ ...after, "charter.md": undefined }).toEqual({ ...before, "charter.md": undefined });
    expect((await readEvents(dir)).map((event) => event.type)).toEqual(["charter_created"]);
    expect(await readdir(chartersRoot(project))).toEqual(rootBefore);
  });

  test("status and bound lookup read the current file without the lock or any state write", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-fresh-read-"));
    const created = await createCharter(project, { objective: "Original", sessionId: "s1" });
    const dir = charterDir(project, created.charterId);
    const before = await snapshotTree(dir);
    await writeFile(join(dir, "charter.md"), "# Objective\nEdited\n\n## References\nSee docs\n\n## Scope\nOnly src\n\n## Notes\nfree text\n");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withCharterLock(chartersRoot(project), () => held);
    try {
      const read = Promise.all([
        getCharterStatus(project, { charterId: created.charterId }),
        getBoundCharterStatus(project, "s1"),
      ]).then((value) => value);
      const result = await Promise.race([read, Bun.sleep(1_000).then(() => "blocked" as const)]);
      if (result === "blocked") throw new Error("status read waited for the mutation lock");
      for (const status of result) {
        if (!status) throw new Error("bound charter not found");
        expect(status).toMatchObject({ objective: "Edited", references: "See docs", scope: "Only src" });
        expect(status.notes).toContain("free text");
      }
    } finally {
      release();
      await holder;
    }
    expect({ ...(await snapshotTree(dir)), "charter.md": undefined }).toEqual({ ...before, "charter.md": undefined });
  });

  test("old snapshotHash fields and charter_file_changed history are accepted and left alone", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-old-hash-"));
    const created = await createCharter(project, { objective: "Old hash", sessionId: "s1" });
    const dir = charterDir(project, created.charterId);
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ ...state, snapshotHash: "stale-hash" }));
    const history = `${await readFile(join(dir, "events.jsonl"), "utf8")}${JSON.stringify({ type: "charter_file_changed", ts: "2026-07-02T00:00:00.000Z", charterId: created.charterId, snapshotHash: "stale-hash" })}\n`;
    await writeFile(join(dir, "events.jsonl"), history);
    await writeFile(join(dir, "charter.md"), "# Objective\nChanged since the hash\n");
    const stateBefore = await readFile(join(dir, "state.json"), "utf8");

    expect((await getCharterStatus(project, { charterId: created.charterId })).objective).toBe("Changed since the hash");
    expect(await readFile(join(dir, "state.json"), "utf8")).toBe(stateBefore);
    expect(await readFile(join(dir, "events.jsonl"), "utf8")).toBe(history);

    await pauseCharter(project, { sessionId: "s1" });
    expect((await readFile(join(dir, "events.jsonl"), "utf8")).startsWith(history)).toBe(true);
    expect((await readEvents(dir)).map((event) => event.type)).toEqual(["charter_created", "charter_file_changed", "charter_paused"]);
  });
});
