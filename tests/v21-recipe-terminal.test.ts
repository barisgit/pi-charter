import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const recipePath = join(process.cwd(), "skills", "pi-charter", "references", "qa", "terminal.md");
const recipeIndexPath = join(process.cwd(), "skills", "pi-charter", "references", "qa.md");
const fixtureDir = join(process.cwd(), "tests", "fixtures", "v21-terminal-recipe");
const castPath = join(fixtureDir, "terminal.cast");
const gifPath = join(fixtureDir, "terminal.gif");

async function readRecipe(): Promise<string> {
  return await readFile(recipePath, "utf8");
}

function section(contents: string, heading: string): string {
  const start = contents.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);

  const rest = contents.slice(start + heading.length);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function expectRequiredSections(contents: string) {
  const requiredSections = [
    "## What this is for",
    "## Recommended stack — verified",
    "## Detection",
    "## Graceful degradation",
    "## Platform notes",
    "## Anti-patterns",
    "## Out-of-scope",
    "## When to abandon",
    "## Smoke command",
  ];

  for (const heading of requiredSections) {
    expect(contents).toContain(heading);
  }
}

async function expectValidAsciicast() {
  expect(existsSync(castPath)).toBe(true);

  const contents = await readFile(castPath, "utf8");
  const lines = contents.trim().split("\n");
  const header = JSON.parse(lines[0]);
  const event = JSON.parse(lines[1]);

  expect(header.version).toBe(3);
  expect(header.term.cols).toBeGreaterThan(0);
  expect(header.term.rows).toBeGreaterThan(0);
  expect(header.command).toBe("pi --no-session");
  expect(Array.isArray(event)).toBe(true);
  expect(event[1]).toBe("o");
}

async function expectValidGif() {
  expect(existsSync(gifPath)).toBe(true);

  const info = await stat(gifPath);
  const handle = Bun.file(gifPath);
  const header = await handle.slice(0, 6).text();

  expect(info.size).toBeGreaterThan(0);
  expect(["GIF87a", "GIF89a"]).toContain(header);
}

describe("v2.1 terminal recipe", () => {
  test("terminal recipe file exists with all required sections", async () => {
    expect(existsSync(recipePath)).toBe(true);
    expectRequiredSections(await readRecipe());
  });

  test("terminal.cast fixture exists and is valid asciicast", async () => {
    await expectValidAsciicast();
  });

  test("terminal.gif fixture exists and is valid GIF", async () => {
    await expectValidGif();
  });

  test("recipe lists tmux asciinema agg ffmpeg in Recommended stack", async () => {
    const contents = await readRecipe();
    const recommended = section(contents, "## Recommended stack — verified");

    for (const tool of ["tmux", "asciinema", "agg", "ffmpeg"]) {
      expect(recommended).toContain(tool);
    }
  });

  test("recipe documents two-layer Ctrl-D exit dance", async () => {
    const contents = await readRecipe();

    expect(contents).toContain("two-layer Ctrl-D exit dance");
    expect(contents).toContain("/exit");
    expect(contents).toContain("C-d");
  });

  test("terminal.md has all template sections", async () => {
    expectRequiredSections(await readRecipe());
  });

  test("fixture terminal.cast parses", async () => {
    await expectValidAsciicast();
  });

  test("fixture terminal.gif present and non-empty", async () => {
    await expectValidGif();
  });

  test("anti-patterns mentions asciinema cat broken in 3.x", async () => {
    const contents = await readRecipe();
    const antiPatterns = section(contents, "## Anti-patterns");

    expect(antiPatterns).toContain("asciinema cat");
    expect(antiPatterns).toContain("broken in 3.x");
  });

  test("index status table marks terminal as verified", async () => {
    const contents = await readFile(recipeIndexPath, "utf8");

    expect(contents).toContain("| qa/terminal.md | verified | macOS arm64 | 2026-05-21 |");
  });

  test("terminal.md documents agg command for cast-to-gif regeneration", async () => {
    const contents = await readRecipe();

    expect(contents).toContain("agg --theme monokai terminal.cast terminal.gif");
  });
});
