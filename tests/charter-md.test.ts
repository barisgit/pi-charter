import { describe, expect, test } from "bun:test";
import { parseCharterMarkdown, isPhraseCoupledTestCommand } from "../src/domain/charter-md";

describe("parseCriteriaMarkdown milestones", () => {
  test("groups criterion headings under milestone headings", () => {
    const md = [
      "# Criteria",
      "",
      "## m2-decomp Decomposition",
      "",
      "### VAL-DECOMP-001 — First",
      "Verifier: command",
      "Command: true",
      "",
      "## m1-foundation Foundation",
      "",
      "### VAL-FOUND-001 — Base",
      "Verifier: manual",
      "Because: rationale",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown("# Charter\n\n## Objective\n\nProbe.\n", { criteriaMarkdown: md });
    expect(parsed.milestones.map((milestone) => milestone.id)).toEqual(["m2-decomp", "m1-foundation"]);
    expect(parsed.milestones[0]?.criterionIds).toEqual(["VAL-DECOMP-001"]);
    expect(parsed.criteria.map((criterion) => criterion.id)).toEqual(["VAL-DECOMP-001", "VAL-FOUND-001"]);
  });
});

describe("parseCharterMarkdown warnings", () => {
  test("legacy criterion missing Verifier: line parses without throwing and emits a missing-verifier warning", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "Legacy objective.",
      "",
      "## Criteria",
      "",
      "### VAL-LEGACY-001 — Old criterion with no verifier line",
      "Description: This criterion predates the Verifier requirement.",
      "Fresh evidence required: false",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0].id).toBe("VAL-LEGACY-001");
    expect(parsed.warnings).toEqual([
      { criterionId: "VAL-LEGACY-001", reason: "missing-verifier" },
    ]);
  });

  test("manual criterion without Because: emits a missing-because warning", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "weak.",
      "",
      "## Criteria",
      "",
      "### VAL-W-001 — Weak manual",
      "Verifier: manual",
      "",
      "### VAL-W-002 — Strong manual",
      "Verifier: manual",
      "Because: author note",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.criteria[1].because).toBe("author note");
    expect(parsed.warnings).toEqual([
      { criterionId: "VAL-W-001", reason: "missing-because" },
    ]);
  });

  test("old-style criteria parse without throwing; warnings include missing-verifier", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "legacy.",
      "",
      "## Criteria",
      "",
      "### VAL-LEG-001 — Legacy 1",
      "Description: old style",
      "",
      "### VAL-LEG-002 — Legacy 2",
      "Description: also old style",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);
    expect(parsed.criteria).toHaveLength(2);
    const reasons = parsed.warnings.map((w) => `${w.criterionId}:${w.reason}`).sort();
    expect(reasons).toEqual([
      "VAL-LEG-001:missing-verifier",
      "VAL-LEG-002:missing-verifier",
    ]);
  });

  test("modern criteria with explicit Verifier: emit zero warnings", () => {
    const md = [
      "# Charter",
      "",
      "## Objective",
      "",
      "Modern objective.",
      "",
      "## Criteria",
      "",
      "### VAL-MOD-001 — Modern criterion",
      "Description: Modern criterion has a verifier.",
      "Verifier: command",
      "Command: echo hi",
      "",
      "### VAL-MOD-002 — Another modern criterion",
      "Description: Also has a verifier.",
      "Verifier: manual",
      "Because: author note",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown(md);

    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("parseCharterMarkdown resilient verifiers", () => {
  // Regression: a present-but-incomplete verifier used to THROW out of
  // parseVerifier. Because every loadParsedCharter caller swallows parse
  // errors into empty defaults, one bad criterion silently zeroed the whole
  // register (charter_status showed 0/0 VALs). The parser must instead keep
  // every criterion, degrade the bad one to manual, and warn.
  test("one invalid subagent verifier does not zero the register", () => {
    const md = [
      "# Criteria",
      "",
      "## m1 Milestone",
      "",
      "### VAL-GOOD-001 — Valid command criterion",
      "Verifier: command",
      "Command: true",
      "",
      "### VAL-BAD-001 — Subagent verifier missing Agent/Task",
      "A behavioral statement.",
      "Verifier: subagent",
      "RequireReviewSubagent: true",
      "",
      "### VAL-GOOD-002 — Another valid criterion",
      "Verifier: manual",
      "Because: rationale",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown("# Charter\n\n## Objective\n\nProbe.\n", { criteriaMarkdown: md });

    // All three survive; the bad one is not dropped.
    expect(parsed.criteria.map((c) => c.id)).toEqual([
      "VAL-GOOD-001",
      "VAL-BAD-001",
      "VAL-GOOD-002",
    ]);
    // Bad criterion degraded to manual but keeps its independent flags.
    const bad = parsed.criteria.find((c) => c.id === "VAL-BAD-001");
    expect(bad?.verifier).toBe("manual");
    expect(bad?.requireReviewSubagent).toBe(true);
    // Exactly one invalid-verifier warning, naming the offending criterion.
    const invalid = parsed.warnings.filter((w) => w.reason === "invalid-verifier");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.criterionId).toBe("VAL-BAD-001");
    expect(invalid[0]?.detail).toBeDefined();
  });

  test("an unknown verifier kind degrades to manual with a warning", () => {
    const md = [
      "# Criteria",
      "",
      "## m1 Milestone",
      "",
      "### VAL-TYPO-001 — Misspelled verifier kind",
      "Verifier: commnad",
      "Command: true",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown("# Charter\n\n## Objective\n\nProbe.\n", { criteriaMarkdown: md });

    expect(parsed.criteria.map((c) => c.id)).toEqual(["VAL-TYPO-001"]);
    expect(parsed.criteria[0]?.verifier).toBe("manual");
    const invalid = parsed.warnings.filter((w) => w.reason === "invalid-verifier");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.criterionId).toBe("VAL-TYPO-001");
  });
});

describe("parseCharterMarkdown weak-verifier-phrase-coupled", () => {
  test("flags a command verifier that filters by test title with no file/glob", () => {
    const md = [
      "# Criteria",
      "",
      "## VAL-PHRASE-001 Phrase-coupled command",
      "Group node behavior.",
      "Verifier: command",
      "Command: bun test -t 'group node has no agentName and an aggregate status'",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown("# Charter\n\n## Objective\n\nProbe.\n", { criteriaMarkdown: md });

    // The criterion still parses (we never drop it), but it is flagged.
    expect(parsed.criteria.map((c) => c.id)).toEqual(["VAL-PHRASE-001"]);
    const warns = parsed.warnings.filter((w) => w.reason === "weak-verifier-phrase-coupled");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.criterionId).toBe("VAL-PHRASE-001");
  });

  test("detector covers wrappers, chains, and phrase-embedded file tokens", () => {
    const flagged = [
      "bun test -t 'group node has no agentName'",
      "bun run test -- -t foo",
      "npm test -- -t foo",
      "pnpm test -- --grep 'x'",
      "yarn test -- -t foo",
      "playwright test -g 'login flow'",
      "bun test -t 'handles src/foo.ts path'", // file-looking token is inside the phrase
      "bun test -t foo && bun test tests/foo.test.ts", // weak segment still flagged
      "FOO=1 bun test -t 'x'",
      "bun test -t 'a && b'", // phrase containing a separator must not mask
      "bun test -t src/foo.ts", // unquoted title VALUE that looks like a file is still title-only
      "npx vitest -t 'x'",
      "mocha --grep 'auth'", // mocha title filter with no file
      "vitest --config vitest.config.ts -t foo", // config path is not test coverage
      "bun test --preload ./test/setup.ts -t foo",
      "SETUP=tests/setup.ts bun test -t foo", // env path value is not coverage
    ];
    const notFlagged = [
      "bun test tests/unit/group-node.test.ts",
      "bun test tests/unit/group-*.test.ts",
      "bun test test/unit/group-node.test.ts -t 'group node'",
      "bun test 'tests/foo.test.ts' -t foo", // quoted file arg must survive
      "bun test -t foo tests/bar.test.ts", // file after a space-separated -t value
      "playwright test e2e/login.spec.ts -g 'login flow'",
      "mocha -t 10000", // mocha -t is --timeout, NOT a title filter
      "mocha --grep 'auth' test/auth.test.js", // title filter but file present
      "bun run check-types",
      "curl -fsS localhost:3000/health",
      "bun test",
      "bun test tests/a.test.ts && bun run check-types",
    ];
    for (const cmd of flagged) expect(isPhraseCoupledTestCommand(cmd), cmd).toBe(true);
    for (const cmd of notFlagged) expect(isPhraseCoupledTestCommand(cmd), cmd).toBe(false);
  });

  test("does NOT flag a command that names a test file or glob", () => {
    const md = [
      "# Criteria",
      "",
      "## VAL-FILE-001 File-level command",
      "Group node behavior.",
      "Verifier: command",
      "Command: bun test tests/unit/group-node.test.ts",
      "",
      "## VAL-GLOB-001 Glob-level command",
      "Group behaviors.",
      "Verifier: command",
      "Command: bun test tests/unit/group-*.test.ts",
      "",
      "## VAL-CMD-001 Observable command",
      "Build succeeds.",
      "Verifier: command",
      "Command: bun run check-types",
      "",
    ].join("\n");

    const parsed = parseCharterMarkdown("# Charter\n\n## Objective\n\nProbe.\n", { criteriaMarkdown: md });

    expect(parsed.warnings.filter((w) => w.reason === "weak-verifier-phrase-coupled")).toHaveLength(0);
  });
});
