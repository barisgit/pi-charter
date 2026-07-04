import { describe, expect, test } from "bun:test";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCharter } from "../src/application/service";
import { registerCharterWidget } from "../src/application/registration";

type SetWidgetCall = {
  key: string;
  content: unknown;
  options?: unknown;
};

type FakeCtx = {
  cwd: string;
  hasUI: boolean;
  ui: {
    setWidget: (key: string, content: unknown, options?: unknown) => void;
    notify: (message: string) => void;
  };
  sessionManager: { getSessionId: () => string | undefined };
};

function makeFakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: FakeCtx) => Promise<void> | void>>();
  return {
    handlers,
    on(event: string, handler: (event: unknown, ctx: FakeCtx) => Promise<void> | void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    events: { on: () => () => undefined, emit: () => undefined },
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

async function fireEvent(pi: ReturnType<typeof makeFakePi>, name: string, ctx: FakeCtx): Promise<void> {
  for (const h of pi.handlers.get(name) ?? []) await h({}, ctx);
}

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
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-glance-project-"));
    const sessionId = "session-bound";
    const created = await createCharter(projectDir, {
      objective: "glance widget fixture",
      now: "2026-07-02T10:00:00.000Z",
      sessionId,
    });

    const pi = makeFakePi();
    registerCharterWidget(pi as never);
    const { ctx, calls } = makeCtx(projectDir, sessionId);
    await fireEvent(pi, "session_start", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe("charter-detail");
    expect(typeof calls[0]?.content).toBe("function");
    expect(calls[0]?.options).toEqual({ placement: "aboveEditor" });

    const factory = calls[0]!.content as (tui: { terminal?: { columns?: number } }, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] };
    const lines = factory({ terminal: { columns: 100 } }, { fg: (_color, text) => text }).render(100);
    expect(lines.join("\n")).toContain("glance-widget-fixture");
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(100);
    expect(created.charterId).toContain("glance-widget-fixture");
  });

  test("missing session binding removes only the detail widget", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-glance-project-"));
    const sessionId = "session-bound";
    await createCharter(projectDir, {
      objective: "glance widget fixture",
      now: "2026-07-02T10:00:00.000Z",
      sessionId,
    });

    const pi = makeFakePi();
    registerCharterWidget(pi as never);
    const { ctx, calls } = makeCtx(projectDir, sessionId);
    await fireEvent(pi, "session_start", ctx);
    ctx.sessionManager.getSessionId = () => "other-session";
    await fireEvent(pi, "turn_end", ctx);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ key: "charter-detail", content: undefined, options: { placement: "aboveEditor" } });
  });
});
