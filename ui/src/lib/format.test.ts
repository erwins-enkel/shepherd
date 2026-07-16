import { describe, it, expect } from "vitest";
import {
  hideStatusBadge,
  autopilotBadgeShown,
  relativeAge,
  formatAgo,
  formatResetIn,
  heartbeatTone,
  canResume,
  canRelaunch,
  canReplaceAgent,
  waitTier,
} from "./format";
import type { Session, SessionStatus, GitState } from "./types";

describe("canResume", () => {
  const session = (over: Partial<Session>): Session =>
    ({ claudeSessionId: "c-1", status: "idle", ...over }) as Session;

  it("offers Resume for idle/done with a pinned claude id", () => {
    expect(canResume(session({ status: "idle" }))).toBe(true);
    expect(canResume(session({ status: "done" }))).toBe(true);
  });

  it("offers Resume for idle/done codex sessions without a claude id", () => {
    expect(
      canResume(session({ agentProvider: "codex", claudeSessionId: "", status: "idle" })),
    ).toBe(true);
    expect(
      canResume(session({ agentProvider: "codex", claudeSessionId: "", status: "done" })),
    ).toBe(true);
  });

  it("never offers without a pinned claude id or while live (running/blocked)", () => {
    expect(canResume(session({ claudeSessionId: "" }))).toBe(false);
    expect(canResume(session({ status: "running" }))).toBe(false);
    expect(canResume(session({ status: "blocked" }))).toBe(false);
  });

  it("hides Resume when the agent is verifiably alive", () => {
    expect(canResume(session({}), "alive")).toBe(false);
  });

  it("keeps offering when liveness is unknown or the agent is gone (husk/stranded)", () => {
    expect(canResume(session({}), undefined)).toBe(true);
    expect(canResume(session({}), "husk")).toBe(true);
    expect(canResume(session({}), "stranded")).toBe(true);
  });
});

describe("canRelaunch", () => {
  const now = 1_000_000_000_000;
  const session = (over: Partial<Session>): Session =>
    ({
      status: "running",
      readyToMerge: false,
      autopilotComplete: false,
      mergingSince: null,
      ...over,
    }) as Session;

  it("offers Relaunch for an in-flight task (any non-concluded status)", () => {
    expect(canRelaunch(session({ status: "running" }), undefined, now)).toBe(true);
    expect(canRelaunch(session({ status: "idle" }), undefined, now)).toBe(true);
    expect(canRelaunch(session({ status: "blocked" }), undefined, now)).toBe(true);
    expect(canRelaunch(session({ status: "done" }), undefined, now)).toBe(true);
  });

  it("offers Relaunch for an open or closed-unmerged PR (still in flight)", () => {
    expect(canRelaunch(session({}), { state: "open" } as GitState, now)).toBe(true);
    expect(canRelaunch(session({}), { state: "closed" } as GitState, now)).toBe(true);
    expect(canRelaunch(session({}), { state: "none" } as GitState, now)).toBe(true);
  });

  it("withholds Relaunch from a concluded task — would duplicate + tear down the record", () => {
    expect(canRelaunch(session({ readyToMerge: true }), undefined, now)).toBe(false);
    expect(canRelaunch(session({ autopilotComplete: true }), undefined, now)).toBe(false);
    expect(canRelaunch(session({}), { state: "merged" } as GitState, now)).toBe(false);
  });

  it("withholds Relaunch while mid-merge-train", () => {
    expect(canRelaunch(session({ mergingSince: now }), undefined, now)).toBe(false);
  });
});

describe("canReplaceAgent", () => {
  const now = 1_000_000_000_000;
  const session = (over: Partial<Session>): Session =>
    ({
      status: "running",
      readyToMerge: false,
      autopilotComplete: false,
      mergingSince: null,
      ...over,
    }) as Session;

  it("offers Continue with for in-flight statuses", () => {
    expect(canReplaceAgent(session({ status: "running" }), undefined, now)).toBe(true);
    expect(canReplaceAgent(session({ status: "idle" }), undefined, now)).toBe(true);
    expect(canReplaceAgent(session({ status: "blocked" }), undefined, now)).toBe(true);
    expect(canReplaceAgent(session({ status: "done" }), undefined, now)).toBe(true);
  });

  it("allows open or closed-unmerged PR sessions for in-place rework", () => {
    expect(canReplaceAgent(session({}), { state: "open" } as GitState, now)).toBe(true);
    expect(canReplaceAgent(session({}), { state: "closed" } as GitState, now)).toBe(true);
    expect(canReplaceAgent(session({}), { state: "none" } as GitState, now)).toBe(true);
  });

  it("withholds Continue with from concluded sessions", () => {
    expect(canReplaceAgent(session({ status: "archived" }), undefined, now)).toBe(false);
    expect(canReplaceAgent(session({ readyToMerge: true }), undefined, now)).toBe(false);
    expect(canReplaceAgent(session({ autopilotComplete: true }), undefined, now)).toBe(false);
    expect(canReplaceAgent(session({}), { state: "merged" } as GitState, now)).toBe(false);
  });

  it("withholds Continue with while mid-merge-train", () => {
    expect(canReplaceAgent(session({ mergingSince: now }), undefined, now)).toBe(false);
  });
});

