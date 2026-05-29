import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const recipeIndexPath = join(process.cwd(), "skills", "pi-charter", "references", "qa.md");
const skillPath = join(process.cwd(), "skills", "pi-charter", "SKILL.md");

async function readRecipeIndex(): Promise<string> {
  return await readFile(recipeIndexPath, "utf8");
}

async function readSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}

describe("QA recipe index", () => {
  test("recipe index file exists at references/qa.md", () => {
    expect(existsSync(recipeIndexPath)).toBe(true);
  });

  test("recipe index decision tree covers all ten surfaces", async () => {
    const contents = await readRecipeIndex();
    const mappings = [
      "Terminal session, CLI tool, TUI, agent driving a shell -> qa/terminal.md",
      "Browser, web app, web TUI in headless browser -> qa/browser.md",
      "Native desktop app, OS UI, system dialog -> qa/desktop.md",
      "Mobile app, mobile web, simulator -> qa/mobile.md",
      "HTTP/REST/GraphQL API -> qa/http-api.md",
      "WebSocket / SSE / real-time -> qa/http-api.md#websocket-sse",
      "Database state, schema, query plans -> qa/database.md",
      "Server logs, processes, system metrics -> qa/logs-and-processes.md",
      "File changes, generated code, build outputs -> qa/generated-files.md",
      "Visual regression (before/after pixel diff) -> qa/visual-regression.md",
      "Reproducing the run (env, scripts) -> qa/reproducibility.md",
    ];

    expect(contents).toContain("## What surface are you capturing?");
    for (const mapping of mappings) {
      expect(contents).toContain(mapping);
    }
  });

  test("recipe status table marks terminal as verified", async () => {
    const contents = await readRecipeIndex();

    expect(contents).toContain("| recipe | status | platform | date |");
    expect(contents).toContain("| qa/terminal.md | verified | macOS arm64 | 2026-05-21 |");
  });

  test("recipe status table marks all non-terminal recipes as stub", async () => {
    const contents = await readRecipeIndex();
    const stubRecipes = [
      "qa/browser.md",
      "qa/desktop.md",
      "qa/mobile.md",
      "qa/http-api.md",
      "qa/database.md",
      "qa/logs-and-processes.md",
      "qa/generated-files.md",
      "qa/visual-regression.md",
      "qa/reproducibility.md",
    ];

    for (const recipe of stubRecipes) {
      expect(contents).toContain(`| ${recipe} | stub | n/a | n/a |`);
    }
  });

  test("SKILL.md points at references/qa.md", async () => {
    const contents = await readSkill();

    expect(contents).toContain("references/qa.md");
  });
});
