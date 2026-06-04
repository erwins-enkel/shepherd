import { test, expect } from "bun:test";
import { maintenance } from "../src/maintenance";

test("starts inactive", () => {
  expect(maintenance.active).toBe(false);
});

test("begin() activates, end() deactivates", () => {
  maintenance.begin();
  expect(maintenance.active).toBe(true);
  maintenance.end();
  expect(maintenance.active).toBe(false);
});

test("emits change only on an actual transition", () => {
  const seen: boolean[] = [];
  const off = maintenance.on("change", (v: boolean) => seen.push(v));
  maintenance.begin();
  maintenance.begin(); // already active → no second emit
  maintenance.end();
  maintenance.end(); // already inactive → no second emit
  off();
  expect(seen).toEqual([true, false]);
});
