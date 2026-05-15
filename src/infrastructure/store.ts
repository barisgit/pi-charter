import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderInitialCharterMarkdown } from "../domain/charter-md";
import type { Budget, CharterEvent, CharterState } from "../domain/types";

export interface CreateCharterWorkspaceInput {
  charterId: string;
  objective: string;
  now: string;
  budget?: Budget;
  sessionId?: string;
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
    objective: input.objective.trim(),
    status: "planning",
    createdAt: input.now,
    updatedAt: input.now,
    budget: input.budget,
    sessionId: input.sessionId,
  };

  await mkdir(join(dir, "plan"), { recursive: true });
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
  return normalizeCharterState(parsed);
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

export async function appendEvent(dir: string, event: CharterEvent): Promise<void> {
  const path = join(dir, "events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  // Atomic append is not necessary for first cut because pi tools execute in the
  // extension process; revisit with a file mutation queue if multiple writers emerge.
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  await writeTextAtomic(path, `${existing}${JSON.stringify(event)}\n`);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, path);
}

async function updateIndex(root: string, state: CharterState): Promise<void> {
  const path = join(root, "index.json");
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
  await writeJsonAtomic(path, { charters: [...others, row] });
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
    objective: raw.objective.trim(),
    status: raw.status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
    charterDigest: typeof raw.charterDigest === "string" ? raw.charterDigest : undefined,
    planDigest: typeof raw.planDigest === "string" ? raw.planDigest : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    budget: typeof raw.budget === "object" && raw.budget ? (raw.budget as Budget) : undefined,
    previousStatus: isStatus(raw.previousStatus) ? raw.previousStatus : undefined,
  };
}

function isStatus(value: unknown): value is CharterState["status"] {
  return (
    value === "planning" ||
    value === "active" ||
    value === "review" ||
    value === "paused" ||
    value === "completed" ||
    value === "budget_limited" ||
    value === "abandoned"
  );
}
