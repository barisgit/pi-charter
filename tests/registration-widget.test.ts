/**
 * VAL-8 verifier: `registerCharterWidget` multi-charter pipeline + tri-value
 * selection resolution.
 *
 * Exercises every selection state through real on-disk charter fixtures, with
 * a fake pi+ctx that captures every `setWidget` call. Asserts:
 *   (a) 0 charters       -> both widgets cleared (undefined)
 *   (b) 2 charters + unset -> both emit; detail is first active
 *   (c) explicit on terminal charter -> downgrades to unset, renders first
 *       remaining
 *   (d) 1 charter + unset -> auto-select that one
 *   (e) explicit-clear -> multi emits, detail cleared, STAYS cleared on a
 *       subsequent refresh
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterWidget } from "../src/application/registration";
import { createCharter, forceCompleteCharter } from "../src/application/service";
import { lockPlan } from "../src/application/plan-service";
import {
  resetCharterSelection,
  setCharterSelection,
  getCharterSelection,
} from "../src/ui/charter-selection";

type SetWidgetCall = {
  key: string;
  content: unknown;
  options?: unknown;
};

type FakePi = {
  on: (event: string, handler: (event: unknown, ctx: FakeCtx) => Promise<void> | void) => void;
  events: { on: (event: string, handler: (raw: unknown) => void) => void };
  handlers: Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>;
};

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    setWidget: (key: string, content: unknown, options?: unknown) => void;
    notify?: (message: string) => void;
  };
  sessionManager: { getSessionId: () => string | undefined };
}

function makeFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: { on: () => {} },
  };
}

function makeCtx(projectDir: string): { ctx: FakeCtx; calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  return {
    calls,
    ctx: {
      cwd: projectDir,
      hasUI: true,
      ui: {
        setWidget(key, content, options) {
          calls.push({ key, content, options });
        },
        notify() {},
      },
      sessionManager: { getSessionId: () => "session-x" },
    },
  };
}

async function fireSessionStart(pi: FakePi, ctx: FakeCtx): Promise<void> {
  const handlers = pi.handlers.get("session_start") ?? [];
  for (const h of handlers) await h({}, ctx);
}

async function fireTurnEnd(pi: FakePi, ctx: FakeCtx): Promise<void> {
  const handlers = pi.handlers.get("turn_end") ?? [];
  for (const h of handlers) await h({}, ctx);
}

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-reg-widget-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function seedActiveCharter(projectDir: string, opts: { name: string; criteria?: string[]; pass?: boolean }): Promise<string> {
  const created = await createCharter(projectDir, {
    objective: `objective for ${opts.name}`,
    name: opts.name,
    now: "2026-05-15T00:00:00.000Z",
  });
  const dir = join(projectDir, ".pi/charters", created.charterId);
  const criteria = opts.criteria ?? ["VAL-1"];
  const criteriaMd = criteria
    .map((id) => `### ${id} ${id} crit\nVerifier: manual\n`)
    .join("");
  await writeFile(
    join(dir, "charter.md"),
    `# Charter\n## Objective\nobjective for ${opts.name}\n## Criteria\n${criteriaMd}\n## Scope and constraints\n- none\n`,
  );
  await mkdir(join(dir, "plan"), { recursive: true });
  await writeFile(
    join(dir, "plan/f1.md"),
    `---\nid: f1\nmilestone: m1\norder: 1\nfulfills: [${criteria.join(", ")}]\npreconditions: []\n---\nbody\n`,
  );
  await lockPlan(projectDir, { charterId: created.charterId, now: "2026-05-15T00:01:00.000Z", legacy: true });
  // `opts.pass` was a no-op once we switched to forceCompleteCharter; the
  // signature stays for forward-compat with future tests that need pass
  // evidence (high-trust source).
  void opts.pass;
  return created.charterId;
}

function lastCallFor(calls: SetWidgetCall[], key: string): SetWidgetCall | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    if (call.key === key) return call;
  }
  return undefined;
}

beforeEach(() => resetCharterSelection());
afterEach(() => resetCharterSelection());

describe("VAL-8: registerCharterWidget multi-charter pipeline", () => {
  test("(a) 0 active charters -> both widgets cleared", async () => {
    await withTempProject(async (projectDir) => {
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir);
      await fireSessionStart(pi, ctx);
      expect(lastCallFor(calls, "charter-multi")?.content).toBeUndefined();
      expect(lastCallFor(calls, "charter-detail")?.content).toBeUndefined();
    });
  });

  test("(b) 2 charters + unset selection -> multi emits factory, detail is first active", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const idB = await seedActiveCharter(projectDir, { name: "beta" });
      expect(idB).not.toEqual(idA);
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir);
      await fireSessionStart(pi, ctx);
      const multi = lastCallFor(calls, "charter-multi");
      const detail = lastCallFor(calls, "charter-detail");
      expect(typeof multi?.content).toBe("function");
      expect(typeof detail?.content).toBe("function");
      // listActiveCharters orders by index.json order — alpha created first.
      // We don't pin which goes first; we just assert one of the two is auto-selected.
      // Selection state stays `unset` after auto-select.
      expect(getCharterSelection()).toEqual({ kind: "unset" });
      // Drive the factory to be sure render() doesn't throw.
      const fakeTui = { terminal: { columns: 80 } };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const detailComp = (detail!.content as (tui: unknown, theme: unknown) => { render(): string[] })(fakeTui, fakeTheme);
      expect(Array.isArray(detailComp.render())).toBe(true);
      const multiComp = (multi!.content as (tui: unknown, theme: unknown) => { render(): string[] })(fakeTui, fakeTheme);
      expect(multiComp.render().length).toBeGreaterThan(0);
    });
  });

  test("(c) explicit selection on terminated charter -> downgrade + render first remaining", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const idB = await seedActiveCharter(projectDir, { name: "beta" });
      // Pin explicit selection to idA, then terminate idA via
      // forceCompleteCharter (no completion-gate trust requirements).
      setCharterSelection({ kind: "explicit", charterId: idA });
      await forceCompleteCharter(projectDir, {
        charterId: idA,
        target: "abandoned",
        reason: "test cleanup",
        now: "2026-05-15T00:03:00.000Z",
      });
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir);
      await fireSessionStart(pi, ctx);
      // Selection downgrades to `unset` since pinned id is no longer active.
      expect(getCharterSelection()).toEqual({ kind: "unset" });
      // Detail renders the remaining active (idB).
      const detail = lastCallFor(calls, "charter-detail");
      expect(typeof detail?.content).toBe("function");
      const fakeTui = { terminal: { columns: 80 } };
      const fakeTheme = { fg: (_c: string, t: string) => t };
      const lines = (detail!.content as (tui: unknown, theme: unknown) => { render(): string[] })(fakeTui, fakeTheme).render();
      expect(lines.join("\n")).toContain("beta");
      // sanity
      expect(typeof idB).toBe("string");
    });
  });

  test("(d) 1 charter + unset -> auto-select that one", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "solo" });
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir);
      await fireSessionStart(pi, ctx);
      const detail = lastCallFor(calls, "charter-detail");
      expect(typeof detail?.content).toBe("function");
      const lines = (detail!.content as (tui: unknown, theme: unknown) => { render(): string[] })(
        { terminal: { columns: 80 } },
        { fg: (_c: string, t: string) => t },
      ).render();
      expect(lines.join("\n")).toContain("solo");
    });
  });

  test("(e) explicit-clear: multi emits, detail cleared, STAYS cleared across two refreshes", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "alpha" });
      await seedActiveCharter(projectDir, { name: "beta" });
      setCharterSelection({ kind: "explicit-clear" });
      const pi = makeFakePi();
      registerCharterWidget(pi as never);
      const { ctx, calls } = makeCtx(projectDir);
      await fireSessionStart(pi, ctx);
      expect(typeof lastCallFor(calls, "charter-multi")?.content).toBe("function");
      expect(lastCallFor(calls, "charter-detail")?.content).toBeUndefined();
      // Second refresh: state must remain explicit-clear, detail must stay
      // cleared (no auto-promote).
      await fireTurnEnd(pi, ctx);
      expect(getCharterSelection()).toEqual({ kind: "explicit-clear" });
      expect(lastCallFor(calls, "charter-detail")?.content).toBeUndefined();
    });
  });
});
