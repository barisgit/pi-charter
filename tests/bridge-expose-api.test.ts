import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetSubagentApiForTests,
  getSubagentApi,
  registerCharterSubagentBridge,
} from "../src/application/registration";
import {
  SUBAGENT_EXPOSE_API_EVENT,
  type SubagentExposedAPI,
} from "../src/infrastructure/subagent-bridge";

type Listener = (data: unknown) => void;

function makeFakePi() {
  const listeners = new Map<string, Listener[]>();
  return {
    events: {
      emit(channel: string, data: unknown) {
        for (const l of listeners.get(channel) ?? []) l(data);
      },
      on(channel: string, handler: Listener) {
        const list = listeners.get(channel) ?? [];
        list.push(handler);
        listeners.set(channel, list);
        return () => {
          const current = listeners.get(channel) ?? [];
          listeners.set(channel, current.filter((l) => l !== handler));
        };
      },
    },
    on() {
      /* not used by surface 2 */
    },
  };
}

afterEach(() => {
  __resetSubagentApiForTests();
});

describe("bridge surface 2: capture SUBAGENT_EXPOSE_API_EVENT", () => {
  test("captures the SubagentExposedAPI bag when pi-subagents emits", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterSubagentBridge(pi as any);

    expect(getSubagentApi()).toBeUndefined();

    const fakeApi: SubagentExposedAPI = {
      async spawnRaw() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      list() {
        return [{ name: "charter-reviewer", description: "stub" }];
      },
    };
    pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, fakeApi);

    const captured = getSubagentApi();
    expect(captured).toBeDefined();
    expect(captured).toBe(fakeApi);
  });

  test("ignores malformed payloads (missing spawnRaw)", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterSubagentBridge(pi as any);

    pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, undefined);
    pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, {});
    pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, { list: () => [] });

    expect(getSubagentApi()).toBeUndefined();
  });

  test("getSubagentApi returns undefined when pi-subagents never emits", () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterSubagentBridge(pi as any);
    expect(getSubagentApi()).toBeUndefined();
  });

  test("captured handle is usable by callers (spawnRaw invocable)", async () => {
    const pi = makeFakePi();
    // biome-ignore lint/suspicious/noExplicitAny: fake pi
    registerCharterSubagentBridge(pi as any);

    let spawned = 0;
    const fakeApi: SubagentExposedAPI = {
      async spawnRaw(input) {
        spawned += 1;
        return { content: [{ type: "text", text: `echo:${input.prompt}` }] };
      },
      list() {
        return [];
      },
    };
    pi.events.emit(SUBAGENT_EXPOSE_API_EVENT, fakeApi);

    const api = getSubagentApi();
    expect(api).toBeDefined();
    const result = await api!.spawnRaw({ systemPrompt: "s", prompt: "hello" });
    expect(spawned).toBe(1);
    expect(result.content[0]!.text).toBe("echo:hello");
  });
});
