import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(testDir, "..");
const promptPath = join(projectDir, "agents", "charter-planner-critic.md");

function promptText(): string {
  return readFileSync(promptPath, "utf8");
}

describe("v2.2 critic mandates", () => {
  test("critic v22 mandates landed", () => {
    const text = promptText();

    expect(text).toContain("v2.2 mandates");
    expect(text).toContain("Requirement echo-back");
    expect(text).toContain("QA coverage for user-surface milestones");
    expect(text).toContain("Pass criteria + failure modes per VAL");
    expect(text).toContain("Cross-cutting VAL count");
    expect(text).toContain("Verifier robustness preserved from v2.1");
    expect(text).toContain("Online research delegation audit");
  });

  test("critic requirement-echo-back rule present", () => {
    const text = promptText();

    expect(text).toContain("every named technology, dependency, SDK, platform, external");
    expect(text).toContain("`## References` in charter.md or a per-feature `touches[]` entry");
    expect(text).not.toContain("`touches[]` entry / plan\n   body reference");
    expect(text).toContain("BLOCK requirement-not-echoed");
    expect(text).toContain("Does NOT apply when the Objective contains no named technologies");
  });

  test("critic qa-coverage-missing verdict shape present", () => {
    const text = promptText();

    expect(text).toContain("User-surface path");
    expect(text).toContain("`agents/`, `skills/`, `ui/`, `docs/showcase`");
    expect(text).toContain("BLOCK qa-coverage-missing");
    expect(text).toContain("only when neither direct\n   milestone credit nor transitive BFS precondition credit exists");
    expect(text).toContain("Does NOT apply when the milestone has no feature touching");
  });

  test("critic qa-coverage credits transitive preconditions", () => {
    const text = promptText();

    expect(text).toContain("Transitive-credit clause");
    expect(text).toContain("run a BFS");
    expect(text).toContain("`preconditions[]`");
    expect(text).toContain("collect every transitively reached feature and its");
    expect(text).toContain("This lets a late\n   smoke-test milestone cover earlier user-surface implementation milestones");
  });

  test("critic val-underspecified rule present", () => {
    const text = promptText();

    expect(text).toContain("every `VAL-*` criterion description in charter.md must include");
    expect(text).toContain("`Pass criteria:` line");
    expect(text).toContain("`Failure modes:` line");
    expect(text).toContain("BLOCK val-underspecified");
  });

  test("critic cross-cutting-thin rule present", () => {
    const text = promptText();

    expect(text).toContain("more than 5 implementation features must define");
    expect(text).toContain("at least 2 cross-cutting VALs");
    expect(text).toContain("VAL-*` id -> set of milestone ids");
    expect(text).toContain("BLOCK cross-cutting-thin");
  });

  test("critic verifier-robustness rule preserved with grandfather clause", () => {
    const text = promptText();

    expect(text).toContain("Verifier robustness preserved from v2.1");
    expect(text).toContain("bare `bun test -t '<phrase>'` verifiers in v2.2+ plans must");
    expect(text).toContain("BLOCK verifier-not-robust");
    expect(text).toContain("Grandfather clause");
    expect(text).toContain("schemaVersion < 2.2");
    expect(text).toContain("ADVISORY verifier-not-robust");
  });

  test("critic research-misfiled rule present", () => {
    const text = promptText();

    expect(text).toContain("Distilled reusable knowledge belongs in `library/<topic>.md`");
    expect(text).toContain("raw\n   research dumps, copied web pages, transcripts, or unprocessed notes belong in\n   `library/research/<topic>.md`");
    expect(text).toContain("Raw research in the `library/` root is");
    expect(text).toContain("Convex, Drizzle, or Hono indicators");
    expect(text).toContain("BLOCK research-misfiled");
  });
});
