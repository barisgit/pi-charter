/**
 * VAL-6 verifier: `/charters` slash command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharterCommands } from "../src/application/registration";
import {
  getCharterSelection,
  resetCharterSelection,
  setCharterSelection,
} from "../src/ui/charter-selection";
import { makeActiveCharter } from "./helpers/charter-fixtures";

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: FakeCommandCtx) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => unknown;
};

interface FakeCommandCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level?: string) => void;
    custom: <T>(factory: unknown, options?: unknown) => Promise<T>;
  };
  sessionManager: { getSessionId: () => string | undefined };
}

interface FakePi {
  commands: Map<string, RegisteredCommand>;
  registerCommand: (name: string, opts: RegisteredCommand) => void;
  sendUserMessage: (text: string) => void;
  sentUserMessages: string[];
  events: { on: () => () => void; emit: () => void };
}

function makeFakePi(): FakePi {
  const commands = new Map<string, RegisteredCommand>();
  const sentUserMessages: string[] = [];
  return {
    commands,
    sentUserMessages,
    registerCommand(name, opts) {
      commands.set(name, opts);
    },
    sendUserMessage(text) {
      sentUserMessages.push(text);
    },
    // The picker opens a short-lived utils client (connect) for a fullscreen
    // lease; with no widget host emitting `ready` it stays in fallback mode, so
    // a no-op event bus is enough to exercise the picker wiring.
    events: { on: () => () => {}, emit: () => {} },
  };
}

function makeCtx(projectDir: string, opts: { hasUI?: boolean; customResult?: unknown } = {}): {
  ctx: FakeCommandCtx;
  notifications: Array<{ message: string; level?: string }>;
  customCalls: Array<{ factory: unknown; options: unknown }>;
} {
  const notifications: Array<{ message: string; level?: string }> = [];
  const customCalls: Array<{ factory: unknown; options: unknown }> = [];
  return {
    notifications,
    customCalls,
    ctx: {
      cwd: projectDir,
      hasUI: opts.hasUI ?? true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        custom: async (factory, options) => {
          customCalls.push({ factory, options });
          return opts.customResult as never;
        },
      },
      sessionManager: { getSessionId: () => "session-x" },
    },
  };
}

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-charters-cmd-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function seedActiveCharter(projectDir: string, opts: { name: string; objective?: string }): Promise<string> {
  const charterId = randomUUID();
  await makeActiveCharter({
    projectDir,
    charterId,
    name: opts.name,
    objective: opts.objective ?? `objective for ${opts.name}`,
    now: "2026-05-15T00:00:00.000Z",
    criteria: [{ id: "VAL-1", title: "first", because: "test fixture rationale" }],
  });
  return charterId;
}

beforeEach(() => resetCharterSelection());
afterEach(() => resetCharterSelection());

describe("/charters command", () => {
  test("bare opens the picker via a true fullscreen custom UI (no overlay options)", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const idB = await seedActiveCharter(projectDir, { name: "beta" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const charters = pi.commands.get("charters")!;
      const { ctx, customCalls } = makeCtx(projectDir, { hasUI: true, customResult: null });
      await charters.handler("", ctx);
      // client.ui.fullscreen() acquires a fullscreen lease and runs the picker
      // via ctx.ui.custom with NO overlay options (true fullscreen).
      expect(customCalls).toHaveLength(1);
      expect(customCalls[0]!.options).toBeUndefined();
      // The picker is read-only: it only closes with null, so the bare command
      // never mutates the charter selection.
      expect(getCharterSelection()).toEqual({ kind: "unset" });
      expect(idB).not.toEqual(idA);
    });
  });

  test("list verb notifies one line per active charter", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "alpha" });
      await seedActiveCharter(projectDir, { name: "beta" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx, notifications } = makeCtx(projectDir);
      await pi.commands.get("charters")!.handler("list", ctx);
      expect(notifications).toHaveLength(1);
      const lines = notifications[0]!.message.split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toMatch(/^[0-9a-f]+\s+\w+\s+\w+\s+\d+\/\d+$/);
      }
    });
  });

  test("select <id> sets explicit selection", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx } = makeCtx(projectDir);
      await pi.commands.get("charters")!.handler(`select ${idA}`, ctx);
      expect(getCharterSelection()).toEqual({ kind: "explicit", charterId: idA });
    });
  });

  test("select none -> explicit-clear and the selection sticks (no auto-promote)", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "alpha" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx } = makeCtx(projectDir);
      await pi.commands.get("charters")!.handler("select none", ctx);
      expect(getCharterSelection()).toEqual({ kind: "explicit-clear" });
      expect(getCharterSelection()).toEqual({ kind: "explicit-clear" });
    });
  });

  test("status with no selection AND multiple actives re-opens the picker in TUI mode", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "alpha" });
      await seedActiveCharter(projectDir, { name: "beta" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx, customCalls } = makeCtx(projectDir, { hasUI: true, customResult: null });
      await pi.commands.get("charters")!.handler("status", ctx);
      expect(customCalls).toHaveLength(1);
    });
  });

  test("status with no selection AND multiple actives in non-TUI notifies a hint with ids", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const idB = await seedActiveCharter(projectDir, { name: "beta" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx, notifications } = makeCtx(projectDir, { hasUI: false });
      await pi.commands.get("charters")!.handler("status", ctx);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toContain(idA.slice(0, 8));
      expect(notifications[0]!.message).toContain(idB.slice(0, 8));
    });
  });

  test("status with no selection AND exactly one active falls back to that charter", async () => {
    await withTempProject(async (projectDir) => {
      await seedActiveCharter(projectDir, { name: "alpha" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx, notifications } = makeCtx(projectDir);
      await pi.commands.get("charters")!.handler("status", ctx);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.message).toContain("Charter ");
    });
  });

  test("status with explicit selection on a terminated charter downgrades to unset and falls back", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      setCharterSelection({ kind: "explicit", charterId: "ghost-charter-id" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const { ctx, notifications } = makeCtx(projectDir);
      await pi.commands.get("charters")!.handler("status", ctx);
      expect(notifications).toHaveLength(1);
      expect(getCharterSelection()).toEqual({ kind: "unset" });
      expect(typeof idA).toBe("string");
    });
  });
});

describe("/charters autocompletions", () => {
  test("empty / verb prefix completes the verb set", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charters = pi.commands.get("charters")!;
    const all = (await charters.getArgumentCompletions!("")) as Array<{ value: string }>;
    const values = all.map((item) => item.value).sort();
    expect(values).toEqual(["list", "pause", "resume", "select", "status"]);
    const selectish = (await charters.getArgumentCompletions!("se")) as Array<{ value: string }>;
    expect(selectish.map((c) => c.value)).toEqual(["select"]);
  });

  test("select <prefix> returns active charter ids plus literal 'none'", async () => {
    await withTempProject(async (projectDir) => {
      const idA = await seedActiveCharter(projectDir, { name: "alpha" });
      const pi = makeFakePi();
      registerCharterCommands(pi as never);
      const charters = pi.commands.get("charters")!;
      const original = process.cwd();
      try {
        process.chdir(projectDir);
        const items = (await charters.getArgumentCompletions!("select ")) as Array<{ value: string }>;
        const values = items.map((i) => i.value);
        expect(values).toContain(`select ${idA}`);
        expect(values).toContain("select none");
      } finally {
        process.chdir(original);
      }
    });
  });
});
