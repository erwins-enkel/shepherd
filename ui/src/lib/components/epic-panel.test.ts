import { describe, it, expect } from "vitest";
import {
  chipFor,
  epicHoldLine,
  epicRole,
  epicRunState,
  epicRunStateLabel,
  epicRunSteps,
  epicRunWhy,
  progress,
  queuedBehind,
  queuePosition,
  slotHeldBy,
  stateLabel,
  supersedeImpact,
} from "./epic-panel";
import { m } from "#lib/paraglide/messages.js";
import type {
  DrainRunSummary,
  DrainStatus,
  EpicChild,
  EpicRunEnd,
  EpicRunStatus,
} from "#lib/types.js";
import { formatReset } from "#lib/format.js";

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

  it("epic_unreadable explains the stall", () => {
    expect(epicHoldLine(drain({ reason: "epic_unreadable" }), true, [...READY])).toBe(
      m.epic_hold_epic_unreadable(),
    );
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

// ── run-control region (#2620) ──────────────────────────────────────────────────────────────
// The issue's acceptance scenario: maxAuto = 1, epic B (#20) leads and waits for a slot, epic A's
// (#10) child #11 still holds the only slot — A is winding down.
const B = 20;
const A = 10;

function summary(over: Partial<DrainRunSummary> = {}): DrainRunSummary {
  return {
    leadingEpic: B,
    windingDown: [{ epic: A, inFlight: [11] }],
    slots: {
      used: 1,
      max: 1,
      holders: [{ sessionId: "s-11", desig: "TASK-11", issueNumber: 11, epicParent: A }],
    },
    next: [21],
    after: [22, 23, 25],
    ...over,
  };
}

function child(number: number, state: EpicChild["state"], blockedBy: number[] = []): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy,
    state,
  } as EpicChild;
}

function epicB(status: EpicRunStatus = "running") {
  return {
    run: { repoPath: "/r", parentIssueNumber: B, mode: "auto" as const, status },
    children: [
      child(21, "ready"),
      child(22, "blocked", [21]),
      child(23, "blocked", [21, 24]),
      child(24, "merged"),
      child(25, "blocked", [21, 22]),
    ],
  };
}

function epicA() {
  return {
    run: { repoPath: "/r", parentIssueNumber: A, mode: "auto" as const, status: "idle" as const },
    children: [
      child(11, "running"),
      child(12, "ready"),
      child(13, "blocked", [12]),
      child(14, "merged"),
    ],
  };
}

const capDrain = (over: Partial<DrainStatus> = {}) =>
  drain({ reason: "cap", inFlight: 1, max: 1, epicParent: B, runSummary: summary(), ...over });

describe("epicRole / slotHeldBy", () => {
  it("names the leading and the winding-down epic, null otherwise", () => {
    expect(epicRole(summary(), B)).toBe("leading");
    expect(epicRole(summary(), A)).toBe("winding");
    expect(epicRole(summary(), 99)).toBeNull();
    expect(epicRole(undefined, B)).toBeNull();
  });

  it("reports the 1-based slot an issue holds", () => {
    expect(slotHeldBy(summary(), 11)).toEqual({ index: 1, max: 1 });
    expect(slotHeldBy(summary(), 21)).toBeNull();
    expect(slotHeldBy(null, 11)).toBeNull();
  });
});

// #2624: epics queued behind the leader.
describe("queue roles", () => {
  const q = () => summary({ queued: [30, 40] });

  it("names a queued epic 'queued', after leading and winding", () => {
    expect(epicRole(q(), 30)).toBe("queued");
    expect(epicRole(q(), 40)).toBe("queued");
    expect(epicRole(q(), B)).toBe("leading");
    expect(epicRole(summary({ queued: [A] }), A)).toBe("winding");
    expect(epicRole(summary(), 30)).toBeNull();
  });

  it("reports the 1-based queue position, null when not queued or from an older server", () => {
    expect(queuePosition(q(), 30)).toBe(1);
    expect(queuePosition(q(), 40)).toBe(2);
    expect(queuePosition(q(), 99)).toBeNull();
    expect(queuePosition(summary(), 30)).toBeNull();
    expect(queuePosition(null, 30)).toBeNull();
  });

  it("waits behind its predecessor, the head behind the leader; a newcomer behind the tail", () => {
    expect(queuedBehind(q(), 30)).toBe(B);
    expect(queuedBehind(q(), 40)).toBe(30);
    expect(queuedBehind(q(), 99)).toBe(40);
    expect(queuedBehind(summary(), 99)).toBe(B);
  });

  it("a queued, idle epic reads 'queued' with its position and no steps", () => {
    const epic = { ...epicB("idle"), run: { ...epicB("idle").run, parentIssueNumber: 40 } };
    const d = capDrain({ runSummary: q() });
    expect(epicRunState(epic, 40, d)).toMatchObject({ kind: "queued", tone: "quiet", position: 2 });
    expect(epicRunSteps(epic, 40, d)).toBeNull();
    expect(epicRunStateLabel("queued", "", 2)).toBe(m.epic_run_state_queued({ position: 2 }));
  });
});

