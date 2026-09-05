import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { listCharters, readEvents } from "../src/infrastructure/store";

const store = resolve(import.meta.dir, "../src/infrastructure/store.ts");
const service = resolve(import.meta.dir, "../src/application/service.ts");

async function runWriters(project: string, bodies: string[]) {
  const children = bodies.map((body) => Bun.spawn([process.execPath, "--eval", `console.log("ready");\n${body}`], {
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }));
  try {
    // Each child imports the real implementation before waiting on this start barrier.
    await Promise.all(children.map(async (child) => {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value).trim()).toBe("ready");
    }));
    for (const child of children) child.stdin.end();
    return await Promise.all(children.map(async (child) => {
      const output = (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of child.stdout) chunks.push(chunk);
        return Buffer.concat(chunks).toString("utf8");
      })();
      const error = new Response(child.stderr).text();
      expect(await child.exited, await error).toBe(0);
      return await output;
    }));
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}

test("independent processes preserve every complete journal event", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    await runWriters(project, Array.from({ length: 30 }, (_, writer) => `
      import { appendEvent } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      await appendEvent(${JSON.stringify(project)}, {
        type: "custom", ts: "2026-09-05T00:00:00.000Z", charterId: "test",
        writer: ${writer}, payload: "x".repeat(100000),
      });
    `));
    const events = await readEvents(project);
    expect(events).toHaveLength(30);
    expect(events.map((event) => event.writer).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 30 }, (_, i) => i));
    for (const event of events) expect(event.payload).toBe("x".repeat(100000));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("independent same-session creation allows one active charter", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const results = await runWriters(project, Array.from({ length: 20 }, (_, writer) => `
      import { createCharter } from ${JSON.stringify(service)};
      await Bun.stdin.text();
      try {
        await createCharter(${JSON.stringify(project)}, { objective: "Writer ${writer}", sessionId: "shared" });
        console.log("created");
      } catch (error) {
        if (error.code !== "create.active_exists") throw error;
        console.log("rejected");
      }
    `));
    expect(results.filter((result) => result.trim() === "created")).toHaveLength(1);
    expect((await listCharters(project)).filter((row) => row.status === "active")).toHaveLength(1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("independent mutations leave a permitted lifecycle history", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const { createCharter } = await import("../src/application/service");
    const { charterDir, loadCharterState } = await import("../src/infrastructure/store");
    const created = await createCharter(project, { objective: "Transitions", sessionId: "shared" });
    const results = await runWriters(project, Array.from({ length: 20 }, (_, writer) => `
      import { pauseCharter, abandonCharter } from ${JSON.stringify(service)};
      await Bun.stdin.text();
      try {
        await ${writer % 2 ? "pauseCharter" : "abandonCharter"}(${JSON.stringify(project)}, {
          charterId: ${JSON.stringify(created.charterId)}, note: "stop",
        });
        console.log("changed");
      } catch (error) {
        if (!/Only active|already abandoned/.test(error.message)) throw error;
        console.log("rejected");
      }
    `));
    const dir = charterDir(project, created.charterId);
    const events = (await readEvents(dir)).map((event) => event.type);
    expect([
      ["charter_created", "charter_abandoned"],
      ["charter_created", "charter_paused", "charter_abandoned"],
    ]).toContainEqual(events);
    expect(results.filter((result) => result.trim() === "changed")).toHaveLength(events.length - 1);
    expect((await loadCharterState(dir)).status).toBe("abandoned");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("concurrent session binding revalidates the one-active invariant", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const { createCharter, pauseCharter } = await import("../src/application/service");
    const paused = await createCharter(project, { objective: "Resume", sessionId: "old" });
    await pauseCharter(project, { charterId: paused.charterId });
    const active = await createCharter(project, { objective: "Bind", sessionId: "other" });
    const results = await runWriters(project, [
      `resumeCharter(project, { charterId: ${JSON.stringify(paused.charterId)}, sessionId: "shared" })`,
      `bindCharterToSession(project, { charterId: ${JSON.stringify(active.charterId)}, sessionId: "shared" })`,
      `createCharter(project, { objective: "Create", sessionId: "shared" })`,
    ].map((call) => `
      import { resumeCharter, bindCharterToSession, createCharter } from ${JSON.stringify(service)};
      const project = ${JSON.stringify(project)};
      await Bun.stdin.text();
      try {
        await ${call};
        console.log("bound");
      } catch (error) {
        if (!/already has active/.test(error.message)) throw error;
        console.log("rejected");
      }
    `));
    expect(results.filter((result) => result.trim() === "bound")).toHaveLength(1);
    expect((await listCharters(project)).filter((row) => row.sessionId === "shared" && row.status === "active")).toHaveLength(1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("snapshot writers cannot overwrite concurrent lifecycle mutations", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const { createCharter } = await import("../src/application/service");
    const { charterDir, loadCharterState } = await import("../src/infrastructure/store");
    const created = await createCharter(project, { objective: "Snapshots", sessionId: "shared" });
    await runWriters(project, [
      ...Array.from({ length: 20 }, () => `
        import { tickToolResult } from ${JSON.stringify(resolve(import.meta.dir, "../src/application/staleness.ts"))};
        await Bun.stdin.text();
        await tickToolResult(${JSON.stringify(project)}, { sessionId: "shared", files: ["src/file.ts"] });
      `),
      `import { pauseCharter } from ${JSON.stringify(service)};
       await Bun.stdin.text();
       await pauseCharter(${JSON.stringify(project)}, { charterId: ${JSON.stringify(created.charterId)} });`,
    ]);
    const dir = charterDir(project, created.charterId);
    const state = await loadCharterState(dir);
    expect(state.status).toBe("paused");
    expect(state.nextSeq).toBe(21);
    const events = (await readEvents(dir)).filter((event) => event.type === "source_modified");
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("concurrent completion and abandonment commit only one terminal transition", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const { createCharter, completeCharter } = await import("../src/application/service");
    const { charterDir, loadCharterState, writeTextAtomic } = await import("../src/infrastructure/store");
    const created = await createCharter(project, { objective: "Finish", sessionId: "shared" });
    const dir = charterDir(project, created.charterId);
    await writeTextAtomic(join(dir, "charter.md"), "## Objective\nFinish\n\n### C1. Works\nStatus: pass — checked\n");
    await expect(completeCharter(project, { charterId: created.charterId })).rejects.toThrow("REPORT.md scaffolded");
    const results = await runWriters(project, Array.from({ length: 10 }, (_, writer) => `
      import { completeCharter, abandonCharter } from ${JSON.stringify(service)};
      await Bun.stdin.text();
      try {
        await ${writer % 2 ? "completeCharter" : "abandonCharter"}(${JSON.stringify(project)}, {
          charterId: ${JSON.stringify(created.charterId)}, note: "finished",
        });
        console.log("changed");
      } catch (error) {
        if (!/Only active|already completed|already abandoned/.test(error.message)) throw error;
        console.log("rejected");
      }
    `));
    expect(results.filter((result) => result.trim() === "changed")).toHaveLength(1);
    const events = (await readEvents(dir)).filter((event) => ["charter_completed", "charter_abandoned"].includes(event.type));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(`charter_${(await loadCharterState(dir)).status}`);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("mutation and journal locks release after exceptions", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    await runWriters(project, [`
      import { withCharterLock, appendEvent } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      try {
        await withCharterLock(${JSON.stringify(project)}, async () => { throw new Error("test failure"); });
      } catch (error) {
        if (error.message !== "test failure") throw error;
      }
      try {
        await appendEvent(${JSON.stringify(project)}, { toJSON() { throw new Error("test failure"); } });
      } catch (error) {
        if (error.message !== "test failure") throw error;
      }
    `]);
    await runWriters(project, [`
      import { withCharterLock, appendEvent } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      await withCharterLock(${JSON.stringify(project)}, () => appendEvent(${JSON.stringify(project)}, {
        type: "custom", ts: "2026-09-05T00:00:00.000Z", charterId: "test",
      }));
    `]);
    expect(await readEvents(project)).toHaveLength(1);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(project)).toEqual(["events.jsonl"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("background entry points leave a missing charter root untouched", async () => {
  const { refreshSessionSnapshots, recordSourceModification, tickToolResult } = await import("../src/application/staleness");
  const { readdir } = await import("node:fs/promises");
  for (const run of [
    (project: string) => refreshSessionSnapshots(project),
    (project: string) => recordSourceModification(project, { files: ["src/file.ts"] }),
    (project: string) => tickToolResult(project, { files: ["src/file.ts"] }),
  ]) {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
    try {
      await run(project);
      expect(await readdir(project)).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
});

test("dead owners recover with competing independent reclaimers", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    await runWriters(project, [`
      import { withCharterLock } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      await withCharterLock(${JSON.stringify(project)}, async () => process.exit(0));
    `, `
      import { appendEvent } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      await appendEvent(${JSON.stringify(project)}, { toJSON() { process.exit(0); } });
    `]);
    const started = Date.now();
    await runWriters(project, Array.from({ length: 20 }, (_, writer) => `
      import { withCharterLock, appendEvent } from ${JSON.stringify(store)};
      import { mkdir, rmdir } from "node:fs/promises";
      await Bun.stdin.text();
      await withCharterLock(${JSON.stringify(project)}, async () => {
        await mkdir(${JSON.stringify(join(project, "exclusive"))});
        await Bun.sleep(5);
        await appendEvent(${JSON.stringify(project)}, { type: "custom", ts: "now", charterId: "test", writer: ${writer} });
        await rmdir(${JSON.stringify(join(project, "exclusive"))});
      });
    `));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await readEvents(project)).toHaveLength(20);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("live owners are not stolen by another process", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  const holder = Bun.spawn([process.execPath, "--eval", `
    import { withCharterLock } from ${JSON.stringify(store)};
    await withCharterLock(${JSON.stringify(project)}, async () => {
      console.log("held");
      await Bun.stdin.text();
    });
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("held");
    reader.releaseLock();
    const waiting = runWriters(project, [`
      import { withCharterLock } from ${JSON.stringify(store)};
      await Bun.stdin.text();
      await withCharterLock(${JSON.stringify(project)}, () => Bun.write(${JSON.stringify(join(project, "entered"))}, "yes"));
    `]);
    await Bun.sleep(200);
    expect(await Bun.file(join(project, "entered")).exists()).toBe(false);
    holder.stdin.end();
    await waiting;
    expect(await holder.exited).toBe(0);
    expect(await Bun.file(join(project, "entered")).exists()).toBe(true);
  } finally {
    holder.kill();
    await holder.exited;
    await rm(project, { recursive: true, force: true });
  }
}, 20000);

test("unknown and foreign lock ownership fails promptly without deletion", async () => {
  const { mkdir, writeFile, readdir } = await import("node:fs/promises");
  for (const owner of [undefined, "owner-invalid", `owner-${"0".repeat(64)}-123-${"a".repeat(32)}`]) {
    const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
    try {
      const lock = join(project, ".mutation.lock");
      await mkdir(lock);
      if (owner) await writeFile(join(lock, owner), "");
      const before = await readdir(lock);
      const started = Date.now();
      await runWriters(project, [`
        import { withCharterLock } from ${JSON.stringify(store)};
        await Bun.stdin.text();
        try {
          await withCharterLock(${JSON.stringify(project)}, async () => { throw new Error("entered"); });
          throw new Error("accepted");
        } catch (error) {
          if (!error.message.includes("Stop all project writers")) throw error;
        }
      `]);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await readdir(lock)).toEqual(before);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
}, 20000);

test("internal mutation lock is excluded from charter ids", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-concurrency-"));
  try {
    const { withCharterLock, chartersRoot, listCharterIds } = await import("../src/infrastructure/store");
    await withCharterLock(chartersRoot(project), async () => {
      expect(await listCharterIds(project)).toEqual([]);
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
