import type { CharterStatus } from "../domain/types";

export const TERMINAL_STATUSES: ReadonlySet<CharterStatus> = new Set<CharterStatus>([
  "completed",
  "abandoned",
  "budget_limited",
]);

// Shared legend lives in the left pane's third section. Only the keys that work
// regardless of focus belong here; pane-specific keys (`space`, `o`) go in the
// right pane's bottom-border footer so users see them where they apply.
export const LEGEND_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["j/k",        "move cursor"],
  ["pgup/pgdn",  "jump a page"],
  ["g / G",      "top / end"],
  ["tab",        "switch pane"],
  ["[ / ]",      "resize split"],
  ["s",          "toggle sidebar"],
  ["O",          "open charter dir"],
  ["y",          "copy charterId"],
  ["esc",        "close picker"],
];
export const LEGEND_KEY_W = 10;

// Right-pane-only keybind hint, embedded in the right bottom-border segment.
export const RIGHT_PANE_HINT = "space:fold  o:obj  s:sidebar";
export const LEFT_FOOTER = "j/k  pgup/pgdn  g/G  esc";
export const RIGHT_FOOTER = "j/k  space:fold  o:obj  O:dir  y:id";

export const PAGE_SIZE = 10;
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