describe("epicRunState", () => {
  it("scenario: the leading epic waits for an agent slot", () => {
    expect(epicRunState(epicB(), B, capDrain())).toMatchObject({
      kind: "waiting_slot",
      tone: "run",
    });
  });

  it("scenario: the superseded epic winds down and names its in-flight child", () => {
    expect(epicRunState(epicA(), A, capDrain())).toMatchObject({
      kind: "winding",
      inFlight: [11],
    });
  });

  it("paused / idle read quiet", () => {
    expect(epicRunState(epicB("paused"), B, capDrain()).kind).toBe("paused");
    expect(epicRunState(epicB("idle"), 99, capDrain()).kind).toBe("idle");
    expect(epicRunState(epicB("idle"), 99, capDrain()).tone).toBe("quiet");
  });

  it("awaiting approval is its own state", () => {
    const d = capDrain({ reason: "awaiting_approval", detail: "21" });
    expect(epicRunState(epicB(), B, d).kind).toBe("awaiting_approval");
  });

  it("a trouble reason halts and carries the former hold line as the note", () => {
    const s = epicRunState(epicB(), B, capDrain({ reason: "blocked", detail: "TASK-07" }));
    expect(s).toMatchObject({ kind: "halted", tone: "halt" });
    expect(s.note).toContain("TASK-07");
  });

  it("empty with nothing in flight reads 'nothing startable'; with something in flight 'running'", () => {
    expect(epicRunState(epicB(), B, capDrain({ reason: "empty" })).kind).toBe("nothing");
    const busy = { ...epicB(), children: [child(21, "running")] };
    expect(epicRunState(busy, B, capDrain({ reason: "empty" })).kind).toBe("running");
    expect(epicRunState(epicB(), B, capDrain({ reason: null })).kind).toBe("running");
  });

  it("ignores a hold reason that belongs to another epic", () => {
    expect(epicRunState(epicB(), B, capDrain({ epicParent: 77 })).kind).toBe("running");
  });
});

describe("epicRunStateLabel", () => {
  it("labels each kind, naming the in-flight issues when winding down", () => {
    expect(epicRunStateLabel("running", "")).toBe(m.epic_run_state_running());
    expect(epicRunStateLabel("idle", "")).toBe(m.epic_run_state_idle());
    expect(epicRunStateLabel("winding", "#7")).toBe(m.epic_run_state_winding({ inflight: "#7" }));
    expect(epicRunStateLabel("superseded", "")).toBe(m.epic_run_state_superseded());
    expect(epicRunStateLabel("ended", "")).toBe(m.epic_run_state_ended());
  });
});

