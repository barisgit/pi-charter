import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { renderInitialCharterMarkdown } from "../domain/charter-md";
import type { Budget, CharterEvent, CharterState } from "../domain/types";

export interface CreateCharterWorkspaceInput {
  charterId: string;
  name?: string;
  objective: string;
  now: string;
  budget?: Budget;
  sessionId?: string;
}

const charterQueues = new Map<string, Promise<unknown>>();

export async function withCharterLock<T>(charterDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(charterDir);
  const prev = charterQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Store the swallowed-error version so a failed charter mutation doesn't poison the queue.
  const guard = next.catch(() => undefined);
  charterQueues.set(key, guard);
  try {
    return await next;
  } finally {
    // GC: if no later writer chained onto us, drop the entry.
    if (charterQueues.get(key) === guard) charterQueues.delete(key);
  }
}

export interface CreatedCharterWorkspace {
  charterId: string;
  charterDir: string;
  state: CharterState;
}

export interface CharterIndexRow {
  charterId: string;
  objective: string;
  status: CharterState["status"];
  createdAt: string;
  updatedAt: string;
}

export function chartersRoot(projectDir: string): string {
  return join(projectDir, ".pi", "charters");
}

export function charterDir(projectDir: string, charterId: string): string {
  return join(chartersRoot(projectDir), charterId);
}

export async function createCharterWorkspace(
  projectDir: string,
  input: CreateCharterWorkspaceInput,
): Promise<CreatedCharterWorkspace> {
  const root = chartersRoot(projectDir);
  const dir = charterDir(projectDir, input.charterId);
  const state: CharterState = {
    charterId: input.charterId,
    schemaVersion: "v2",
    name: input.name,
    objective: input.objective.trim(),
    status: "planning",
    createdAt: input.now,
    updatedAt: input.now,
    budget: input.budget,
    sessionId: input.sessionId,
  };

  await mkdir(join(dir, "plan"), { recursive: true });
  await mkdir(join(dir, "qa"), { recursive: true });
  await writeTextAtomic(join(dir, "charter.md"), renderInitialCharterMarkdown(state.objective));
  await writeJsonAtomic(join(dir, "state.json"), state);
  await writeJsonAtomic(join(dir, "plan.json"), { charterId: input.charterId, milestones: [], features: [] });
  await writeJsonAtomic(join(dir, "feature-state.json"), { charterId: input.charterId, features: {} });
  await writeJsonAtomic(join(dir, "criterion-state.json"), { charterId: input.charterId, criteria: {} });
  await appendEvent(dir, {
    type: "charter_created",
    ts: input.now,
    charterId: input.charterId,
    objective: state.objective,
  });
  await updateIndex(root, state);

  return { charterId: input.charterId, charterDir: dir, state };
}

export async function loadCharterState(dirOrProject: string, charterId?: string): Promise<CharterState> {
  const dir = charterId ? charterDir(dirOrProject, charterId) : dirOrProject;
  const parsed = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as unknown;
  const state = normalizeCharterState(parsed);
  if (state.schemaVersion === "v2" || state.schemaVersion === "v1-needs-replan") return state;
  if (await isV1CharterDir(dir)) return { ...state, schemaVersion: "v1-needs-replan" };
  return state;
}

export async function isV1Charter(projectDir: string, charterId: string): Promise<boolean> {
  return isV1CharterDir(charterDir(projectDir, charterId));
}

async function isV1CharterDir(dir: string): Promise<boolean> {
  let charterMarkdown = "";
  try {
    charterMarkdown = await readFile(join(dir, "charter.md"), "utf8");
    await readFile(join(dir, "criterion-state.json"), "utf8");
  } catch {
    return false;
  }
  const criteriaSection = /(?:^|\n)##\s+Criteria\s*(?:\n|$)([\s\S]*?)(?=\n##\s+|$)/i.exec(charterMarkdown)?.[1] ?? "";
  return /(?:^|\n)###\s+VAL-[A-Z0-9-]+\b/i.test(criteriaSection);
}

export async function writeCharterState(dir: string, state: CharterState): Promise<void> {
  await writeJsonAtomic(join(dir, "state.json"), state);
}

export async function loadCharterIndex(projectDir: string): Promise<CharterIndexRow[]> {
  try {
    const parsed = JSON.parse(await readFile(join(chartersRoot(projectDir), "index.json"), "utf8")) as { charters?: unknown };
    if (!Array.isArray(parsed.charters)) return [];
    return parsed.charters.filter(isIndexRow);
  } catch {
    return [];
  }
}

