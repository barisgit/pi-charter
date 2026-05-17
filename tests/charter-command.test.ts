/**
 * VAL-7 verifier: `/charter` is reduced to objective-only behavior.
 *
 * - Bare (or whitespace-only) args -> ctx.ui.notify with the literal "Usage:".
 * - Any non-empty args (including the former reserved verbs `status`,
 *   `pause`, `resume`) are passed to the agent via pi.sendUserMessage.
 * - skills/pi-charter/SKILL.md no longer mentions `/charter status`,
 *   `/charter pause`, `/charter resume`, or the bare-status block phrase.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCharterCommands } from "../src/application/registration";

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
  };
  sessionManager: {
    getSessionId: () => string | undefined;
  };
}

interface FakePi {
  commands: Map<string, RegisteredCommand>;
  registerCommand: (name: string, opts: RegisteredCommand) => void;
  sendUserMessage: (text: string) => void;
  sentUserMessages: string[];
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
  };
}

function makeCtx(): { ctx: FakeCommandCtx; notifications: Array<{ message: string; level?: string }> } {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    notifications,
    ctx: {
      cwd: "/tmp/does-not-exist-charter-command",
      hasUI: false,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      sessionManager: { getSessionId: () => "session-x" },
    },
  };
}

describe("VAL-7: /charter command", () => {
  test("bare invocation notifies a Usage: hint and does NOT call sendUserMessage", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter");
    expect(charter).toBeDefined();
    const { ctx, notifications } = makeCtx();
    await charter!.handler("", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("Usage:");
    expect(pi.sentUserMessages).toHaveLength(0);
  });

  test("whitespace-only args notify Usage: (not treated as objective)", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;
    const { ctx, notifications } = makeCtx();
    await charter.handler("   \t  ", ctx);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.message).toContain("Usage:");
    expect(pi.sentUserMessages).toHaveLength(0);
  });

  test("/charter status -> sendUserMessage IS called (no reserved verbs)", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;
    const { ctx, notifications } = makeCtx();
    await charter.handler("status", ctx);
    // No notify path; agent receives the objective payload.
    expect(notifications).toHaveLength(0);
    expect(pi.sentUserMessages).toHaveLength(1);
    expect(pi.sentUserMessages[0]).toContain("status");
    expect(pi.sentUserMessages[0]).toContain("pi-charter objective");
  });

  test("/charter <objective> -> sendUserMessage called with the objective text", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;
    const { ctx } = makeCtx();
    await charter.handler("Ship a new feature flag pipeline", ctx);
    expect(pi.sentUserMessages).toHaveLength(1);
    expect(pi.sentUserMessages[0]).toContain("Ship a new feature flag pipeline");
  });
});

describe("VAL-7: SKILL.md doc surface", () => {
  test("SKILL.md does NOT contain removed /charter verb references", async () => {
    const here = fileURLToPath(import.meta.url);
    const skillPath = resolve(join(here, "..", "..", "skills", "pi-charter", "SKILL.md"));
    const md = await readFile(skillPath, "utf8");
    expect(md).not.toContain("/charter status");
    expect(md).not.toContain("/charter pause");
    expect(md).not.toContain("/charter resume");
    expect(md).not.toContain("prints the current charter status block");
  });
});
