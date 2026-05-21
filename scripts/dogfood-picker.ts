#!/usr/bin/env bun

import { listAllCharters, buildPickerSnapshot, type PickerSnapshot } from "../src/ui/picker-snapshot";
import { CharterPickerComponent } from "../src/ui/charter-picker";
import { logger } from "../src/infrastructure/logger";

const cwd = process.cwd();
const charters = await listAllCharters(cwd);
if (charters.length < 2) {
  logger.error("dogfood-picker: need at least 2 charters under .pi/charters", undefined, { count: charters.length });
  process.exit(1);
}
const snapshotPairs = await Promise.all(
  charters.slice(0, 5).map(async (c) => [c.charterId, await buildPickerSnapshot(cwd, c.charterId)] as const),
);
const validPairs = snapshotPairs.filter((pair): pair is readonly [string, PickerSnapshot] => pair[1] !== null);
if (validPairs.length < 1) {
  logger.error("dogfood-picker: no buildable snapshots");
  process.exit(1);
}
const snapshots = new Map(validPairs);
const boundCharterId = "3704bd21-b5e7-4162-94e6-3f971e817527";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const component = new CharterPickerComponent({
  charters,
  snapshots,
  theme,
  heightProvider: () => 40,
  initialCursorCharterId: boundCharterId,
  boundCharterId,
  onDone: () => {},
});

logger.info("dogfood-picker render", {
  section: "listAllCharters",
  charters,
});
logger.info("dogfood-picker render", {
  section: "picker render (folded)",
  lines: component.render(160),
});
component.handleInput?.("\t");
component.handleInput?.(" ");
logger.info("dogfood-picker render", {
  section: "picker render (expanded)",
  lines: component.render(160),
});
process.exit(0);
