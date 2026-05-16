/**
 * Bridge between disk state and the charter widget ViewModel.
 *
 * `loadCharterSnapshot` reads all per-charter sources from disk and hands the
 * reducer a fully-resolved ReducerInput. The widget host calls this on every
 * relevant event (charter state changes, evidence recorded, plan locked, async
 * subagent started/completed) and then pushes the resulting ViewModel into
 * `CharterWidget.update(...)`.
 *
 * Running subagents are tracked in-memory (no disk projection) because the
 * existing async-bridge appends events to `events.jsonl` for durability but
 * doesn't maintain an "in-flight" view. We keep that in a per-process Map
 * keyed by runId and seeded by the same async-bridge events.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCharterMarkdown } from "../domain/charter-md";
import { parseFeatureMarkdown, type FeatureDefinition } from "../domain/feature-md";
import { charterDir, loadCharterState } from "../infrastructure/store";
import { readdir } from "node:fs/promises";
import { buildViewModel, type CharterWidgetVM, type ReducerInput, type RunningSubagent } from "./widget-state";

export interface SnapshotInput {
  projectDir: string;
  charterId: string;
  runningSubagents: RunningSubagent[];
  now?: number;
}

export async function loadCharterSnapshot(input: SnapshotInput): Promise<CharterWidgetVM> {
  const dir = charterDir(input.projectDir, input.charterId);
  const [state, charter, features, criterionOutcomes, featureStates] = await Promise.all([
    loadCharterState(dir),
    readCharter(dir),
    readFeatures(dir),
    readCriterionOutcomes(dir),
    readFeatureStates(dir),
  ]);
  const reducerInput: ReducerInput = {
    charterId: input.charterId,
    name: state.name,
    status: state.status,
    createdAt: state.createdAt,
    criteria: charter.criteria,
    features,
    criterionOutcomes,
    featureStates,
    runningSubagents: input.runningSubagents,
    now: input.now,
  };
  return buildViewModel(reducerInput);
}

async function readCharter(dir: string): Promise<{ criteria: ReturnType<typeof parseCharterMarkdown>["criteria"] }> {
  try {
    const md = await readFile(join(dir, "charter.md"), "utf8");
    return { criteria: parseCharterMarkdown(md).criteria };
  } catch {
    return { criteria: [] };
  }
}

async function readFeatures(dir: string): Promise<FeatureDefinition[]> {
  const planDir = join(dir, "plan");
  let entries: string[];
  try {
    entries = await readdir(planDir);
  } catch {
    return [];
  }
  const features: FeatureDefinition[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      features.push(parseFeatureMarkdown(await readFile(join(planDir, entry), "utf8")));
    } catch {
      // skip malformed features rather than break the widget
    }
  }
  return features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function readCriterionOutcomes(dir: string): Promise<Record<string, { outcome?: string }>> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "criterion-state.json"), "utf8")) as {
      criteria?: Record<string, { outcome?: string }>;
    };
    return parsed.criteria ?? {};
  } catch {
    return {};
  }
}

async function readFeatureStates(dir: string): Promise<Record<string, { status?: string }>> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "feature-state.json"), "utf8")) as {
      features?: Record<string, { status?: string }>;
    };
    return parsed.features ?? {};
  } catch {
    return {};
  }
}

/**
 * In-memory tracker for in-flight subagents. Seeded by the async-bridge's
 * `subagent:async-started` / `subagent:async-complete` events. Keyed by runId.
 * Lives for the duration of the process.
 */
export class RunningSubagentRegistry {
  private subs = new Map<string, RunningSubagent>();

  start(payload: { runId: string; agent?: string; metadata?: Record<string, unknown>; startedAt?: string }): void {
    const featureId = readMetaString(payload.metadata, "pi-charter.featureId");
    const criterionId = readMetaString(payload.metadata, "pi-charter.criterionId");
    this.subs.set(payload.runId, {
      runId: payload.runId,
      agentName: payload.agent,
      featureId,
      criterionId,
      startedAt: payload.startedAt ?? new Date().toISOString(),
    });
  }

  complete(runId: string): void {
    this.subs.delete(runId);
  }

  forCharter(charterId: string): RunningSubagent[] {
    // The async-bridge only fires for events with our pi-charter.charterId set,
    // so all entries are already scoped — but a defensive filter when a future
    // multi-charter setup lands.
    const out: RunningSubagent[] = [];
    for (const sub of this.subs.values()) {
      out.push(sub);
    }
    void charterId;
    return out;
  }

  size(): number {
    return this.subs.size;
  }
}

function readMetaString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = metadata?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
