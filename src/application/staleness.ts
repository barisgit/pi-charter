import { relative, resolve } from "node:path";
import { pathExists, chartersRoot, withCharterLock, charterDir, hashText, loadCharterState, loadCharterText, listCharterIds, snapshotFromParsed, appendEvent, writeCharterState } from "../infrastructure/store";
import { parseCharterFile, type ParsedCharterFile } from "../domain/charter-file";
import type { CharterState, CriterionSnapshot } from "../domain/types";

export interface CriterionStaleness {
  id: string;
  statusSeq: number;
  stale: boolean;
}

export interface SnapshotRefreshResult {
  parsed: ParsedCharterFile;
  state: CharterState;
  changed: boolean;
}

export async function refreshCharterSnapshot(
  projectDir: string,
  charterId: string,
  options: { seq?: number; source?: "tool" | "external" } = {},
): Promise<SnapshotRefreshResult> {
  return withCharterLock(chartersRoot(projectDir), () => refreshCharterSnapshotUnlocked(projectDir, charterId, options));
}

// Internal entry point: caller must hold the project mutation lock.
export async function refreshCharterSnapshotUnlocked(
  projectDir: string,
  charterId: string,
  options: { seq?: number; source?: "tool" | "external" } = {},
): Promise<SnapshotRefreshResult> {
  const dir = charterDir(projectDir, charterId);
  const state = await loadCharterState(dir);
  const text = await loadCharterText(dir);
  const hash = hashText(text);
  const parsed = parseCharterFile(text);
  if (hash === state.snapshotHash) return { parsed, state, changed: false };

  const seq = options.seq ?? consumeSeq(state);
  const ts = new Date().toISOString();
  const nextSnapshot = mergeStatusSeqs(state.criteriaSnapshot, snapshotFromParsed(parsed, seq), seq);
  for (const event of diffCriteria(state.criteriaSnapshot, nextSnapshot, state.charterId, seq, ts, options.source ?? "external")) {
    await appendEvent(dir, event);
  }
  state.snapshotHash = hash;
  state.criteriaSnapshot = nextSnapshot;
  await writeCharterState(dir, state);
  return { parsed, state, changed: true };
}

export async function refreshSessionSnapshots(projectDir: string, sessionId?: string): Promise<void> {
  if (!(await pathExists(chartersRoot(projectDir)))) return;
  return withCharterLock(chartersRoot(projectDir), async () => {
    for (const id of await listCharterIds(projectDir)) {
      const state = await loadCharterState(projectDir, id).catch(() => undefined);
      if (!state || state.status === "completed" || state.status === "abandoned") continue;
      if (sessionId && state.sessionId && state.sessionId !== sessionId) continue;
      await refreshCharterSnapshotUnlocked(projectDir, id, { source: "external" });
    }
  });
}

export async function recordSourceModification(
  projectDir: string,
  input: { files: string[]; sessionId?: string; source?: string; seq?: number },
): Promise<void> {
  if (!(await pathExists(chartersRoot(projectDir)))) return;
  return withCharterLock(chartersRoot(projectDir), async () => {
    const files = uniqueSourceFiles(projectDir, input.files);
    if (files.length === 0) return;
    for (const id of await listCharterIds(projectDir)) {
      const dir = charterDir(projectDir, id);
      const state = await loadCharterState(dir).catch(() => undefined);
      if (!state || state.status === "completed" || state.status === "abandoned") continue;
      if (input.sessionId && state.sessionId && state.sessionId !== input.sessionId) continue;
      const seq = input.seq ?? consumeSeq(state);
      const ts = new Date().toISOString();
      state.latestSourceSeq = Math.max(state.latestSourceSeq, seq);
      await appendEvent(dir, {
        type: "source_modified",
        ts,
        charterId: id,
        seq,
        files,
        source: input.source ?? "tool",
      });
      await writeCharterState(dir, state);
    }
  });
}

