import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterTools } from "../src/application/registration";

/**
 * VAL-2: When no charter is bound and no `charterId` is supplied, every
 * affected tool throws a typed structured error whose message contains the
 * literal phrase `"no charter bound"` and that exposes a `hint` field.
 */

interface FakeTool {
  execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: () => unknown, ctx: unknown) => Promise<unknown>;
}

function makeHarness(homeDir: string): { tools: Map<string, FakeTool> } {
  const tools = new Map<string, FakeTool>();
  const pi: any = {
    events: { emit() {} },
    registerTool(tool: FakeTool & { name: string }) { tools.set(tool.name, tool); },
    registerFlag() {},
    getFlag() { return ""; },
    on() {},
    sendMessage() {},
    sendUserMessage() {},
  };
  registerCharterTools(pi, { homeDir });
  return { tools };
}

function ctx(projectDir: string, sessionId?: string) {
  return {
    cwd: projectDir,
    hasUI: false,
    ui: { notify() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
}

async function withTempProject<T>(fn: (input: { projectDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-error-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pi-charter-defaults-error-home-"));
  try {
    return await fn({ projectDir, homeDir });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function expectNoCharterBound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(caught).toMatchObject({
    message: expect.stringContaining("no charter bound"),
    hint: expect.any(String),
  });
  expect((caught as { code?: unknown }).code).toBe("NO_CHARTER_BOUND");
}

describe("structured error when no charter is bound", () => {
  test("charter_status throws NoCharterBoundError when neither argument nor binding is present", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const { tools } = makeHarness(homeDir);
      await expectNoCharterBound(
        tools.get("charter_status")!.execute("c", {}, new AbortController().signal, () => undefined, ctx(projectDir, "sess-none")),
      );
      await expectNoCharterBound(
        tools.get("charter_status")!.execute("c", {}, new AbortController().signal, () => undefined, ctx(projectDir, undefined)),
      );
    });
  });

  test.each(["evidence"] as const)(
    "charter_record action=%s throws NoCharterBoundError",
    async (action) => {
      await withTempProject(async ({ projectDir, homeDir }) => {
        const { tools } = makeHarness(homeDir);
        await expectNoCharterBound(
          tools.get("charter_record")!.execute(
            "c",
            {
              action,
              criterionId: "VAL-X",
              featureId: "f1",
              outcome: "pass",
              summary: "summary",
              because: "manual probe",
            },
            new AbortController().signal,
            () => undefined,
            ctx(projectDir, "sess-none"),
          ),
        );
      });
    },
  );

  test.each(["pause", "resume", "complete", "abandon"] as const)(
    "charter action=%s throws NoCharterBoundError",
    async (action) => {
      await withTempProject(async ({ projectDir, homeDir }) => {
        const { tools } = makeHarness(homeDir);
        await expectNoCharterBound(
          tools.get("charter")!.execute(
            "c",
            { action, reason: "x", completionNote: "y" },
            new AbortController().signal,
            () => undefined,
            ctx(projectDir, "sess-none"),
          ),
        );
      });
    },
  );

  test("charter action=create is the documented exception (no NoCharterBoundError)", async () => {
    await withTempProject(async ({ projectDir, homeDir }) => {
      const { tools } = makeHarness(homeDir);
      const result = await tools.get("charter")!.execute(
        "c",
        { action: "create", objective: "ship defaults-error coverage" },
        new AbortController().signal,
        () => undefined,
        ctx(projectDir, "sess-create"),
      );
      expect((result as { details: { charterId: string } }).details.charterId).toBeDefined();
    });
  });
});
