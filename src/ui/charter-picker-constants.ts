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
export const BANNED_PRINTABLE = new Set(["b", "r", "p", "a", "c"]);
export const FLASH_TTL_RENDERS = 6;

export const LEFT_ROW_PREFIX_W = 3;
export const LEFT_ROW_BAR_W = 8;
export const LEFT_ROW_COUNT_W = 7; // fits up to "999/999"
export const LEFT_ROW_GAP_BAR_COUNT = 1;
export const LEFT_ROW_GAP_COUNT_STATUS = 2;
export const LEFT_ROW_MIN_NAME_W = 4;
export const LEFT_ROW_BAR_MIN_NAME_W = 14;
