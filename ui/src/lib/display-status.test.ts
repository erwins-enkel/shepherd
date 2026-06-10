import { test, expect } from "vitest";
import { displayStatus } from "./display-status";
import type { SessionStatus } from "./types";

const s = (id: string, status: SessionStatus) => ({ id, status });

test("blocked + working-blocked flag upgrades to running (full working treatment)", () => {
  expect(displayStatus(s("s1", "blocked"), { s1: true })).toBe("running");
});

test("blocked without a flag stays blocked", () => {
  expect(displayStatus(s("s1", "blocked"), {})).toBe("blocked");
  expect(displayStatus(s("s1", "blocked"), { other: true })).toBe("blocked");
});

test("a stale flag on a non-blocked session is inert", () => {
  for (const status of ["running", "idle", "done", "archived"] as const) {
    expect(displayStatus(s("s1", status), { s1: true })).toBe(status);
  }
});

test("an explicit false flag reads the same as absent", () => {
  expect(displayStatus(s("s1", "blocked"), { s1: false })).toBe("blocked");
});
