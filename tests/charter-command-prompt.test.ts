/**
 * /charter slash-command prompt verifier:
 *   VAL-CMD-001 — /charter <objective> sends a sendUserMessage payload
 *                  containing the new recon/clarify/kebab-case steps and
 *                  the SKILL.md §2a pointer.
 *   VAL-CMD-002 — bare /charter notifies a hint mentioning that pi-charter
 *                  will read referenced material.
 *   VAL-CMD-003 — the captured payload does NOT contain the old literal
 *                  `1. Call charter action=create`.
 */

import { describe, expect, test } from "bun:test";
import { registerCharterCommands } from "../src/application/registration";

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: FakeCommandCtx) => Promise<void> | void;
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
      cwd: "/tmp",
      hasUI: false,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      sessionManager: { getSessionId: () => undefined },
    },
  };
}

describe("/charter slash-command prompt", () => {
  test("handler payload carries recon/clarify/kebab-case instructions", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter");
    expect(charter).toBeDefined();

    const { ctx } = makeCtx();
    await charter!.handler("describe an objective", ctx);

    expect(pi.sentUserMessages).toHaveLength(1);
    const message = pi.sentUserMessages[0]!;
    expect(message).toContain("Before calling");
    expect(message).toContain("SKILL.md");
    expect(message).toContain("2a");
    expect(message).toContain("EXACTLY ONE clarifying question");
    expect(message).toContain("kebab-case");
    expect(message).toContain("Extract the real objective");
  });

  test("bare invocation notifies a hint about reading referenced material", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;

    const { ctx, notifications } = makeCtx();
    await charter.handler("", ctx);

    expect(pi.sentUserMessages).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    const hint = notifications[0]!.message;
    expect(hint).toContain("read");
    expect(hint).toContain("reference");
  });

  test("whitespace-only invocation notifies a hint about reading referenced material", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;

    const { ctx, notifications } = makeCtx();
    await charter.handler("   \t  ", ctx);

    expect(pi.sentUserMessages).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    const hint = notifications[0]!.message;
    expect(hint).toContain("read");
    expect(hint).toContain("reference");
  });

  test("payload does NOT contain the old '1. Call charter action=create' literal", async () => {
    const pi = makeFakePi();
    registerCharterCommands(pi as never);
    const charter = pi.commands.get("charter")!;

    const { ctx } = makeCtx();
    await charter.handler("describe an objective", ctx);

    expect(pi.sentUserMessages).toHaveLength(1);
    const message = pi.sentUserMessages[0]!;
    expect(message).not.toContain("1. Call charter action=create");
  });
});