export async function tickToolResult(
  projectDir: string,
  input: { sessionId?: string; files?: string[]; source?: string } = {},
): Promise<void> {
  if (!(await pathExists(chartersRoot(projectDir)))) return;
  return withCharterLock(chartersRoot(projectDir), async () => {
    const seqById = new Map<string, number>();
    for (const id of await listCharterIds(projectDir)) {
      const dir = charterDir(projectDir, id);
      const state = await loadCharterState(dir).catch(() => undefined);
      if (!state || state.status === "completed" || state.status === "abandoned") continue;
      if (input.sessionId && state.sessionId && state.sessionId !== input.sessionId) continue;
      const seq = consumeSeq(state);
      seqById.set(id, seq);
      await writeCharterState(dir, state);
      await refreshCharterSnapshotUnlocked(projectDir, id, { seq, source: "tool" });
    }
    const files = uniqueSourceFiles(projectDir, input.files ?? []);
    if (files.length === 0) return;
    for (const [id, seq] of seqById) {
      const dir = charterDir(projectDir, id);
      const state = await loadCharterState(dir);
      state.latestSourceSeq = Math.max(state.latestSourceSeq, seq);
      await appendEvent(dir, {
        type: "source_modified",
        ts: new Date().toISOString(),
        charterId: id,
        seq,
        files,
        source: input.source ?? "tool",
      });
      await writeCharterState(dir, state);
    }
  });
}

export function criterionStaleness(state: CharterState): CriterionStaleness[] {
  return state.criteriaSnapshot.map((criterion) => ({
    id: criterion.id,
    statusSeq: criterion.statusSeq,
    stale: criterion.status.value === "pass" && criterion.statusSeq < state.latestSourceSeq,
  }));
}

export function isCriterionStale(state: CharterState, criterionId: string): boolean {
  return criterionStaleness(state).some((entry) => entry.id === criterionId && entry.stale);
}

function consumeSeq(state: CharterState): number {
  const seq = state.nextSeq;
  state.nextSeq += 1;
  return seq;
}

function mergeStatusSeqs(
  previous: CriterionSnapshot[],
  next: CriterionSnapshot[],
  changedSeq: number,
): CriterionSnapshot[] {
  const byId = new Map(previous.map((criterion) => [criterion.id, criterion]));
  return next.map((criterion) => {
    const old = byId.get(criterion.id);
    const statusChanged = !old || old.status.value !== criterion.status.value || old.status.note !== criterion.status.note;
    return { ...criterion, statusSeq: statusChanged ? changedSeq : old.statusSeq };
  });
}

function diffCriteria(
  oldSnapshot: CriterionSnapshot[],
  newSnapshot: CriterionSnapshot[],
  charterId: string,
  seq: number,
  ts: string,
  source: "tool" | "external",
) {
  const events: Array<{ type: string; ts: string; charterId: string; seq: number; criterion: string; field: string; old: unknown; new: unknown; source: string }> = [];
  const oldById = new Map(oldSnapshot.map((criterion) => [criterion.id, criterion]));
  const newById = new Map(newSnapshot.map((criterion) => [criterion.id, criterion]));
  for (const criterion of newSnapshot) {
    const old = oldById.get(criterion.id);
    if (!old) {
      events.push({ type: "criterion_changed", ts, charterId, seq, criterion: criterion.id, field: "criterion", old: undefined, new: criterion, source });
      continue;
    }
    pushIfChanged(events, charterId, seq, ts, criterion.id, "title", old.title, criterion.title, source);
    pushIfChanged(events, charterId, seq, ts, criterion.id, "depends", old.depends, criterion.depends, source);
    pushIfChanged(events, charterId, seq, ts, criterion.id, "status.value", old.status.value, criterion.status.value, source);
    pushIfChanged(events, charterId, seq, ts, criterion.id, "status.note", old.status.note, criterion.status.note, source);
  }
  for (const criterion of oldSnapshot) {
    if (!newById.has(criterion.id)) {
      events.push({ type: "criterion_changed", ts, charterId, seq, criterion: criterion.id, field: "criterion", old: criterion, new: undefined, source });
    }
  }
  return events;
}

function pushIfChanged(
  events: Array<{ type: string; ts: string; charterId: string; seq: number; criterion: string; field: string; old: unknown; new: unknown; source: string }>,
  charterId: string,
  seq: number,
  ts: string,
  criterion: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  source: "tool" | "external",
): void {
  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
  events.push({ type: "criterion_changed", ts, charterId, seq, criterion, field, old: oldValue, new: newValue, source });
}

function uniqueSourceFiles(projectDir: string, files: string[]): string[] {
  const root = resolve(projectDir);
  const out = new Set<string>();
  for (const file of files) {
    if (!file || isCharterPath(file)) continue;
    const rel = relative(root, resolve(projectDir, file));
    if (rel.startsWith("..")) continue;
    if (!rel || isCharterPath(rel)) continue;
    out.add(rel);
  }
  return [...out].sort();
}

function isCharterPath(path: string): boolean {
  return path.split(/[\\/]+/).includes(".charters");
}
