import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readShowcase(): Promise<string> {
  return readFile(join(import.meta.dir, "..", "docs", "showcase.html"), "utf8");
}

describe("showcase documentation", () => {
  test("showcase documents current evidence and verifier behavior", async () => {
    const text = await readShowcase();

    expect(text).toContain("work/&lt;featureId&gt;/evidence/&lt;ts&gt;/evidence.json");
    expect(text).toContain("auto-injection was removed in v2.2");
    expect(text).toContain("subagent");
    expect(text).toContain("Charter stores the recorded command output; it does not execute the command.");
    expect(text).toContain("## Commands");
  });

  test("showcase mentions dir-per-run evidence layout", async () => {
    const text = await readShowcase();

    expect(text).toContain("v2.1 dir-per-run layout");
    expect(text).toContain("work/&lt;featureId&gt;/evidence/&lt;ts&gt;/evidence.json");
    expect(text).toContain("evidence.json");
  });

  test("showcase shows descriptive evidence categories", async () => {
    const text = await readShowcase();

    for (const heading of ["Command", "Hook / service", "Manual / review"]) {
      expect(text).toContain(`<h3>${heading}</h3>`);
    }
    expect(text).toContain("Annotations describe what good evidence looks like; recorded evidence decides completion.");
  });

  test("showcase includes Commands section example", async () => {
    const text = await readShowcase();

    expect(text).toContain("<h2>## Commands</h2>");
    expect(text).toContain("build: bun run build");
    expect(text).toContain("test:  bun test");
    expect(text).toContain("dev:   bun run dev");
    expect(text).toContain("Worked example");
  });

  test("showcase does NOT reference auto-injection outside historical note", async () => {
    const text = await readShowcase();
    const historicalNote = /<p class="sub"><strong>Historical note:<\/strong> auto-injection was removed in v2\.2[\s\S]*?<\/p>\n?/;

    expect(text).toMatch(historicalNote);
    expect(text.replace(historicalNote, "")).not.toMatch(/auto-inject(?:ion|ed)?/i);
  });
});