describe("hideStatusBadge", () => {
  const cases: [SessionStatus, boolean, boolean, boolean][] = [
    // status, reviewing, autopilotShown, hidden
    ["done", true, false, true],
    ["idle", true, false, true],
    ["done", false, false, false],
    ["idle", false, false, false],
    ["running", true, false, false],
    ["running", false, false, false],
    ["blocked", true, false, false],
    ["blocked", false, false, false],
    ["archived", true, false, false],
    // autopilotShown cases
    ["done", false, true, true],
    ["idle", false, true, true],
    ["running", false, true, false],
    ["blocked", false, true, false],
    ["done", true, true, true],
  ];

  for (const [status, reviewing, autopilotShown, hidden] of cases) {
    it(`${status} + reviewing=${reviewing} + autopilotShown=${autopilotShown} → ${hidden ? "hidden" : "shown"}`, () =>
      expect(hideStatusBadge(status, reviewing, autopilotShown)).toBe(hidden));
  }
});

describe("autopilotBadgeShown", () => {
  const session = (over: Partial<Session>): Session =>
    ({
      autopilotPaused: false,
      autopilotComplete: false,
      autopilotEnabled: null,
      agentProvider: "claude",
      isolated: true,
      ...over,
    }) as Session;

  it("returns true when autopilotPaused", () =>
    expect(autopilotBadgeShown(session({ autopilotPaused: true }), false)).toBe(true));

  it("returns true when autopilotComplete", () =>
    expect(autopilotBadgeShown(session({ autopilotComplete: true }), false)).toBe(true));

  it("returns false when neither paused nor complete (claude)", () =>
    expect(autopilotBadgeShown(session({}), false)).toBe(false));

  // Codex non-isolated "unavailable" state — both explicit-true and inherited-default-ON.
  it("returns true for codex + non-isolated + autopilotEnabled=true", () =>
    expect(
      autopilotBadgeShown(
        session({ agentProvider: "codex", isolated: false, autopilotEnabled: true }),
        false,
      ),
    ).toBe(true));

  it("returns true for codex + non-isolated + inherited-default-ON (autopilotEnabled=null)", () =>
    expect(
      autopilotBadgeShown(
        session({ agentProvider: "codex", isolated: false, autopilotEnabled: null }),
        true, // repo default ON
      ),
    ).toBe(true));

  it("returns false for codex + isolated (autopilot available)", () =>
    expect(
      autopilotBadgeShown(
        session({ agentProvider: "codex", isolated: true, autopilotEnabled: true }),
        false,
      ),
    ).toBe(false));

  it("returns false for codex + non-isolated when autopilot resolves OFF", () =>
    expect(
      autopilotBadgeShown(
        session({ agentProvider: "codex", isolated: false, autopilotEnabled: null }),
        false, // repo default OFF, no override → not on → nothing to surface
      ),
    ).toBe(false));

  it("returns false for claude + non-isolated (guard is codex-only)", () =>
    expect(
      autopilotBadgeShown(
        session({ agentProvider: "claude", isolated: false, autopilotEnabled: true }),
        false,
      ),
    ).toBe(false));

  it("returns false for codex + non-isolated + research (directive suppressed at spawn)", () =>
    expect(
      autopilotBadgeShown(
        session({
          agentProvider: "codex",
          isolated: false,
          autopilotEnabled: true,
          research: true,
          epicAuthoring: false,
        }),
        false,
      ),
    ).toBe(false));
});

describe("relativeAge", () => {
  const now = 1_000_000_000_000;
  it("formats compact units, floored", () => {
    expect(relativeAge(now, now)).toBe("now");
    expect(relativeAge(now - 30_000, now)).toBe("now"); // <60s
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(relativeAge(now + 10_000, now)).toBe("now"); // future clamps to 0
  });
});

describe("formatResetIn", () => {
  const now = 1_000_000_000_000;
  it("returns coarse floored unit for future reset times", () => {
    expect(formatResetIn(now + 2 * 3_600_000, now)).toBe("2h");
    expect(formatResetIn(now + 5 * 86_400_000, now)).toBe("5d");
    expect(formatResetIn(now + 45 * 60_000, now)).toBe("45m");
    expect(formatResetIn(now + 30_000, now)).toBe("30s");
  });
  it("clamps past/now resets to 0s", () => {
    expect(formatResetIn(now, now)).toBe("0s");
    expect(formatResetIn(now - 1000, now)).toBe("0s"); // stale: past reset
    expect(formatResetIn(now - 3_600_000, now)).toBe("0s"); // far past
  });
});

describe("formatAgo", () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;
  const cases: [number, string][] = [
    [0, "0s"],
    [-5000, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59 * S, "59s"],
    [60 * S, "1m"],
    [59 * M + 59 * S, "59m"],
    [60 * M, "1h"],
    [23 * H + 59 * M, "23h"],
    [24 * H, "1d"],
    [3 * D + H, "3d"],
  ];
  for (const [ms, out] of cases) {
    it(`${ms}ms → ${out}`, () => expect(formatAgo(ms)).toBe(out));
  }
});

describe("waitTier", () => {
  const H = 3_600_000;
  const D = 24 * H;
  const cases: [number, ReturnType<typeof waitTier>][] = [
    [0, "fresh"],
    [4 * H - 1, "fresh"],
    [4 * H, "dozing"],
    [D - 1, "dozing"],
    [D, "burning"],
    [3 * D - 1, "burning"],
    [3 * D, "skeleton"],
    [14 * D, "skeleton"],
  ];
  for (const [ms, out] of cases) {
    it(`${ms}ms → ${out}`, () => expect(waitTier(ms)).toBe(out));
  }
});

describe("heartbeatTone", () => {
  const cases: [number, ReturnType<typeof heartbeatTone>][] = [
    [0, "live"],
    [9_999, "live"],
    [10_000, "recent"],
    [59_999, "recent"],
    [60_000, "stale"],
    [120_000, "stale"],
  ];
  for (const [ms, out] of cases) {
    it(`${ms}ms → ${out}`, () => expect(heartbeatTone(ms)).toBe(out));
  }
});
