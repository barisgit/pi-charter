import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterWidget } from "../src/application/registration";
import { bindCharterToSession } from "../src/application/binding-service";
import { resetCharterSelection } from "../src/ui/charter-selection";
import { makeActiveCharter } from "./helpers/charter-fixtures";

type SetWidgetCall = {
  key: string;
  content: unknown;
  options?: unknown;
};

type FakePi = {
  on: (event: string, handler: (event: unknown, ctx: FakeCtx) => Promise<void> | void) => void;
  events: { on: (event: string, handler: (raw: unknown) => void) => () => void };
  handlers: Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>;
};

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    setWidget: (key: string, content: unknown, options?: unknown) => void;
    notify: (message: string) => void;
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
    events: { on: () => () => {} },
  };
}

function makeCtx(projectDir: string, sessionId: string): { ctx: FakeCtx; calls: SetWidgetCall[] } {
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
      sessionManager: { getSessionId: () => sessionId },
    },
  };
}

async function fireSessionStart(pi: FakePi, ctx: FakeCtx): Promise<void> {
  const handlers = pi.handlers.get("session_start") ?? [];
  for (const h of handlers) await h({}, ctx);
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedActiveCharter(projectDir: string, charterId: string): Promise<string> {
  await makeActiveCharter({
    projectDir,
    charterId,
    objective: "glance widget fixture",
    now: "2026-05-15T00:00:00.000Z",
    criteria: [{ id: "VAL-GLANCE-002", title: "bound charter renders", because: "test fixture rationale" }],
  });
  return charterId;
}

beforeEach(() => resetCharterSelection());
afterEach(() => resetCharterSelection());

describe("glance widget cleanup", () => {
  test("multi-charter widget file and identifiers are absent", async () => {
    await access("src/ui/multi-charter-widget.ts").then(
      () => expect.unreachable("src/ui/multi-charter-widget.ts should not exist"),
      (error: NodeJS.ErrnoException) => expect(error.code).toBe("ENOENT"),
    );

    for (const pattern of [
      "renderMultiCharterWidget",
      "buildMultiCharterViewModel",
      "MultiCharterWidgetVM",
      "MULTI_WIDGET_KEY",
      "charter-multi",
    ]) {
      const proc = Bun.spawn(["grep", "-r", pattern, "src/"], { stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(1);
    }
  });

  test("session-bound charter renders the detail widget", async () => {
    await withTempDir("pi-charter-glance-project-", async (projectDir) => {
      await withTempDir("pi-charter-glance-home-", async (homeDir) => {
        const charterId = await seedActiveCharter(projectDir, `glance-${randomUUID()}`);
        const sessionId = `session-${randomUUID()}`;
        await bindCharterToSession(projectDir, { charterId, sessionId, homeDir });

        const pi = makeFakePi();
        registerCharterWidget(pi as never, { homeDir });
        const { ctx, calls } = makeCtx(projectDir, sessionId);
        await fireSessionStart(pi, ctx);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.key).toBe("charter-detail");
        expect(typeof calls[0]?.content).toBe("function");
        expect(calls[0]?.options).toEqual({ placement: "aboveEditor" });

        const factory = calls[0]!.content as (tui: { terminal?: { columns?: number } }, theme: { fg(color: string, text: string): string }) => { render(): string[] };
        const lines = factory({ terminal: { columns: 100 } }, { fg: (_color, text) => text }).render();
        expect(lines.join("\n")).toContain(charterId.slice(0, 8));
      });
    });
  });

  test("no session binding clears only the detail widget", async () => {
    await withTempDir("pi-charter-glance-project-", async (projectDir) => {
      await withTempDir("pi-charter-glance-home-", async (homeDir) => {
        const pi = makeFakePi();
        registerCharterWidget(pi as never, { homeDir });
        const { ctx, calls } = makeCtx(projectDir, `session-${randomUUID()}`);
        await fireSessionStart(pi, ctx);

        expect(calls).toEqual([{ key: "charter-detail", content: undefined, options: undefined }]);
      });
    });
  });
});
