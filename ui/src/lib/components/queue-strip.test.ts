import { describe, it, expect } from "vitest";
import { enabledDrains, pausedText } from "./queue-strip";
import type { DrainStatus } from "../types";

function drain(over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath: "/repos/a",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 1,
    ...over,
  };
}

describe("enabledDrains", () => {
  it("drops disabled repos and sorts by path", () => {
    const rows = enabledDrains({
      z: drain({ repoPath: "/repos/z" }),
      a: drain({ repoPath: "/repos/a" }),
      off: drain({ repoPath: "/repos/b", enabled: false }),
    });
    expect(rows.map((d) => d.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });

  it("returns an empty list when nothing is enabled", () => {
    expect(enabledDrains({ a: drain({ enabled: false }) })).toEqual([]);
  });
});

describe("pausedText", () => {
  it("maps blocked with its designation", () => {
    expect(pausedText(drain({ paused: true, reason: "blocked", detail: "TASK-07" }))).toContain(
      "TASK-07",
    );
  });
  it("maps usage with its percentage", () => {
    expect(pausedText(drain({ paused: true, reason: "usage", detail: "80" }))).toContain("80");
  });
  it("falls back to the generic line for an unknown reason", () => {
    const generic = pausedText(drain({ paused: true, reason: null }));
    expect(generic).toBe(pausedText(drain({ paused: true, reason: "something-else" })));
    expect(generic.length).toBeGreaterThan(0);
  });
  it("maps changes_requested to drain_paused_changes", () => {
    const text = pausedText(drain({ paused: true, reason: "changes_requested", detail: null }));
    expect(text.length).toBeGreaterThan(0);
    // must differ from the generic fallback so it's actually the correct branch
    expect(text).not.toBe(pausedText(drain({ paused: true, reason: null })));
  });
  it("maps error to drain_paused_error", () => {
    const text = pausedText(drain({ paused: true, reason: "error", detail: null }));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe(pausedText(drain({ paused: true, reason: null })));
  });
  it("does not throw when detail is null", () => {
    expect(() =>
      pausedText(drain({ paused: true, reason: "blocked", detail: null })),
    ).not.toThrow();
    expect(
      pausedText(drain({ paused: true, reason: "blocked", detail: null })).length,
    ).toBeGreaterThan(0);
  });
});
