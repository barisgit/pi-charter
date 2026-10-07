import { describe, expect, test } from "bun:test";
import { nextRalphActivation, renderRalphPrompt } from "../src/application/ralph";

const minute = 60_000;

describe("Ralph activation guard", () => {
  test("expired warnings retain rolling history and may warn again, without a timer-generated pause", () => {
    const result = nextRalphActivation({ activations: [3 * minute, 6 * minute, 9 * minute, 12 * minute, 14 * minute], warnedAt: 14 * minute }, 19 * minute + 1);
    expect(result.kind).toBe("recovery");
    expect(result.state.activations).toEqual([6 * minute, 9 * minute, 12 * minute, 14 * minute, 19 * minute + 1]);
    expect(result.state.warnedAt).toBe(19 * minute + 1);
  });

  test("a quiet interval expires both warning and old activations", () => {
    const result = nextRalphActivation({ activations: [0, minute, 2 * minute, 3 * minute, 4 * minute], warnedAt: 4 * minute }, 20 * minute);
    expect(result).toEqual({ kind: "normal", state: { activations: [20 * minute] } });
  });

  test("the fifteenth-minute boundary is included in the rolling window", () => {
    expect(nextRalphActivation({ activations: [0, minute, 2 * minute, 3 * minute] }, 15 * minute).kind).toBe("recovery");
    expect(nextRalphActivation({ activations: [0, minute, 2 * minute, 3 * minute] }, 15 * minute + 1).kind).toBe("normal");
  });
  test("the next eligible activation at the five-minute boundary pauses without counting a send", () => {
    const activations = [0, 3 * minute, 6 * minute, 9 * minute, 12 * minute];
    const result = nextRalphActivation({ activations, warnedAt: 12 * minute }, 17 * minute);
    expect(result.kind).toBe("pause");
    expect(result.state.pausedByGuard).toBe(true);
    expect(result.state.activations).not.toContain(17 * minute);
  });
  test("the fifth activation in fifteen minutes replaces normal steering with recovery", () => {
    const result = nextRalphActivation({ activations: [0, 3 * minute, 6 * minute, 9 * minute] }, 12 * minute);
    expect(result.kind).toBe("recovery");
    expect(result.state).toEqual({ activations: [0, 3 * minute, 6 * minute, 9 * minute, 12 * minute], warnedAt: 12 * minute });
  });
});


describe("Ralph prompt", () => {
  const objective = "Ship recovery.\n\n### Constraints\n\nDo not change login.";
  const base = { charterId: "20260101-000000-demo", objective, references: "- docs/spec.md", scope: "Web only." };
  const continuation = "Take the next useful step toward the Objective; if a job is already running, check on it instead of starting another. When the Objective is satisfied, complete the charter with a concise note. If you are blocked, pause and say why.";

  test("normal prompt restates the exact Objective, references and scope with a short continue-or-finish instruction", () => {
    const prompt = renderRalphPrompt(base);
    expect(prompt).toBe([
      "Continue the charter at .charters/20260101-000000-demo/charter.md.",
      `Objective:\n${objective}`,
      "References:\n- docs/spec.md",
      "Scope:\nWeb only.",
      continuation,
    ].join("\n\n"));
    expect(prompt).not.toMatch(/phase|REPORT|evidence|user-authored|instructions/i);
  });

  test("recovery prompt adds the guard warning and omits absent sections", () => {
    expect(renderRalphPrompt({ ...base, references: "", scope: "" }, true)).toBe([
      "Continue the charter at .charters/20260101-000000-demo/charter.md.",
      `Objective:\n${objective}`,
      "Ralph has sent five continuations in fifteen minutes; another within five minutes pauses the charter. If you are repeating checks or waiting with nothing running, do something different or pause and say what blocks you.",
      continuation,
    ].join("\n\n"));
  });
});
