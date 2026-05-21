import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const skillPath = join(process.cwd(), "skills", "pi-charter", "SKILL.md");

async function readSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}

function section(contents: string, heading: string): string {
  const start = contents.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = contents.indexOf("\n## ", start + heading.length);
  return next === -1 ? contents.slice(start) : contents.slice(start, next);
}

describe("v2.2 SKILL planning rewrite", () => {
  test("SKILL planning section landed", async () => {
    const contents = await readSkill();
    const planning = section(contents, "## Planning is the work");

    expect(planning).toContain("Planning is the work");
    expect(planning).toContain("feature works");
    expect(planning).toContain("VAL count matching feature count");
    expect(planning).toContain("Skipping `charter-planner-critic`");
    expect(planning).toContain("awaiting-clarification");
    expect(planning).toContain("Treating a critic `BLOCK` as advisory");
    expect(planning).toContain("### Done planning");
    expect(planning).toContain("nextActions[]");
    expect(planning).toContain("except `lock_plan`");
    expect(planning).toContain("charter_plan action=lock_plan");
    expect(planning).toContain("succeeds");
  });

  test("SKILL planning section avoids time percentages", async () => {
    const contents = await readSkill();
    const planning = section(contents, "## Planning is the work");
    const percentPattern = new RegExp(String.raw`\d` + "+%", "g");

    expect(planning.match(percentPattern) ?? []).toEqual([]);
  });

  test("research delegation rule landed", async () => {
    const contents = await readSkill();
    const research = section(contents, "## Online research delegation");

    expect(research).toContain("Delegate online research");
    expect(research).toContain("current ecosystem");
    expect(research).toContain("Can this API do X?");
    expect(research).toContain("Find current docs");
    expect(research).toContain("Do not spend research budget");
    expect(research).toContain("raw research");
  });

  test("SKILL references four-question gate", async () => {
    const contents = await readSkill();
    const planning = section(contents, "## Planning is the work");

    expect(planning).toContain("four-question gate");
    expect(planning).toContain("`charter-planner-critic`");
    expect(planning).toContain("What does it do?");
    expect(planning).toContain("What are its boundaries?");
    expect(planning).toContain("Where does complexity concentrate?");
    expect(planning).toContain("How would an independent party");
  });

  test("SKILL research delegation has both indicator categories", async () => {
    const contents = await readSkill();
    const research = section(contents, "## Online research delegation");

    expect(research).toContain("smaller or newer ecosystems");
    expect(research).toContain("Convex");
    expect(research).toContain("Drizzle");
    expect(research).toContain("Hono");
    expect(research).toContain("SDK-heavy integrations");
    expect(research).toContain("Vercel AI SDK");
    expect(research).toContain("Stripe Elements");
    expect(research).toContain("Supabase Auth");
    expect(research).toContain("foundational, slowly evolving knowledge");
    expect(research).toContain("React");
    expect(research).toContain("PostgreSQL");
    expect(research).toContain("Express");
  });

  test("SKILL research delegation distinguishes library and library research dirs", async () => {
    const contents = await readSkill();
    const research = section(contents, "## Online research delegation");

    expect(research).toContain("library/<topic>.md");
    expect(research).toContain("library/research/<topic>.md");
    expect(research).toContain("distilled, reusable findings");
    expect(research).toContain("raw research notes");
  });
});