// Why an epic that stopped leading does not run (runEnd, recorded by the server).
describe("stopped epics", () => {
  const AT = new Date(2026, 9, 4, 23, 41).getTime();
  const NOW = new Date(2026, 9, 5, 8, 30).getTime();
  const when = formatReset(AT, NOW, { withTime: true });
  const end = (over: Partial<EpicRunEnd>): EpicRunEnd => ({
    cause: "ended",
    successor: null,
    at: AT,
    via: null,
    ...over,
  });
  const idle = (runEnd?: EpicRunEnd) => ({ ...epicB("idle"), runEnd });

  it("an idle epic that was superseded or ended says so; completed or unrecorded stays idle", () => {
    expect(epicRunState(idle(end({ cause: "superseded", successor: 5 })), 99, null)).toMatchObject({
      kind: "superseded",
      tone: "quiet",
    });
    expect(epicRunState(idle(end({})), 99, null).kind).toBe("ended");
    expect(epicRunState(idle(end({ cause: "completed" })), 99, null).kind).toBe("idle");
    expect(epicRunState(idle(), 99, null).kind).toBe("idle");
  });

  it("winding down wins over the recorded reason", () => {
    const a = { ...epicA(), runEnd: end({ cause: "superseded", successor: B }) };
    expect(epicRunState(a, A, capDrain()).kind).toBe("winding");
  });

  it("superseded by the epic that still leads: one line naming it", () => {
    expect(epicRunWhy(end({ cause: "superseded", successor: B }), B, NOW)).toEqual([
      m.epic_run_why_superseded_leads({ successor: B, when }),
    ]);
  });

  it("superseded by an epic that no longer leads: names both, or that none leads", () => {
    expect(epicRunWhy(end({ cause: "superseded", successor: 5 }), B, NOW)).toEqual([
      m.epic_run_why_superseded({ successor: 5, when }),
      m.epic_run_winding_leader({ leader: B }),
    ]);
    expect(epicRunWhy(end({ cause: "superseded", successor: 5 }), null, NOW)).toEqual([
      m.epic_run_why_superseded({ successor: 5, when }),
      m.epic_run_no_leader(),
    ]);
  });

  it("ended: when, who leads now, and the machine token behind it", () => {
    expect(epicRunWhy(end({ via: "ci-bot" }), null, NOW)).toEqual([
      m.epic_run_why_ended({ when }),
      m.epic_run_no_leader(),
      m.epic_run_why_via({ name: "ci-bot" }),
    ]);
  });

  it("nothing recorded (or completed): only who leads now", () => {
    expect(epicRunWhy(undefined, B, NOW)).toEqual([m.epic_run_winding_leader({ leader: B })]);
    expect(epicRunWhy(end({ cause: "completed" }), null, NOW)).toEqual([m.epic_run_no_leader()]);
  });
});

describe("epicRunSteps", () => {
  it("scenario: Now = A's child, Next = B's first ready child after the slot frees, After = its successors", () => {
    const steps = epicRunSteps(epicB(), B, capDrain());
    expect(steps).toMatchObject({
      kind: "leading",
      slots: { used: 1, max: 1 },
      next: 21,
      nextNote: "after_slot",
      after: [22, 23, 25],
    });
    if (steps?.kind !== "leading") throw new Error("expected leading");
    expect(steps.now.map((h) => h.issueNumber)).toEqual([11]);
    expect(steps.freedBy?.issueNumber).toBe(11);
    // #22 (only #21) and #23 (#21 + merged #24) start in parallel; #25 still waits on #22.
    expect(steps.parallel).toBe(2);
  });

  it("next note follows pause, approval and free slots", () => {
    const note = (status: EpicRunStatus, over: Partial<DrainStatus>) => {
      const s = epicRunSteps(epicB(status), B, capDrain(over));
      return s?.kind === "leading" ? s.nextNote : null;
    };
    expect(note("paused", {})).toBe("resume");
    expect(note("running", { reason: "awaiting_approval", detail: "21" })).toBe("approval");
    const free = summary({ slots: { used: 0, max: 2, holders: [] } });
    expect(note("running", { reason: null, runSummary: free })).toBe("soon");
  });

  it("winding: own holders, the unstarted children left behind, and the slot's next owner", () => {
    expect(epicRunSteps(epicA(), A, capDrain())).toMatchObject({
      kind: "winding",
      now: [{ issueNumber: 11 }],
      leftBehind: 2,
      handover: { issue: 21, epic: B },
      leader: B,
    });
  });

  it("null for an epic outside the run or without a runSummary", () => {
    expect(epicRunSteps(epicB("idle"), 99, capDrain())).toBeNull();
    expect(epicRunSteps(epicB(), B, drain({ reason: "cap" }))).toBeNull();
  });
});

describe("supersedeImpact", () => {
  it("scenario: starting B while A leads — A's holders, progress and unstarted children", () => {
    const s = summary({
      leadingEpic: A,
      windingDown: [],
      slots: {
        used: 2,
        max: 3,
        holders: [
          { sessionId: "s-99", desig: "TASK-99", issueNumber: 99, epicParent: null },
          { sessionId: "s-11", desig: "TASK-11", issueNumber: 11, epicParent: A },
        ],
      },
    });
    expect(supersedeImpact(A, epicA(), s)).toEqual({
      progress: { merged: 1, total: 4 },
      holders: [{ issue: 11, index: 2, max: 3 }],
      leftBehind: [12, 13],
    });
  });

  it("without the leader's record: holders only", () => {
    expect(supersedeImpact(A, null, summary())).toEqual({
      progress: null,
      holders: [{ issue: 11, index: 1, max: 1 }],
      leftBehind: null,
    });
  });

  it("no holders of the leader → empty list", () => {
    expect(supersedeImpact(B, epicB(), summary()).holders).toEqual([]);
  });
});
