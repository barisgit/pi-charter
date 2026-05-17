#!/usr/bin/env bun

import { listAllCharters, buildPickerSnapshot, type PickerSnapshot } from "../src/ui/picker-snapshot";
import { CharterPickerComponent } from "../src/ui/charter-picker";

const cwd = process.cwd();
const charters = await listAllCharters(cwd);
if (charters.length < 2) {
  console.error("dogfood-picker: need ≥2 charters under .pi/charters/ (have", charters.length, ")");
  process.exit(1);
}
const snapshotPairs = await Promise.all(
  charters.slice(0, 5).map(async (c) => [c.charterId, await buildPickerSnapshot(cwd, c.charterId)] as const),
);
const validPairs = snapshotPairs.filter((pair): pair is readonly [string, PickerSnapshot] => pair[1] !== null);
if (validPairs.length < 1) {
  console.error("dogfood-picker: no buildable snapshots");
  process.exit(1);
}
const snapshots = new Map(validPairs);
const boundCharterId = "3704bd21-b5e7-4162-94e6-3f971e817527";
const theme = { fg: (_color: string, text: string) => text };
const component = new CharterPickerComponent({
  charters,
  snapshots,
  theme,
  heightProvider: () => 40,
  initialCursorCharterId: boundCharterId,
  boundCharterId,
  onDone: () => {},
});

console.log("=== listAllCharters ===");
console.log(JSON.stringify(charters, null, 2));
console.log("\n=== picker render (folded) ===");
for (const line of component.render(160)) console.log(line);
component.handleInput?.("\t");
component.handleInput?.(" ");
console.log("\n=== picker render (expanded) ===");
for (const line of component.render(160)) console.log(line);
process.exit(0);
