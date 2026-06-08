import { describe, it, expect } from "vitest";
import {
  activeMergeTrain,
  enabledDrains,
  mergeTrainIsAttention,
  mergeTrainLabel,
  pausedText,
  queueOpenable,
} from "./queue-strip";
import type { AutoMergeStatus, DrainStatus } from "../types";

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

describe("queueOpenable", () => {
  it("is true when items are queued", () => {
    expect(queueOpenable(drain({ queued: 3 }))).toBe(true);
  });
  it("is false when the queue is empty", () => {
    expect(queueOpenable(drain({ queued: 0 }))).toBe(false);
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

// ─── merge-train helpers ───────────────────────────────────────────────────

function am(over: Partial<AutoMergeStatus>): AutoMergeStatus {
  return {
    repoPath: "/repos/a",
    enabled: true,
    state: null,
    detail: null,
    sessionId: null,
    ...over,
  };
}

describe("activeMergeTrain", () => {
  it("drops idle (null-state) entries", () => {
    expect(activeMergeTrain({ a: am({ state: null }) })).toEqual([]);
  });

  it("keeps non-null states and sorts by path", () => {
    const rows = activeMergeTrain({
      z: am({ repoPath: "/repos/z", state: "merging" }),
      a: am({ repoPath: "/repos/a", state: "rebasing" }),
      idle: am({ repoPath: "/repos/idle", state: null }),
    });
    expect(rows.map((r) => r.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });

  it("returns empty list for empty record", () => {
    expect(activeMergeTrain({})).toEqual([]);
  });
});

describe("mergeTrainIsAttention", () => {
  it("flags merge_error as attention", () => {
    expect(mergeTrainIsAttention("merge_error")).toBe(true);
  });
  it("flags rebase_cap as attention", () => {
    expect(mergeTrainIsAttention("rebase_cap")).toBe(true);
  });
  it("does not flag merging as attention", () => {
    expect(mergeTrainIsAttention("merging")).toBe(false);
  });
  it("does not flag rebasing as attention", () => {
    expect(mergeTrainIsAttention("rebasing")).toBe(false);
  });
});

describe("mergeTrainLabel", () => {
  it("returns non-empty string for merging", () => {
    expect(mergeTrainLabel("merging").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for rebasing", () => {
    expect(mergeTrainLabel("rebasing").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for merge_error", () => {
    expect(mergeTrainLabel("merge_error").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for rebase_cap", () => {
    expect(mergeTrainLabel("rebase_cap").length).toBeGreaterThan(0);
  });
  it("returns empty string for null (idle)", () => {
    expect(mergeTrainLabel(null)).toBe("");
  });
  it("returns empty string for unknown state", () => {
    expect(mergeTrainLabel("something-else")).toBe("");
  });
  it("merge_error label differs from merging label", () => {
    expect(mergeTrainLabel("merge_error")).not.toBe(mergeTrainLabel("merging"));
  });
});