// Per-path serialization. Parallel charter_plan calls (and any other in-process
// writer that targets the same file in the same turn) chain through one promise
// per absolute path so read-modify-write sequences like appendEvent can't lose
// concurrent updates and tmp-rename races can't ENOENT each other.
const writeQueues = new Map<string, Promise<unknown>>();

async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Store the swallowed-error version so a failed write doesn't poison the queue.
  const guard = next.catch(() => undefined);
  writeQueues.set(path, guard);
  try {
    return await next;
  } finally {
    // GC: if no later writer chained onto us, drop the entry.
    if (writeQueues.get(path) === guard) writeQueues.delete(path);
  }
}

export async function appendEvent(dir: string, event: CharterEvent): Promise<void> {
  const path = join(dir, "events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await withPathLock(path, async () => {
    // Read inside the same path lock as the atomic rewrite so concurrent
    // appendEvent callers cannot base their write on stale contents.
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    await writeTextAtomicUnsafe(path, `${existing}${JSON.stringify(event)}\n`);
  });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await withPathLock(path, () => writeTextAtomicUnsafe(path, value));
}

async function writeTextAtomicUnsafe(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Random suffix prevents sub-ms collisions across parallel writers (multiple
  // charter_plan add_feature calls in the same turn race on Date.now()).
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, path);
}

async function updateIndex(root: string, state: CharterState): Promise<void> {
  const path = join(root, "index.json");
  // Wrap the entire load-modify-write under the same path lock that writeJsonAtomic
  // uses, so concurrent createCharterWorkspace calls from different charters in the
  // same project cannot lose rows via last-writer-wins.
  await withPathLock(path, async () => {
    let current: { charters: CharterIndexRow[] } = { charters: [] };
    try {
      current = JSON.parse(await readFile(path, "utf8")) as typeof current;
    } catch {
      current = { charters: [] };
    }
    const row = {
      charterId: state.charterId,
      objective: state.objective,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
    const others = Array.isArray(current.charters)
      ? current.charters.filter((item) => item.charterId !== state.charterId)
      : [];
    await writeTextAtomicUnsafe(path, `${JSON.stringify({ charters: [...others, row] }, null, 2)}\n`);
  });
}

function isIndexRow(value: unknown): value is CharterIndexRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.charterId === "string" &&
    typeof raw.objective === "string" &&
    isStatus(raw.status) &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string"
  );
}

function normalizeCharterState(value: unknown): CharterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid charter state");
  const raw = value as Record<string, unknown>;
  if (typeof raw.charterId !== "string" || !raw.charterId) throw new Error("Invalid charter state: charterId");
  if (typeof raw.objective !== "string" || !raw.objective.trim()) throw new Error("Invalid charter state: objective");
  if (!isStatus(raw.status)) throw new Error("Invalid charter state: status");
  const now = new Date().toISOString();
  return {
    charterId: raw.charterId,
    schemaVersion: raw.schemaVersion === "v2" || raw.schemaVersion === "v1-needs-replan" ? raw.schemaVersion : undefined,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
    objective: raw.objective.trim(),
    status: raw.status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    charterDigest: typeof raw.charterDigest === "string" ? raw.charterDigest : undefined,
    planDigest: typeof raw.planDigest === "string" ? raw.planDigest : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    budget: typeof raw.budget === "object" && raw.budget ? (raw.budget as Budget) : undefined,
    previousStatus: isStatus(raw.previousStatus) ? raw.previousStatus : undefined,
    clarificationNote: typeof raw.clarificationNote === "string" ? raw.clarificationNote : undefined,
    unansweredClarification: typeof raw.unansweredClarification === "boolean" ? raw.unansweredClarification : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    terminatedAt: typeof raw.terminatedAt === "string" ? raw.terminatedAt : undefined,
    completionReason: typeof raw.completionReason === "string" ? raw.completionReason : undefined,
  };
}

function isStatus(value: unknown): value is CharterState["status"] {
  return (
    value === "planning" ||
    value === "active" ||
    value === "review" ||
    value === "paused" ||
    value === "awaiting-clarification" ||
    value === "completed" ||
    value === "budget_limited" ||
    value === "abandoned"
  );
}
