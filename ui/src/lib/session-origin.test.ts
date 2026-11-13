import { describe, expect, test } from "vitest";
import type { Session } from "./types";
import { byOrigin, originCounts, sessionOrigin } from "./session-origin";

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
