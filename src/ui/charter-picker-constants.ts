import type { CharterStatus } from "../domain/types";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
]);

export const MIN_LEFT_PANE = 20;
export const LEFT_PANE_CAP = 110;
export const MIN_RIGHT_PANE = 24;
export const DEFAULT_LEFT_FRACTION = 0.32;
export const SPLIT_STEP_COLS = 4;
export const BANNED_PRINTABLE = new Set(["b", "r", "p", "a", "c", "o"]);
export const FLASH_TTL_RENDERS = 6;
