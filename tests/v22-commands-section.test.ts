import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCharterStatus, createCharter } from "../src/application/service";
import { formatCharterStatusText } from "../src/application/registration";
import { renderSubagentBootstrapPrompt } from "../src/application/subagent-bootstrap";
import { parseCharterMarkdown } from "../src/domain/charter-md";

async function withTempProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-charter-v22-commands-"));
  try {
    return await fn(projectDir);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function charterMd(commandsSection = ""): string {
  return [
    "# Charter",
    "",
    "## Objective",
    "",
    "Exercise commands parsing.",
    "",
    "## Criteria",
    "",
    "### VAL-COMMANDS-SECTION Commands surface",
    "Description: Commands are available to status and delegated personas.",
    "Verifier: command",
    "Command: bun test tests/v22-commands-section.test.ts",
    "Fresh evidence required: false",
    "",
    commandsSection,
    "",
    "## Scope and constraints",
    "",
    "- Keep parsing tolerant.",
    "",
  ].join("\n");
}

describe("v2.2 Commands section", () => {
  test("Commands section parsed and surfaced", async () => {
    const parsed = parseCharterMarkdown(charterMd("## Commands\n\nbuild: bun run build\ntest: bun test\ncustom-smoke: bash scripts/smoke.sh"));
    expect(parsed.commands).toEqual({
      build: "bun run build",
      test: "bun test",
      "custom-smoke": "bash scripts/smoke.sh",
    });
    expect(parsed.warnings).toEqual([]);

    await withTempProject(async (projectDir) => {
      const charter = await createCharter(projectDir, { objective: "Exercise commands parsing" });
      const dir = join(projectDir, ".pi", "charters", charter.charterId);
      await writeFile(join(dir, "charter.md"), charterMd("## Commands\n\nbuild: bun run build\ntest: bun test"));

      const status = await getCharterStatus(projectDir, { charterId: charter.charterId });
      expect(status.commands).toEqual({ build: "bun run build", test: "bun test" });
      expect(formatCharterStatusText(status)).toContain("commands: build=bun run build; test=bun test");
    });
  });

  test("charter without Commands section parses cleanly", () => {
    const parsed = parseCharterMarkdown(charterMd());
    expect(parsed.commands).toEqual({});
    expect(parsed.warnings).toEqual([]);
  });

  test("duplicate keys: last-write-wins with warning", () => {
    const parsed = parseCharterMarkdown(charterMd("## Commands\n\ntest: bun test\ntest: bun test tests/v22-commands-section.test.ts"));
    expect(parsed.commands).toEqual({ test: "bun test tests/v22-commands-section.test.ts" });
    expect(parsed.warnings).toEqual([
      { reason: "duplicate-command", section: "commands", key: "test" },
    ]);
  });

  test("malformed Commands section: parser returns empty and emits warning", () => {
    const parsed = parseCharterMarkdown(charterMd("## Commands\n\nnot a command line\n: missing key\nempty:   "));
    expect(parsed.commands).toEqual({});
    expect(parsed.warnings).toEqual([
      { reason: "malformed-command", section: "commands", line: "not a command line" },
      { reason: "malformed-command", section: "commands", line: ": missing key" },
      { reason: "malformed-command", section: "commands", key: "empty" },
    ]);
  });

  test("subagent bootstrap includes commands in prompt", () => {
    const prompt = renderSubagentBootstrapPrompt({
      charterId: "cha-commands",
      featureId: "f2-commands-section",
      commands: { test: "bun test", lint: "bun run check-types" },
    });
    expect(prompt).toContain("charterId: cha-commands");
    expect(prompt).toContain("featureId: f2-commands-section");
    expect(prompt).toContain("Commands");
    expect(prompt).toContain("test: bun test");
    expect(prompt).toContain("lint: bun run check-types");
  });
});
