import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { registerCharterPersonas } from "../src/application/registration";
import {
  PI_CHARTER_EXTENSION_ID,
  SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT,
  SUBAGENT_REGISTER_PERSONA_DIR_EVENT,
  SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT,
  type PersonaDirErrorPayload,
  type RegisterPersonaDirPayload,
  type UnregisterPersonaDirPayload,
} from "../src/infrastructure/subagent-bridge";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakePi {
  events: {
    emit: (channel: string, data: unknown) => void;
    on: (channel: string, handler: (data: unknown) => void) => () => void;
  };
  on: (event: string, handler: Handler) => void;
  // tracking
  _emitted: Array<{ channel: string; data: unknown }>;
  _eventListeners: Map<string, Array<(data: unknown) => void>>;
  _piListeners: Map<string, Handler[]>;
}

function makeFakePi(): FakePi {
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const eventListeners = new Map<string, Array<(data: unknown) => void>>();
  const piListeners = new Map<string, Handler[]>();
  return {
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
        const listeners = eventListeners.get(channel) ?? [];
        for (const l of listeners) l(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const list = eventListeners.get(channel) ?? [];
        list.push(handler);
        eventListeners.set(channel, list);
        return () => {
          const current = eventListeners.get(channel) ?? [];
          eventListeners.set(channel, current.filter((l) => l !== handler));
        };
      },
    },
    on(event: string, handler: Handler) {
      const list = piListeners.get(event) ?? [];
      list.push(handler);
      piListeners.set(event, list);
    },
    _emitted: emitted,
    _eventListeners: eventListeners,
    _piListeners: piListeners,
  };
}

describe("bridge surface 1: register persona dir", () => {
  test("emits SUBAGENT_REGISTER_PERSONA_DIR_EVENT with pi-charter agents path at startup", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterPersonas(pi as any);

    const registerCalls = pi._emitted.filter((e) => e.channel === SUBAGENT_REGISTER_PERSONA_DIR_EVENT);
    expect(registerCalls).toHaveLength(1);

    const payload = registerCalls[0]!.data as RegisterPersonaDirPayload;
    expect(payload.extensionId).toBe(PI_CHARTER_EXTENSION_ID);
    expect(payload.scope).toBe("internal");
    expect(payload.path).toMatch(/agents$/);

    // The resolved path must point at the real on-disk personas dir, with the
    // bundled v2 persona files present.
    expect(existsSync(payload.path)).toBe(true);
    expect(statSync(payload.path).isDirectory()).toBe(true);
    for (const file of [
      "charter-planner-critic.md",
      "charter-reviewer.md",
      "charter-qa.md",
      "charter-readiness-probe.md",
    ]) {
      expect(existsSync(resolvePath(payload.path, file))).toBe(true);
    }
  });

  test("re-emits register event on session_start", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterPersonas(pi as any);

    pi._emitted.length = 0; // reset after startup emit

    const sessionStartHandlers = pi._piListeners.get("session_start") ?? [];
    expect(sessionStartHandlers.length).toBeGreaterThan(0);
    for (const h of sessionStartHandlers) h({}, {});

    const registerCalls = pi._emitted.filter((e) => e.channel === SUBAGENT_REGISTER_PERSONA_DIR_EVENT);
    expect(registerCalls).toHaveLength(1);
    const payload = registerCalls[0]!.data as RegisterPersonaDirPayload;
    expect(payload.extensionId).toBe(PI_CHARTER_EXTENSION_ID);
  });

  test("emits SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT on session_shutdown", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterPersonas(pi as any);

    pi._emitted.length = 0;

    const shutdownHandlers = pi._piListeners.get("session_shutdown") ?? [];
    expect(shutdownHandlers.length).toBeGreaterThan(0);
    for (const h of shutdownHandlers) h({}, {});

    const unregisterCalls = pi._emitted.filter((e) => e.channel === SUBAGENT_UNREGISTER_PERSONA_DIR_EVENT);
    expect(unregisterCalls).toHaveLength(1);
    const payload = unregisterCalls[0]!.data as UnregisterPersonaDirPayload;
    expect(payload.extensionId).toBe(PI_CHARTER_EXTENSION_ID);
  });

  test("subscribes to register-persona-dir-error and ignores foreign-extension errors", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterPersonas(pi as any);

    const errorHandlers = pi._eventListeners.get(SUBAGENT_REGISTER_PERSONA_DIR_ERROR_EVENT) ?? [];
    expect(errorHandlers.length).toBeGreaterThan(0);

    // Foreign extension's error should not throw or surface anything.
    const foreignError: PersonaDirErrorPayload = {
      extensionId: "some-other-extension",
      conflictingExtensionId: "pi-charter",
      personaName: "verifier",
      message: "conflict",
    };
    expect(() => {
      for (const h of errorHandlers) h(foreignError);
    }).not.toThrow();
  });
});
