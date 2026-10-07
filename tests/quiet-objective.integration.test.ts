import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import utilsExtension from "../node_modules/pi-extension-utils/dist/index.js";
import charterExtension from "../src/index";
import * as registration from "../src/application/registration";
import { createCharter } from "../src/application/service";

const model: Model<string> = {
  id: "quiet-test", name: "Quiet test", api: "quiet-test", provider: "quiet-test",
  baseUrl: "http://localhost.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 256,
};

// Above the removed reminder's former 200-call threshold.
const TOOL_CALLS = 210;

test("no periodic Objective reminder is registered", () => {
  expect(registration).not.toHaveProperty("registerCharterObjectiveReminder");
});

test("the installed extension adds no Objective prompt during ordinary work", async () => {
  const project = await mkdtemp(join(tmpdir(), "pi-charter-quiet-"));
  const agentDir = join(project, "agent");
  const contexts: string[] = [];
  const factory: ExtensionFactory = (pi) => {
    charterExtension(pi);
    utilsExtension(pi);
    pi.registerTool({
      name: "probe", label: "Probe", description: "Record activity", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "Recorded" }], details: {} }; },
    });
    pi.registerProvider(model.provider, {
      api: model.api,
      streamSimple: (_model, context) => {
        contexts.push(JSON.stringify(context.messages));
        const working = contexts.length <= TOOL_CALLS;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: working ? [{ type: "toolCall", id: `probe-${contexts.length}`, name: "probe", arguments: {} }] : [{ type: "text", text: "Done." }],
          stopReason: working ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
        return stream;
      },
    });
  };
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey(model.provider, "test-key");
  const services = await createAgentSessionServices({
    cwd: project, agentDir, modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(project), model });
  try {
    await session.bindExtensions({});
    const created = await createCharter(project, { objective: "Preserve the entire authorized outcome.", sessionId: session.sessionId });
    await session.prompt("Work on the requested outcome.");
    expect(contexts).toHaveLength(TOOL_CALLS + 1);
    for (const context of contexts) {
      expect(context).not.toContain(created.charterId);
      expect(context).not.toContain("Preserve the entire authorized outcome.");
    }
    expect(session.messages.some((message) => message.role === "custom")).toBe(false);
  } finally {
    session.dispose();
    await rm(project, { recursive: true, force: true });
  }
}, 30000);
