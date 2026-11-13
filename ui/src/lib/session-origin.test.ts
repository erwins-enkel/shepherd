import { describe, expect, test } from "vitest";
import type { Session } from "./types";
import { byOrigin, originCounts, originFilterOffered, sessionOrigin } from "./session-origin";

const s = (id: string, auto: boolean, scheduleId: string | null = null) =>
  ({ id, auto, scheduleId }) as Session;

const list = [
  s("m1", false),
  s("d1", true),
  s("sch1", false, "x"),
  s("sch2", true, "y"),
  s("m2", false),
];

describe("sessionOrigin", () => {
  test("scheduleId wins over auto", () => {
    expect(sessionOrigin(s("a", true, "x"))).toBe("scheduled");
  });
  test("auto without schedule is drain, rest manual", () => {
    expect(sessionOrigin(s("a", true))).toBe("drain");
    expect(sessionOrigin(s("a", false))).toBe("manual");
    expect(sessionOrigin({ auto: false })).toBe("manual");
  });
});

describe("byOrigin", () => {
  test("null keeps the list", () => {
    expect(byOrigin(list, null)).toBe(list);
  });
  test("narrows to one origin", () => {
    expect(byOrigin(list, "scheduled").map((x) => x.id)).toEqual(["sch1", "sch2"]);
    expect(byOrigin(list, "drain").map((x) => x.id)).toEqual(["d1"]);
    expect(byOrigin(list, "manual").map((x) => x.id)).toEqual(["m1", "m2"]);
  });
});

test("originCounts tallies each origin", () => {
  expect(originCounts(list)).toEqual({ scheduled: 2, drain: 1, manual: 2 });
  expect(originCounts([])).toEqual({ scheduled: 0, drain: 0, manual: 0 });
});

describe("originFilterOffered", () => {
  const c = (scheduled: number, drain: number, manual: number) => ({ scheduled, drain, manual });
  test("needs a non-manual session or an active filter", () => {
    expect(originFilterOffered("all", null, c(0, 0, 3))).toBe(false);
    expect(originFilterOffered("all", null, c(1, 0, 0))).toBe(true);
    expect(originFilterOffered("ready", null, c(0, 2, 0))).toBe(true);
    expect(originFilterOffered("done", "manual", c(0, 0, 0))).toBe(true);
  });
  test("never on panel-only lenses", () => {
    expect(originFilterOffered("next", "drain", c(1, 1, 1))).toBe(false);
    expect(originFilterOffered("owed", null, c(1, 1, 1))).toBe(false);
  });
});
