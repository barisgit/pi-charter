import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const recipeDir = join(process.cwd(), "skills", "pi-charter", "references", "qa");
const recipeIndexPath = join(process.cwd(), "skills", "pi-charter", "references", "qa.md");

const stubRecipes = [
  "browser.md",
  "desktop.md",
  "mobile.md",
  "http-api.md",
  "database.md",
  "logs-and-processes.md",
  "generated-files.md",
  "visual-regression.md",
  "reproducibility.md",
];

const requiredSections = [
  "## What this is for",
  "## Recommended stack",
  "## Detection",
  "## Graceful degradation",
  "## Platform-specific notes",
  "## Anti-patterns",
  "## Out-of-scope",
  "## When to abandon",
  "## Smoke command",
];

async function readRecipe(recipe: string): Promise<string> {
  return await readFile(join(recipeDir, recipe), "utf8");
}

describe("QA recipe stubs", () => {
  test("all 9 recipe stubs exist", () => {
    for (const recipe of stubRecipes) {
      expect(existsSync(join(recipeDir, recipe))).toBe(true);
    }
  });

  test("each stub has all template sections", async () => {
    for (const recipe of stubRecipes) {
      const contents = await readRecipe(recipe);
      for (const section of requiredSections) {
        expect(contents).toContain(section);
      }
    }
  });

  test("each stub has unverified status banner", async () => {
    for (const recipe of stubRecipes) {
      const contents = await readRecipe(recipe);
      expect(contents).toContain("status=stub-unverified");
      expect(contents).toContain("NOT YET VERIFIED");
    }
  });

  test("index recipe status table lists every shipped recipe", async () => {
    const contents = await readFile(recipeIndexPath, "utf8");
    const expectedRows = [
      "| qa/terminal.md | verified | macOS arm64 | 2026-05-21 |",
      ...stubRecipes.map((recipe) => `| qa/${recipe} | stub | n/a | n/a |`),
    ];

    for (const row of expectedRows) {
      expect(contents).toContain(row);
    }
  });
});
