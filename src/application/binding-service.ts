/**
 * Session binding for pi-charter.
 *
 * Forward: `state.json.sessionId` (lives in <project>/.pi/charters/<charterId>/state.json).
 * Reverse: `<homeDir>/.pi/agent/sessions/<sessionId>/charter.json` ->
 *          `{ sessionId, charterId, projectDir, boundAt }`.
 *
 * Both pointers are written atomically so a partial restore or crash can be
 * reconciled by `reconcileSessionBinding(sessionId)`: if the reverse pointer
 * exists but the forward pointer is missing or stale, restore the forward one
 * from the reverse record.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { charterDir, loadCharterState, writeCharterState } from "../infrastructure/store";

export interface SessionBindingRecord {
  sessionId: string;
  charterId: string;
  projectDir: string;
  boundAt: string;
}

interface BindInput {
  charterId: string;
  sessionId: string;
  homeDir?: string;
  now?: string;
}

function resolveHome(homeDir?: string): string {
  return homeDir ?? homedir();
}

function reversePath(homeDir: string, sessionId: string): string {
  return join(homeDir, ".pi/agent/sessions", sessionId, "charter.json");
}

async function writeReverse(homeDir: string, record: SessionBindingRecord): Promise<void> {
  const path = reversePath(homeDir, record.sessionId);
  await mkdir(join(homeDir, ".pi/agent/sessions", record.sessionId), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

async function removeReverse(homeDir: string, sessionId: string): Promise<void> {
  const dir = join(homeDir, ".pi/agent/sessions", sessionId);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Remove the reverse session pointer for `sessionId`. Used by the widget
 * host when it discovers a stale binding whose forward state.json no longer
 * exists (e.g. the user `rm -rf`'d the charter dir).
 */
export async function clearSessionBinding(sessionId: string, homeDir?: string): Promise<void> {
  const home = resolveHome(homeDir);
  await removeReverse(home, sessionId);
}

export async function bindCharterToSession(projectDir: string, input: BindInput): Promise<SessionBindingRecord> {
  if (!input.sessionId.trim()) throw new Error("bindCharterToSession requires a non-empty sessionId.");
  const home = resolveHome(input.homeDir);
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  const now = input.now ?? new Date().toISOString();
  state.sessionId = input.sessionId;
  state.updatedAt = now;
  await writeCharterState(dir, state);
  const record: SessionBindingRecord = {
    sessionId: input.sessionId,
    charterId: input.charterId,
    projectDir,
    boundAt: now,
  };
  await writeReverse(home, record);
  return record;
}

export async function rebindCharter(projectDir: string, input: BindInput): Promise<SessionBindingRecord> {
  const home = resolveHome(input.homeDir);
  const dir = charterDir(projectDir, input.charterId);
  const state = await loadCharterState(dir);
  const previousSessionId = state.sessionId;
  const result = await bindCharterToSession(projectDir, input);
  if (previousSessionId && previousSessionId !== input.sessionId) {
    await removeReverse(home, previousSessionId);
  }
  return result;
}

export async function readSessionBinding(input: {
  sessionId: string;
  homeDir?: string;
}): Promise<SessionBindingRecord | null> {
  const home = resolveHome(input.homeDir);
  const path = reversePath(home, input.sessionId);
  try {
    await stat(path);
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as SessionBindingRecord;
    if (!raw.sessionId || !raw.charterId || !raw.projectDir) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Typed structured error thrown by `resolveCharterId` when neither an
 * explicit `charterId` argument nor a session reverse binding is available.
 *
 * Shape is intentionally an Error subtype with extra fields so callers can
 * `instanceof` check, grep for the literal phrase `"no charter bound"` in
 * logs, and read a stable `code` / `hint` programmatically without parsing
 * the message string.
 */
export class NoCharterBoundError extends Error {
  readonly code = "NO_CHARTER_BOUND" as const;
  readonly hint: string;
  constructor(
    message = "no charter bound to this session",
    hint = "Call charter_manage action=create to start one, or rebind this session via session_start.",
  ) {
    super(message);
    this.name = "NoCharterBoundError";
    this.hint = hint;
  }
}

/**
 * Resolve a charter id from an explicit tool argument or the session's
 * reverse binding (`<homeDir>/.pi/agent/sessions/<sid>/charter.json`).
 *
 * Returns `{ charterId, source }` so callers can distinguish an explicit
 * pass-through (`"argument"`) from a defaulted resolution (`"binding"`).
 * Throws `NoCharterBoundError` when neither path produces a charterId; the
 * error message contains the literal phrase `"no charter bound"` so the
 * VAL-2 grep test and operator log searches work without coupling to the
 * exact wording elsewhere in the codebase.
 */
export async function resolveCharterId(
  input: { charterId?: string },
  ctx: { sessionId?: string; homeDir?: string },
): Promise<{ charterId: string; source: "argument" | "binding" }> {
  const explicit = input.charterId?.trim();
  if (explicit) return { charterId: explicit, source: "argument" };
  if (ctx.sessionId) {
    const binding = await readSessionBinding({ sessionId: ctx.sessionId, homeDir: ctx.homeDir });
    if (binding?.charterId) return { charterId: binding.charterId, source: "binding" };
  }
  throw new NoCharterBoundError();
}

export async function reconcileSessionBinding(input: {
  sessionId: string;
  homeDir?: string;
  now?: string;
}): Promise<SessionBindingRecord | null> {
  const record = await readSessionBinding(input);
  if (!record) return null;
  const dir = charterDir(record.projectDir, record.charterId);
  try {
    const state = await loadCharterState(dir);
    if (state.sessionId !== input.sessionId) {
      state.sessionId = input.sessionId;
      state.updatedAt = input.now ?? new Date().toISOString();
      await writeCharterState(dir, state);
    }
    return record;
  } catch {
    return null;
  }
}
