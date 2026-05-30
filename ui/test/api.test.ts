import { test, expect } from "vitest";
import { elapsed, statusLabel } from "../src/lib/format";

test("elapsed formats mm:ss", () => {
  expect(elapsed(0, 194_000)).toBe("03:14");
  expect(elapsed(0, 0)).toBe("00:00");
});

test("statusLabel maps running→WORKING", () => {
  expect(statusLabel("running")).toBe("WORKING");
  expect(statusLabel("blocked")).toBe("BLOCKED");
});
