import { describe, it, expect } from "vitest";
import { autoMergeView, elapsedMinutes, waitCodeFor, waitOwner } from "./auto-merge-banner";
import type { AutoMergeStatus, MergeWaitCode } from "./types";

const status = (waiting: AutoMergeStatus["waiting"]): AutoMergeStatus => ({
  repoPath: "/r",
  enabled: true,
  state: null,
  detail: null,
  sessionId: null,
  waiting,
});

const input = (code: MergeWaitCode | null, over: Record<string, unknown> = {}) => ({
  status: status(code ? [{ sessionId: "s1", code }] : []),
  sessionId: "s1",
  criticRunning: false,
  autoAddressOn: false,
  stripTaken: false,
  ...over,
});

describe("waitCodeFor", () => {
  it("finds this session's code and ignores others", () => {
    const st = status([
      { sessionId: "s2", code: "behind" },
      { sessionId: "s1", code: "checks_pending" },
    ]);
    expect(waitCodeFor(st, "s1")).toBe("checks_pending");
    expect(waitCodeFor(st, "s3")).toBeNull();
  });

  it("is null without a status or a waiting list (older server)", () => {
    expect(waitCodeFor(null, "s1")).toBeNull();
    expect(waitCodeFor({ ...status([]), waiting: undefined }, "s1")).toBeNull();
  });
});

describe("waitOwner", () => {
  it.each<MergeWaitCode>([
    "critic_pending",
    "checks_pending",
    "checks_failed",
    "behind",
    "conflict",
    "not_mergeable",
  ])("%s is Shepherd's", (code) => expect(waitOwner(code, false)).toBe("shepherd"));

  it.each<MergeWaitCode>([
    "critic_error",
    "rebase_cap",
    "merge_backoff",
    "manual_steps",
    "stacked",
    "signoff",
  ])("%s needs the operator", (code) => expect(waitOwner(code, true)).toBe("operator"));

  it("critic findings are Shepherd's only under auto-address", () => {
    expect(waitOwner("changes_requested", true)).toBe("shepherd");
    expect(waitOwner("changes_requested", false)).toBe("operator");
  });
});

describe("autoMergeView", () => {
  it("hides and does not dim when the train doesn't hold this PR", () => {
    expect(autoMergeView(input(null))).toEqual({ code: null, show: false, owned: false });
  });

  it("a running critic on a pending verdict owns the PR", () => {
    expect(autoMergeView(input("critic_pending", { criticRunning: true }))).toEqual({
      code: "critic_pending",
      owner: "shepherd",
      show: true,
      owned: true,
    });
  });

  it("a pending verdict with no critic running shows the strip but never dims", () => {
    const v = autoMergeView(input("critic_pending"));
    expect(v.show).toBe(true);
    expect(v.owned).toBe(false);
  });

  it("operator codes show without dimming", () => {
    expect(autoMergeView(input("critic_error"))).toMatchObject({ owner: "operator", owned: false });
  });

  it("yields the strip to the review / CI banner but keeps dimming", () => {
    expect(autoMergeView(input("checks_pending", { stripTaken: true }))).toMatchObject({
      show: false,
      owned: true,
    });
  });
});

describe("elapsedMinutes", () => {
  it("floors to whole minutes and never goes negative", () => {
    expect(elapsedMinutes(0, 59_999)).toBe(0);
    expect(elapsedMinutes(0, 3 * 60_000 + 5_000)).toBe(3);
    expect(elapsedMinutes(10_000, 0)).toBe(0);
  });
});
