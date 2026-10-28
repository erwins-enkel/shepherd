import { describe, it, expect } from "vitest";
import { baseReworkFailedText, drainHold, holdActionLabel, type HoldAction } from "./epic-hold";
import { m } from "#lib/paraglide/messages.js";
import { ApiError } from "#lib/api.js";
import type { DrainRunSession, DrainStatus } from "#lib/types.js";

function drain(over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath: "/r",
    enabled: true,
    paused: true,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 2,
    epicParent: 35,
    ...over,
  };
}

function holder(desig: string, sessionId: string): DrainRunSession {
  return { sessionId, desig, issueNumber: 17, epicParent: 35 };
}

function withSessions(
  over: Partial<DrainStatus>,
  holders: DrainRunSession[],
  repairs: DrainRunSession[] = [],
) {
  return drain({
    ...over,
    runSummary: {
      leadingEpic: 35,
      windingDown: [],
      slots: { used: holders.length, max: 2, holders },
      landingRepairs: repairs,
      next: [],
      after: [],
    },
  });
}

describe("drainHold (#3457)", () => {
  const cases: [string, string, "repo" | "run" | "epic", "halt" | "wait", HoldAction[]][] = [
    [
      "bootstrap_incomplete",
      "p2",
      "repo",
      "halt",
      [{ kind: "bootstrap_view" }, { kind: "bootstrap_override" }],
    ],
    ["usage", "91", "run", "halt", [{ kind: "usage_lift" }]],
    [
      "epic_base_conflict",
      "epic/35-x",
      "epic",
      "halt",
      [{ kind: "base_resolve" }, { kind: "base_continue", override: "base" }],
    ],
    ["epic_base_stale", "epic/35-x", "epic", "halt", [{ kind: "base_continue", override: "base" }]],
    [
      "epic_predecessor_unlanded",
      "#12",
      "epic",
      "halt",
      [{ kind: "base_continue", override: "predecessor" }],
    ],
    ["awaiting_approval", "17", "epic", "wait", [{ kind: "approve" }]],
  ];

  for (const [reason, detail, scope, tone, actions] of cases) {
    it(`${reason}: ${scope} · ${tone} with its action`, () => {
      const v = drainHold(drain({ reason, detail }))!;
      expect(v).toMatchObject({ code: reason, scope, tone, actions });
      expect(v.what).not.toBe("");
      expect(v.text).not.toBe("");
      for (const a of v.actions) expect(holdActionLabel(a)).not.toBe("");
    });
  }

  it("says what is missing, which branch and which epic", () => {
    expect(drainHold(drain({ reason: "epic_base_conflict", detail: "epic/35-x" }))!.text).toBe(
      m.epic_rowhold_conflict_text({ branch: "epic/35-x" }),
    );
    expect(drainHold(drain({ reason: "epic_predecessor_unlanded", detail: "#12" }))!.text).toBe(
      m.epic_rowhold_predecessor_text({ epics: "#12" }),
    );
    expect(drainHold(drain({ reason: "awaiting_approval", detail: "17" }))!.text).toBe(
      m.epic_rowhold_approval_text({ num: "17" }),
    );
  });

  for (const reason of ["blocked", "changes_requested", "error"]) {
    it(`${reason}: an epic hold that opens the stuck session`, () => {
      const v = drainHold(
        withSessions({ reason, detail: "TASK-07" }, [
          holder("TASK-06", "s6"),
          holder("TASK-07", "s7"),
        ]),
      )!;
      expect(v).toMatchObject({ scope: "epic", tone: "halt", what: m.epic_rowhold_agent_what() });
      expect(v.text).toContain("TASK-07");
      expect(v.actions).toEqual([{ kind: "open_session", sessionId: "s7" }]);
    });
  }

  it("finds the stuck session among the landing repairs too", () => {
    const v = drainHold(
      withSessions({ reason: "blocked", detail: "FIX-1" }, [], [holder("FIX-1", "r1")]),
    );
    expect(v!.actions).toEqual([{ kind: "open_session", sessionId: "r1" }]);
  });

  it("offers no session it can't find, but still names the hold", () => {
    expect(drainHold(withSessions({ reason: "blocked", detail: "TASK-09" }, []))!.actions).toEqual(
      [],
    );
    expect(drainHold(drain({ reason: "error", detail: "TASK-09" }))!.actions).toEqual([]);
  });

  it("has no line without a hold, for the sandbox gates (#3455) or reasons outside the table", () => {
    expect(drainHold(null)).toBeNull();
    expect(drainHold(drain({ reason: null }))).toBeNull();
    for (const reason of [
      "empty",
      "cap",
      "credits",
      "disabled",
      "awaiting_signoff",
      "epic_base_unavailable",
      "epic_unreadable",
      "sandbox_interactive",
      "sandbox_provider_unconfined",
      "sandbox_backend_unavailable",
      "sandbox_egress_unavailable",
      "target_repo_drain_off",
    ])
      expect(drainHold(drain({ reason, detail: "x" })), reason).toBeNull();
  });
});

describe("baseReworkFailedText (#3101)", () => {
  it("names a busy branch, one without a conflict, and any other failure", () => {
    expect(baseReworkFailedText(new ApiError(409, "x", "busy"))).toBe(m.epic_base_resolve_busy());
    expect(baseReworkFailedText(new ApiError(409, "x", "not-conflicting"))).toBe(
      m.epic_base_resolve_not_conflicting(),
    );
    expect(baseReworkFailedText(new Error("offline"))).toBe(m.epic_base_resolve_failed());
  });
});
