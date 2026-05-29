import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function parseSkillName(contents: string): string | undefined {
  const segments = contents.split("---");
  if (segments.length < 3) return undefined;
  const frontmatter = segments[1];
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^name:\s*(.+?)\s*$/);
    if (match) return match[1].replace(/^["']|["']$/g, "");
  }
  return undefined;
}

async function discoverSkills(roots: string[]): Promise<Array<{ name: string; file: string }>> {
  const records: Array<{ name: string; file: string }> = [];
  for (const root of roots) {
    const absoluteRoot = resolve(packageRoot, root);
    const files = await walk(absoluteRoot);
    for (const file of files) {
      if (!file.endsWith("/SKILL.md")) continue;
      const contents = await readFile(file, "utf8");
      const name = parseSkillName(contents);
      if (name) records.push({ name, file });
    }
  }
  return records;
}

describe("skill registration", () => {
  test("package.json declares pi.skills with ./skills", () => {
    expect(pkg.pi.skills).toBeArray();
    expect(pkg.pi.skills).toContain("./skills");
  });

  test("discovery walker finds pi-charter SKILL.md", async () => {
    const records = await discoverSkills(pkg.pi.skills);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("pi-charter");
    expect(records[0].file.endsWith("skills/pi-charter/SKILL.md")).toBe(true);
  });
});
