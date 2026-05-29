import { expect, test } from "bun:test";

test("fixture matched failure", () => {
  expect(1).toBe(2);
});
