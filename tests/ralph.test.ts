import { describe, expect, test } from "bun:test";
import { nextRalphActivation } from "../src/application/ralph";

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
