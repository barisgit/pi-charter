/**
 * VAL-10 dedicated verifier: widget-state.readyNext exposes ALL unblocked
 * non-completed features in plan declaration order. The full readyNext
 * suite lives in tests/widget-features.test.ts (alongside VAL-9); this file
 * is the named verifier surface for VAL-10 plus the canonical "3 unblocked
 * sibling features → all 3 surface" fixture from the charter.
 */

import { describe, expect, test } from "bun:test";
import type { CharterStatus } from "../src/domain/types";
import type { FeatureDefinition } from "../src/domain/feature-md";
import { buildViewModel, type ReducerInput } from "../src/ui/widget-state";

function feature(input: { id: string; order: number; preconditions?: string[] }): FeatureDefinition {
  return {
    id: input.id,
    milestone: "m1",
    order: input.order,
    fulfills: [],
    preconditions: input.preconditions ?? [],
    kind: "impl",
    review: "required",
    targets: [],
    checks: { happy: [], edge: [] },
    body: "",
  };
}

function defaultInput(overrides: Partial<ReducerInput> = {}): ReducerInput {
  return {
    charterId: "test-charter",
    status: "active" as CharterStatus,
    createdAt: "2026-05-15T10:00:00Z",
    criteria: [],
    features: [],
    criterionOutcomes: {},
    featureStates: {},
    runningSubagents: [],
    now: Date.parse("2026-05-15T10:05:00Z"),
    ...overrides,
  };
}

describe("VAL-10: widget-state.readyNext", () => {
  test("3 unblocked sibling features → all 3 surface in declaration order", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "fa", order: 1 }),
        feature({ id: "fb", order: 2 }),
        feature({ id: "fc", order: 3 }),
      ],
    }));
    expect(vm.readyNext).toEqual(["fa", "fb", "fc"]);
    expect(vm.readyNext.length).toBeGreaterThan(1); // not just readyNext[0]
  });

  test("declaration order is `order` ascending, id as tiebreaker", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "z", order: 3 }),
        feature({ id: "a", order: 1 }),
        feature({ id: "m", order: 2 }),
      ],
    }));
    expect(vm.readyNext).toEqual(["a", "m", "z"]);
  });

  test("blocked siblings are excluded; unblocked ones still surface", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "fa", order: 1 }),
        feature({ id: "fb", order: 2, preconditions: ["fa"] }),
        feature({ id: "fc", order: 3 }),
      ],
    }));
    expect(vm.readyNext).toEqual(["fa", "fc"]);
  });
});
