import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseCharterFile, type ParsedCharterFile } from "../domain/charter-file";
import { renderCharterTemplate } from "../domain/template";
import type { CharterEvent, CharterState, CriterionSnapshot } from "../domain/types";

export interface CreateCharterWorkspaceInput {
  charterId: string;
  objective: string;
  now: string;
  sessionId?: string;
}

export interface CreatedCharterWorkspace {
  charterId: string;
  charterDir: string;
  state: CharterState;
}

export interface CharterListRow {
  charterId: string;
  objective: string;
  status: CharterState["status"];
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
}

const charterQueues = new Map<string, Promise<unknown>>();
const writeQueues = new Map<string, Promise<unknown>>();

export function chartersRoot(projectDir: string): string {
  return join(projectDir, ".charters");
}

export function charterDir(projectDir: string, charterId: string): string {
  return join(chartersRoot(projectDir), charterId);
}

export function charterFilePath(dir: string): string {
  return join(dir, "charter.md");
}

export function reportPath(dir: string): string {
  return join(dir, "REPORT.md");
}

export async function withCharterLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const prev = charterQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guard = next.catch(() => undefined);
  charterQueues.set(key, guard);
  try {
    return await next;
  } finally {
    if (charterQueues.get(key) === guard) charterQueues.delete(key);
  }
}

export async function createCharterWorkspace(
  projectDir: string,
  input: CreateCharterWorkspaceInput,
): Promise<CreatedCharterWorkspace> {
  const dir = charterDir(projectDir, input.charterId);
  const text = renderCharterTemplate(input.objective);
  const parsed = parseCharterFile(text);
  const nowSeq = 1;
  const state: CharterState = {
    charterId: input.charterId,
    schemaVersion: "file-interface",
    objective: input.objective.trim(),
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
    sessionId: input.sessionId,
    nextSeq: nowSeq,
    latestSourceSeq: 0,
    snapshotHash: hashText(text),
    criteriaSnapshot: snapshotFromParsed(parsed, 0),
  };

  await mkdir(dir, { recursive: true });
  await writeTextAtomic(join(dir, "charter.md"), text);
  await writeJsonAtomic(join(dir, "state.json"), state);
  await writeTextAtomic(join(dir, "events.jsonl"), "");
  await appendEvent(dir, {
    type: "charter_created",
    ts: input.now,
    charterId: input.charterId,
    objective: state.objective,
  });
  return { charterId: input.charterId, charterDir: dir, state };
}

export async function ensureWorkDir(dir: string): Promise<string> {
  const path = join(dir, "work");
  await mkdir(path, { recursive: true });
  return path;
}

export async function loadCharterState(dirOrProject: string, charterId?: string): Promise<CharterState> {
  const dir = charterId ? charterDir(dirOrProject, charterId) : dirOrProject;
  const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as unknown;
  return normalizeCharterState(raw);
}

export async function writeCharterState(dir: string, state: CharterState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(join(dir, "state.json"), state);
}

export async function loadCharterText(dir: string): Promise<string> {
  return readFile(join(dir, "charter.md"), "utf8");
}

export async function loadParsedCharter(dir: string): Promise<ParsedCharterFile> {
  return parseCharterFile(await loadCharterText(dir));
}

export async function listCharterIds(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(chartersRoot(projectDir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

export async function listCharters(projectDir: string): Promise<CharterListRow[]> {
  const rows: CharterListRow[] = [];
  for (const id of await listCharterIds(projectDir)) {
    try {
      const state = await loadCharterState(projectDir, id);
      rows.push({
        charterId: state.charterId,
        objective: state.objective,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        sessionId: state.sessionId,
      });
    } catch {
      // Ignore malformed directories; parser tolerance applies to charter.md,
      // not missing runtime sidecars.
    }
  }
  return rows;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function appendEvent(dir: string, event: CharterEvent): Promise<void> {
  const path = join(dir, "events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await withPathLock(path, async () => {
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    await writeTextAtomicUnsafe(path, `${existing}${JSON.stringify(event)}\n`);
  });
}

export async function readEvents(dir: string): Promise<CharterEvent[]> {
  try {
    return (await readFile(join(dir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CharterEvent);
  } catch {
    return [];
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await withPathLock(path, () => writeTextAtomicUnsafe(path, value));
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function snapshotFromParsed(parsed: ParsedCharterFile, evidenceSeq: number): CriterionSnapshot[] {
  return parsed.criteria.map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    depends: criterion.depends,
    evidence: { ...criterion.evidence },
    evidenceSeq,
  }));
}

async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const guard = next.catch(() => undefined);
  writeQueues.set(key, guard);
  try {
    return await next;
  } finally {
    if (writeQueues.get(key) === guard) writeQueues.delete(key);
  }
}

async function writeTextAtomicUnsafe(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, path);
}

function normalizeCharterState(value: unknown): CharterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid charter state");
  const raw = value as Record<string, unknown>;
  if (typeof raw.charterId !== "string" || raw.charterId.length === 0) throw new Error("Invalid charter state: charterId");
  if (typeof raw.objective !== "string") throw new Error("Invalid charter state: objective");
  if (!isStatus(raw.status)) throw new Error("Invalid charter state: status");
  if (raw.schemaVersion !== "file-interface") throw new Error("Invalid charter state: schemaVersion");
  return {
    charterId: raw.charterId,
    schemaVersion: "file-interface",
    objective: raw.objective,
    status: raw.status,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    previousStatus: isStatus(raw.previousStatus) ? raw.previousStatus : undefined,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
    terminatedAt: typeof raw.terminatedAt === "string" ? raw.terminatedAt : undefined,
    completionNote: typeof raw.completionNote === "string" ? raw.completionNote : undefined,
    abandonReason: typeof raw.abandonReason === "string" ? raw.abandonReason : undefined,
    nextSeq: typeof raw.nextSeq === "number" && raw.nextSeq > 0 ? Math.floor(raw.nextSeq) : 1,
    latestSourceSeq: typeof raw.latestSourceSeq === "number" && raw.latestSourceSeq >= 0 ? Math.floor(raw.latestSourceSeq) : 0,
    snapshotHash: typeof raw.snapshotHash === "string" ? raw.snapshotHash : "",
    criteriaSnapshot: Array.isArray(raw.criteriaSnapshot) ? raw.criteriaSnapshot.filter(isCriterionSnapshot) : [],
  };
}

function isStatus(value: unknown): value is CharterState["status"] {
  return value === "active" || value === "paused" || value === "completed" || value === "abandoned";
}

function isCriterionSnapshot(value: unknown): value is CriterionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const evidence = raw.evidence as Record<string, unknown> | undefined;
  return (
    typeof raw.id === "string" &&
    typeof raw.title === "string" &&
    Array.isArray(raw.depends) &&
    evidence !== undefined &&
    (evidence.status === "pass" || evidence.status === "fail" || evidence.status === "none") &&
    typeof evidence.note === "string" &&
    typeof raw.evidenceSeq === "number"
  );
}
