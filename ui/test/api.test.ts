import { test, expect } from "vitest";
import { elapsed, statusLabel } from "../src/lib/format";

test("elapsed shows mm:ss under an hour", () => {
  expect(elapsed(0, 0)).toBe("00:00");
  expect(elapsed(0, 44_000)).toBe("00:44");
  expect(elapsed(0, 194_000)).toBe("03:14");
  expect(elapsed(0, 3_599_000)).toBe("59:59");
});

test("elapsed drops seconds and shows Hh MMm from one hour", () => {
  expect(elapsed(0, 3_600_000)).toBe("1h 00m");
  expect(elapsed(0, 18_194_000)).toBe("5h 03m");
  expect(elapsed(0, 86_399_000)).toBe("23h 59m");
});

test("elapsed shows Dd HHh from one day", () => {
  expect(elapsed(0, 86_400_000)).toBe("1d 00h");
  expect(elapsed(0, 190_980_000)).toBe("2d 05h");
  expect(elapsed(0, 1_201_200_000)).toBe("13d 21h");
});

test("statusLabel maps running→BUSY", () => {
  expect(statusLabel("running")).toBe("BUSY");
  expect(statusLabel("blocked")).toBe("BLOCKED");
});
