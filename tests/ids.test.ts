import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { generateCharterId, resolveCharterId, slugFromObjective } from "../src/domain/ids";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-charter-ids-"));
}

describe("charter ids", () => {
  test("slugifies objectives", () => {
    expect(slugFromObjective("Ship ADR 0014: File as Interface!!!")).toBe("ship-adr-0014-file-as-interface");
    expect(slugFromObjective("---")).toBe("charter");
    expect(slugFromObjective("A very long objective that should be clipped around thirty two chars")).toBe("a-very-long-objective-that-shoul");
  });

  test("generates timestamp ids and collision suffixes", async () => {
    const root = await tempRoot();
    const now = new Date("2026-07-02T03:04:05.000Z");
    const first = await generateCharterId({ root, objective: "Ship runtime", now });
    expect(first).toBe("20260702-030405-ship-runtime");
    await mkdir(join(root, first), { recursive: true });
    await mkdir(join(root, `${first}-2`), { recursive: true });
    const next = await generateCharterId({ root, objective: "Ship runtime", now });
    expect(next).toBe(`${first}-3`);
  });

  test("resolves exact id, unique prefix, and unique slug fragment", async () => {
    const root = await tempRoot();
    const a = "20260702-030405-ship-runtime";
    const b = "20260702-040506-fix-parser";
    await mkdir(join(root, a), { recursive: true });
    await mkdir(join(root, b), { recursive: true });
    expect(await resolveCharterId(root, a)).toBe(a);
    expect(await resolveCharterId(root, "20260702-04")).toBe(b);
    expect(await resolveCharterId(root, "parser")).toBe(b);
    await expect(resolveCharterId(root, "20260702")).rejects.toThrow("Ambiguous");
  });
});
