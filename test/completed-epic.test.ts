import { describe, expect, it } from "bun:test";
import { buildRollup } from "../src/completed-epic";

describe("buildRollup", () => {
  it("child WITH detail row → integrated true, PR facts from row", () => {
    const children = [{ number: 1, title: "Fix auth", url: "https://gh/issues/1" }];
    const details = [{ childNumber: 1, prNumber: 42, prUrl: "https://gh/pull/42", mergedAt: 1000 }];
    const result = buildRollup(children, details);
    expect(result).toEqual([
      {
        number: 1,
        title: "Fix auth",
        url: "https://gh/issues/1",
        prNumber: 42,
        prUrl: "https://gh/pull/42",
        mergedAt: 1000,
        integrated: true,
      },
    ]);
  });

  it("child WITHOUT detail row → integrated false, PR/mergedAt null, number/title/url present", () => {
    const children = [{ number: 5, title: "Closed out-of-band", url: "https://gh/issues/5" }];
    const result = buildRollup(children, []);
    expect(result).toEqual([
      {
        number: 5,
        title: "Closed out-of-band",
        url: "https://gh/issues/5",
        prNumber: null,
        prUrl: null,
        mergedAt: null,
        integrated: false,
      },
    ]);
  });

  it("mixed epic (#327 shape): 6 children, 3 with detail rows, 3 without", () => {
    const children = [
      { number: 320, title: "Task A", url: "https://gh/issues/320" },
      { number: 321, title: "Task B", url: "https://gh/issues/321" },
      { number: 322, title: "Task C", url: "https://gh/issues/322" },
      { number: 323, title: "Task D", url: "https://gh/issues/323" },
      { number: 324, title: "Task E", url: "https://gh/issues/324" },
      { number: 325, title: "Task F", url: "https://gh/issues/325" },
    ];
    const details = [
      { childNumber: 322, prNumber: 101, prUrl: "https://gh/pull/101", mergedAt: 2000 },
      { childNumber: 323, prNumber: 102, prUrl: "https://gh/pull/102", mergedAt: 2001 },
      { childNumber: 325, prNumber: 103, prUrl: "https://gh/pull/103", mergedAt: 2002 },
    ];
    const result = buildRollup(children, details);

    const integrated = result.filter((c) => c.integrated);
    const notIntegrated = result.filter((c) => !c.integrated);

    expect(integrated).toHaveLength(3);
    expect(notIntegrated).toHaveLength(3);

    expect(integrated.map((c) => c.number)).toEqual([322, 323, 325]);
    expect(integrated.map((c) => c.prNumber)).toEqual([101, 102, 103]);
    expect(integrated.map((c) => c.prUrl)).toEqual([
      "https://gh/pull/101",
      "https://gh/pull/102",
      "https://gh/pull/103",
    ]);
    expect(integrated.map((c) => c.mergedAt)).toEqual([2000, 2001, 2002]);

    expect(notIntegrated.map((c) => c.number)).toEqual([320, 321, 324]);
    expect(notIntegrated.every((c) => c.prNumber === null)).toBe(true);
    expect(notIntegrated.every((c) => c.prUrl === null)).toBe(true);
    expect(notIntegrated.every((c) => c.mergedAt === null)).toBe(true);

    // output order matches input order
    expect(result.map((c) => c.number)).toEqual([320, 321, 322, 323, 324, 325]);
  });

  it("detail row with null prNumber/prUrl (legacy row) → integrated true, mergedAt present", () => {
    const children = [{ number: 10, title: "Legacy task", url: "https://gh/issues/10" }];
    const details = [{ childNumber: 10, prNumber: null, prUrl: null, mergedAt: 5000 }];
    const result = buildRollup(children, details);
    expect(result).toEqual([
      {
        number: 10,
        title: "Legacy task",
        url: "https://gh/issues/10",
        prNumber: null,
        prUrl: null,
        mergedAt: 5000,
        integrated: true,
      },
    ]);
  });

  it("order preservation: output order matches input child order regardless of detail order", () => {
    const children = [
      { number: 3, title: "C", url: "u3" },
      { number: 1, title: "A", url: "u1" },
      { number: 2, title: "B", url: "u2" },
    ];
    const details = [
      { childNumber: 1, prNumber: 10, prUrl: "p1", mergedAt: 100 },
      { childNumber: 3, prNumber: 30, prUrl: "p3", mergedAt: 300 },
    ];
    const result = buildRollup(children, details);
    expect(result.map((c) => c.number)).toEqual([3, 1, 2]);
    expect(result.at(0)?.integrated).toBe(true);
    expect(result.at(1)?.integrated).toBe(true);
    expect(result.at(2)?.integrated).toBe(false);
  });
});
