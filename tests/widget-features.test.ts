/**
 * Covers VAL-9 of charter pi-charter-ergonomics-v1: widget-state exposes a
 * per-feature row list beneath the bar with `{featureId, milestone, status,
 * valPass, valTotal, blockedBy?, active?}`. Status is derived from
 * feature-state, live-subagent presence, and precondition completion; no
 * new feature-state field is required.
 */

import { describe, expect, test } from "bun:test";
import type { CharterCriterion, CharterStatus } from "../src/domain/types";
import type { FeatureDefinition } from "../src/domain/feature-md";
import { buildViewModel, type ReducerInput, type RunningSubagent, type FeatureSummaryVM } from "../src/ui/widget-state";

function criterion(id: string): CharterCriterion {
  return {
    id,
    title: `${id} title`,
    verifier: "manual",
    requireFreshEvidence: false,
    requireReviewSubagent: false,
  };
}

function feature(input: {
  id: string;
  order?: number;
  fulfills?: string[];
  preconditions?: string[];
  milestone?: string;
}): FeatureDefinition {
  return {
    id: input.id,
    milestone: input.milestone ?? "m1",
    order: input.order ?? 10,
    fulfills: input.fulfills ?? [],
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

describe("widget featureRows (VAL-9)", () => {
  test("emits a row per feature in plan declaration order with milestone + VAL counts", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2"), criterion("VAL-3")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" } },
      features: [
        feature({ id: "fa", order: 1, milestone: "m1", fulfills: ["VAL-1", "VAL-2"] }),
        feature({ id: "fb", order: 2, milestone: "m2", fulfills: ["VAL-3"] }),
      ],
    }));

    expect(vm.featureRows).toEqual<FeatureSummaryVM[]>([
      { featureId: "fa", milestone: "m1", status: "pending", valPass: 1, valTotal: 2 },
      { featureId: "fb", milestone: "m2", status: "pending", valPass: 0, valTotal: 1 },
    ]);
  });

  test("status: completed when feature-state says so", () => {
    const vm = buildViewModel(defaultInput({
      features: [feature({ id: "fa" })],
      featureStates: { fa: { status: "completed" } },
    }));
    expect(vm.featureRows[0]).toMatchObject({ featureId: "fa", status: "completed" });
    expect(vm.featureRows[0]?.active).toBeUndefined();
  });

  test("status: completed (derived) when every fulfilled VAL has pass evidence", () => {
    const vm = buildViewModel(defaultInput({
      criteria: [criterion("VAL-1"), criterion("VAL-2")],
      criterionOutcomes: { "VAL-1": { outcome: "pass" }, "VAL-2": { outcome: "pass" } },
      features: [feature({ id: "fa", fulfills: ["VAL-1", "VAL-2"] })],
      featureStates: {}, // sidecar lagging — derive from criterion-state instead
    }));
    expect(vm.featureRows[0]).toMatchObject({ featureId: "fa", status: "completed", valPass: 2, valTotal: 2 });
  });

  test("status: in_progress with active:true when feature-state.status === in_progress", () => {
    const vm = buildViewModel(defaultInput({
      features: [feature({ id: "fa" })],
      featureStates: { fa: { status: "in_progress" } },
    }));
    expect(vm.featureRows[0]).toMatchObject({ featureId: "fa", status: "in_progress", active: true });
  });

  test("status: in_progress with active:true when a live subagent owns the feature", () => {
    const subs: RunningSubagent[] = [
      { runId: "r1", charterId: "c-test", agentName: "fixer", featureId: "fa", startedAt: "2026-05-15T10:04:00Z" },
    ];
    const vm = buildViewModel(defaultInput({
      features: [feature({ id: "fa" })],
      runningSubagents: subs,
    }));
    expect(vm.featureRows[0]).toMatchObject({ featureId: "fa", status: "in_progress", active: true });
  });

  test("status: blocked with blockedBy listing unmet precondition feature ids", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "fa", order: 1 }),
        feature({ id: "fb", order: 2, preconditions: ["fa", "fc"] }),
        feature({ id: "fc", order: 3 }),
      ],
    }));
    const fb = vm.featureRows.find((row) => row.featureId === "fb")!;
    expect(fb.status).toBe("blocked");
    expect(fb.blockedBy).toEqual(["fa", "fc"]);
  });

  test("blockedBy only lists preconditions that are NOT done", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "fa", order: 1 }),
        feature({ id: "fb", order: 2, preconditions: ["fa", "fc"] }),
        feature({ id: "fc", order: 3 }),
      ],
      featureStates: { fa: { status: "completed" } },
    }));
    const fb = vm.featureRows.find((row) => row.featureId === "fb")!;
    expect(fb.status).toBe("blocked");
    expect(fb.blockedBy).toEqual(["fc"]);
  });

  test("`blocked` is derived in widget-state; no feature-state field consulted", () => {
    // Reducer must compute `blocked` purely from preconditions vs done-set;
    // it must not require featureState.status === "blocked" (no such durable field).
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "fa", order: 1 }),
        feature({ id: "fb", order: 2, preconditions: ["fa"] }),
      ],
      featureStates: {}, // intentionally empty
    }));
    expect(vm.featureRows.find((row) => row.featureId === "fb")?.status).toBe("blocked");
  });
});

describe("widget readyNext (VAL-10)", () => {
  test("exposes ALL unblocked non-completed features in plan declaration order, not just first", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "f1", order: 1 }),
        feature({ id: "f2", order: 2 }),
        feature({ id: "f3", order: 3 }),
      ],
    }));
    expect(vm.readyNext).toEqual(["f1", "f2", "f3"]);
  });

  test("excludes completed features", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "f1", order: 1 }),
        feature({ id: "f2", order: 2 }),
        feature({ id: "f3", order: 3 }),
      ],
      featureStates: { f1: { status: "completed" } },
    }));
    expect(vm.readyNext).toEqual(["f2", "f3"]);
  });

  test("excludes blocked features (unmet preconditions)", () => {
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "f1", order: 1 }),
        feature({ id: "f2", order: 2, preconditions: ["f1"] }),
        feature({ id: "f3", order: 3 }),
      ],
    }));
    expect(vm.readyNext).toEqual(["f1", "f3"]);
  });

  test("excludes features currently in_progress / with a live subagent (already in flight)", () => {
    const subs: RunningSubagent[] = [
      { runId: "r1", charterId: "c-test", agentName: "fixer", featureId: "f2", startedAt: "2026-05-15T10:04:00Z" },
    ];
    const vm = buildViewModel(defaultInput({
      features: [
        feature({ id: "f1", order: 1 }),
        feature({ id: "f2", order: 2 }),
        feature({ id: "f3", order: 3 }),
      ],
      featureStates: { f3: { status: "in_progress" } },
      runningSubagents: subs,
    }));
    expect(vm.readyNext).toEqual(["f1"]);
  });
});
