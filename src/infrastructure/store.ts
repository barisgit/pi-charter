import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout } from "node:timers/promises";
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

// Application mutations pass chartersRoot(projectDir), so lifecycle checks and
// snapshot writes share one project-wide lock. Not reentrant: awaiting another
// mutation (including from a hook) deadlocks the local queue before file timeout.
export async function withCharterLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const prev = charterQueues.get(key) ?? Promise.resolve();
  const run = () => withFileLock(join(key, ".mutation.lock"), fn);
  const next = prev.then(run, run);
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
    return entries.filter((entry) => entry.isDirectory() && entry.name !== ".mutation.lock").map((entry) => entry.name).sort().reverse();
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
  await withPathLock(path, () => withFileLock(`${path}.lock`, () =>
    appendFile(path, `${JSON.stringify(event)}\n`, "utf8"),
  ));
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

export function snapshotFromParsed(parsed: ParsedCharterFile, statusSeq: number): CriterionSnapshot[] {
  return parsed.criteria.map((criterion) => ({
    id: criterion.id,
    title: criterion.title,
    depends: criterion.depends,
    status: { ...criterion.status },
    statusSeq,
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

// Local filesystems only. The owner filename publishes complete metadata atomically.
// Hostname mismatch/unknown ownership fails closed; PID reuse is treated as live.
const lockHost = createHash("sha256").update(hostname()).digest("hex");
const lockOwnerPattern = /^owner-([a-f0-9]{64})-([1-9][0-9]*)-([a-f0-9]{32})$/;

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const owner = `owner-${lockHost}-${process.pid}-${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + 10_000;
  let unknownSince: number | undefined;
  const recoveryError = (reason: string) => new Error(`Charter lock ${path}: ${reason}. Stop all project writers, inspect state/history, then remove the orphan lock directory before retrying.`);
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const match = entries.length === 1 ? lockOwnerPattern.exec(entries[0]) : null;
    if (!match) {
      // Allow publication/release to finish, but never remove an ownerless lock.
      unknownSince ??= Date.now();
      if (Date.now() - unknownSince >= 100) throw recoveryError("ownership unknown");
    } else {
      unknownSince = undefined;
      if (match[1] !== lockHost) throw recoveryError("owner is on another host");
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) throw recoveryError("invalid owner pid");
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw recoveryError("owner liveness cannot be established");
        await releaseFileLock(path, entries[0]);
        continue;
      }
    }
    if (Date.now() >= deadline) throw recoveryError("timed out waiting for live owner");
    await setTimeout(10);
  }
  try {
    await writeFile(join(path, owner), "", { flag: "wx" });
    return await fn();
  } finally {
    await releaseFileLock(path, owner);
  }
}

async function releaseFileLock(path: string, owner: string): Promise<void> {
  // Only the successful renamer may rmdir. Concurrent unlink can report success
  // to multiple callers on macOS. A stale reclaimer cannot rename a replacement
  // owner's random filename. A crash during release leaves unknown ownership.
  const releasing = join(path, `releasing-${randomBytes(16).toString("hex")}`);
  try {
    await rename(join(path, owner), releasing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await unlink(releasing);
  await rmdir(path);
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
    criteriaSnapshot: Array.isArray(raw.criteriaSnapshot)
      ? raw.criteriaSnapshot.map(normalizeCriterionSnapshot).filter((criterion): criterion is CriterionSnapshot => criterion !== undefined)
      : [],
  };
}

function isStatus(value: unknown): value is CharterState["status"] {
  return value === "active" || value === "paused" || value === "completed" || value === "abandoned";
}

function normalizeCriterionSnapshot(value: unknown): CriterionSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || !Array.isArray(raw.depends)) return undefined;
  const depends = raw.depends.filter((item): item is string => typeof item === "string");
  const status = raw.status as Record<string, unknown> | undefined;
  if (status && isCriterionStatus(status.value) && typeof status.note === "string" && typeof raw.statusSeq === "number") {
    return { id: raw.id, title: raw.title, depends, status: { value: status.value, note: status.note }, statusSeq: raw.statusSeq };
  }

  // ADR-0014 compatibility: normalize old sidecars in memory and write only
  // the unified Status shape on the next state update.
  const evidence = raw.evidence as Record<string, unknown> | undefined;
  if (
    evidence &&
    (evidence.status === "pass" || evidence.status === "fail" || evidence.status === "none") &&
    typeof evidence.note === "string" &&
    typeof raw.evidenceSeq === "number"
  ) {
    return {
      id: raw.id,
      title: raw.title,
      depends,
      status: { value: evidence.status === "none" ? "pending" : evidence.status, note: evidence.note },
      statusSeq: raw.evidenceSeq,
    };
  }
  return undefined;
}

function isCriterionStatus(value: unknown): value is CriterionSnapshot["status"]["value"] {
  return value === "pending" || value === "in-progress" || value === "blocked" || value === "pass" || value === "fail";
}
