import { describe, it, expect } from "vitest";
import { chipFor, epicHoldLine, progress, stateLabel } from "./epic-panel";
import type { DrainStatus } from "$lib/types";

function drain(over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath: "/r",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 3,
    epicParent: 42,
    ...over,
  };
}
const READY = [{ state: "ready" }, { state: "ready" }] as const;

describe("epic-panel helpers", () => {
  it("chipFor maps state → tone", () => {
    expect(chipFor("merged").tone).toBe("done");
    expect(chipFor("ready").tone).toBe("ready");
    expect(chipFor("blocked").tone).toBe("muted");
    expect(chipFor("in-review").tone).toBe("review");
    expect(chipFor("running").tone).toBe("running");
  });
  it("progress counts merged/total", () => {
    expect(progress([{ state: "merged" }, { state: "ready" }] as never)).toEqual({
      merged: 1,
      total: 2,
    });
  });
  it("stateLabel returns a non-empty string for all 5 states", () => {
    const states = ["merged", "in-review", "running", "ready", "blocked"] as const;
    for (const s of states) {
      expect(stateLabel(s)).toBeTruthy();
    }
  });
});

describe("epicHoldLine", () => {
  // #1757: the forge's ensureBranch threw, so no child can be based on the epic branch. `detail`
  // carries the BRANCH (not a desig) — without a case here the epic panel would render nothing for
  // a genuinely actionable, self-healing stall.
  it("epic_base_unavailable names the integration branch", () => {
    const line = epicHoldLine(
      drain({ reason: "epic_base_unavailable", detail: "epic/1757-critic" }),
      true,
      [...READY],
    );
    expect(line).toContain("epic/1757-critic");
  });

  it("returns null when not running / no drain / actively spawning (reason null)", () => {
    expect(epicHoldLine(drain({ reason: "cap" }), false, [...READY])).toBeNull();
    expect(epicHoldLine(null, true, [...READY])).toBeNull();
    expect(epicHoldLine(drain({ reason: null }), true, [...READY])).toBeNull();
  });

  it("trouble reasons name the session desig and say new starts are paused", () => {
    for (const reason of ["blocked", "changes_requested", "error"] as const) {
      const line = epicHoldLine(drain({ reason, detail: "TASK-07" }), true, [...READY])!;
      expect(line).toContain("TASK-07");
      expect(line.toLowerCase()).toContain("paused");
    }
  });

  it("cap reports inFlight/max, not 'one at a time'", () => {
    const line = epicHoldLine(drain({ reason: "cap", inFlight: 3, max: 3 }), true, [...READY])!;
    expect(line).toContain("3/3");
    expect(line.toLowerCase()).not.toContain("one child at a time");
  });

  it("awaiting_* carry the identifier from detail", () => {
    expect(
      epicHoldLine(drain({ reason: "awaiting_approval", detail: "51" }), true, [...READY]),
    ).toContain("51");
    expect(
      epicHoldLine(drain({ reason: "awaiting_signoff", detail: "TASK-09" }), true, [...READY]),
    ).toContain("TASK-09");
  });

  it("usage delegates to the repo-wide paused banner (carries the pct)", () => {
    expect(
      epicHoldLine(drain({ reason: "usage", detail: "92", paused: true }), true, [...READY]),
    ).toContain("92");
  });

  it("empty is progress-aware: in-flight vs genuinely idle read differently", () => {
    const inflight = epicHoldLine(drain({ reason: "empty" }), true, [
      { state: "running" },
      { state: "blocked" },
    ]);
    const idle = epicHoldLine(drain({ reason: "empty" }), true, [
      { state: "blocked" },
      { state: "blocked" },
    ]);
    expect(inflight).toBeTruthy();
    expect(idle).toBeTruthy();
    expect(inflight).not.toBe(idle);
  });

  it("disabled renders its own line", () => {
    expect(
      epicHoldLine(drain({ reason: "disabled", enabled: false }), true, [...READY]),
    ).toBeTruthy();
  });
});
