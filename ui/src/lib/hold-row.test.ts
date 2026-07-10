import { describe, it, expect } from "vitest";
import { rowState, rowHold, type RowState } from "./hold-row";
import { holdLine } from "./hold";
import { m } from "$lib/paraglide/messages";
import type { HoldReason, PlanGate, Session } from "$lib/types";

const sess = (o: Partial<Session>): Session =>
  ({
    status: "idle",
    planPhase: "planning",
    haltReason: null,
    autopilotPaused: false,
    autopilotQuestion: null,
    ...o,
  }) as Session;

const gate = (o: Partial<PlanGate>): PlanGate =>
  ({
    decision: "changes_requested",
    round: 1,
    cap: 3,
    approved: false,
    dismissed: false,
    findings: [],
    blocks: [],
    answeredQuestionKeys: [],
    ...o,
  }) as PlanGate;

// a question-form block planQuestionsUnanswered will see as unanswered:
const qBlocks = [
  { type: "question-form", id: "b1", questions: [{ id: "q1" }] },
] as PlanGate["blocks"];

const hold = (code: HoldReason["code"]): HoldReason => ({ code });

describe("rowState / rowHold fixtures", () => {
  it("1. headline, no question block -> awaiting-rereview", () => {
    const s = sess({ status: "idle" });
    const g = gate({ round: 1, cap: 3, blocks: [] });
    expect(rowState(s, g, false, undefined)).toBe("awaiting-rereview");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBe(m.hold_awaiting_rereview({ round: 1, cap: 3 }));
    expect(r.action?.kind).toBe("rereview");
  });

  it("2. headline twin, question block -> question", () => {
    const s = sess({ status: "idle" });
    const g = gate({ round: 1, cap: 3, blocks: qBlocks, answeredQuestionKeys: [] });
    const sh = hold("plan-question");
    expect(rowState(s, g, false, sh)).toBe("question");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(m.hold_plan_question());
    expect(r.action?.kind).toBe("answer");
  });

  it("3. errored gate + question block -> error (not answer, not question line)", () => {
    const s = sess({ status: "idle" });
    const g = gate({ decision: "error", approved: false, blocks: qBlocks });
    const sh = hold("plan-question");
    expect(rowState(s, g, false, sh)).toBe("error");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(m.hold_error());
    expect(r.action?.kind).toBe("rereview");
  });

  it("4. at-cap crossing, hold still plan-rework -> quota (not holdLine of plan-rework)", () => {
    const s = sess({ status: "idle" });
    const g = gate({ round: 3, cap: 3 });
    const sh = hold("plan-rework");
    expect(rowState(s, g, false, sh)).toBe("quota");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(m.hold_quota_plan());
    expect(r.line).not.toBe(holdLine(sh));
    expect(r.action?.kind).toBe("resume");
  });

  it("5. at-cap, hold is quota-plan -> quota, line survives from server", () => {
    const s = sess({ status: "idle" });
    const g = gate({ round: 3, cap: 3 });
    const sh = hold("quota-plan");
    expect(rowState(s, g, false, sh)).toBe("quota");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action?.kind).toBe("resume");
  });

  it("6. dismissed + pending question -> dismissed, line survives, no action", () => {
    const s = sess({ status: "running" });
    const g = gate({ dismissed: true, round: 0, blocks: qBlocks, answeredQuestionKeys: [] });
    const sh = hold("plan-question");
    expect(rowState(s, g, false, sh)).toBe("dismissed");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action).toBeNull();
  });

  it("7. dismissed, nothing pending -> dismissed, blank line, no action", () => {
    const s = sess({});
    const g = gate({ dismissed: true, round: 0, blocks: [] });
    expect(rowState(s, g, false, undefined)).toBe("dismissed");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBeNull();
    expect(r.action).toBeNull();
  });

  it("8. approved but running, pending question -> none, server line survives", () => {
    const s = sess({ status: "running" });
    const g = gate({
      approved: true,
      decision: "approved",
      blocks: qBlocks,
      answeredQuestionKeys: [],
    });
    const sh = hold("plan-question");
    expect(rowState(s, g, false, sh)).toBe("none");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action).toBeNull();
  });

  it("9. gate-bootstrap window -> none, server line survives", () => {
    const s = sess({ status: "idle" });
    const sh = hold("plan-rework");
    expect(rowState(s, undefined, false, sh)).toBe("none");
    const r = rowHold(s, undefined, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action).toBeNull();
  });

  it("10. blocked, pre-bootstrap -> passthrough, blank line, no action", () => {
    const s = sess({ status: "blocked" });
    const g = gate({});
    expect(rowState(s, g, false, undefined)).toBe("passthrough");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBeNull();
    expect(r.action).toBeNull();
  });

  it("11. halted planning session -> passthrough, server line survives", () => {
    const s = sess({ status: "idle", haltReason: "error" });
    const g = gate({});
    const sh = hold("halted-error");
    expect(rowState(s, g, false, sh)).toBe("passthrough");
    const r = rowHold(s, g, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action).toBeNull();
  });

  it("12. at-cap + running (final round) -> revising, not quota", () => {
    const s = sess({ status: "running" });
    const g = gate({ round: 3, cap: 3 });
    expect(rowState(s, g, false, undefined)).toBe("revising");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBe(m.hold_revising_round({ round: 3, cap: 3 }));
    expect(r.action).toBeNull();
  });

  it("13. revising, round 0 (post-resume) -> plain revising line", () => {
    const s = sess({ status: "running" });
    const g = gate({ round: 0, cap: 3 });
    expect(rowState(s, g, false, undefined)).toBe("revising");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBe(m.hold_revising());
    expect(r.action).toBeNull();
  });

  it("14. reviewing with findings", () => {
    const s = sess({});
    const g = gate({ findings: ["a", "b"] });
    expect(rowState(s, g, true, undefined)).toBe("reviewing");
    const r = rowHold(s, g, true, undefined);
    expect(r.line).toBe(m.hold_reviewing_findings({ count: 2 }));
    expect(r.action).toBeNull();
  });

  it("15. reviewing, no findings", () => {
    const s = sess({});
    const g = gate({ approved: true, decision: "approved", findings: [] });
    expect(rowState(s, g, true, undefined)).toBe("reviewing");
    const r = rowHold(s, g, true, undefined);
    expect(r.line).toBe(m.hold_reviewing_plain());
    expect(r.action).toBeNull();
  });

  it("16. ready", () => {
    const s = sess({ status: "idle" });
    const g = gate({ approved: true, decision: "approved", blocks: [] });
    expect(rowState(s, g, false, undefined)).toBe("ready");
    const r = rowHold(s, g, false, undefined);
    expect(r.line).toBe(m.hold_ready());
    expect(r.action?.kind).toBe("go");
  });

  it("17. not planning (executing) -> passthrough, server line survives", () => {
    const s = sess({ planPhase: "executing" });
    const sh = hold("manual-steps");
    expect(rowState(s, undefined, false, sh)).toBe("passthrough");
    const r = rowHold(s, undefined, false, sh);
    expect(r.line).toBe(holdLine(sh));
    expect(r.action).toBeNull();
  });
});

// One canonical (session, gate, planReviewing, serverHold) tuple per RowState — reused by
// the properties below so exhaustiveness/action-shape assertions cover every branch exactly
// once, mirroring fixtures 1-17 above.
type Args = [Session, PlanGate | undefined, boolean, HoldReason | undefined];
const CASES: Array<{ state: RowState; args: Args }> = [
  { state: "passthrough", args: [sess({ status: "blocked" }), gate({}), false, undefined] },
  {
    state: "dismissed",
    args: [
      sess({ status: "running" }),
      gate({ dismissed: true, round: 0, blocks: qBlocks, answeredQuestionKeys: [] }),
      false,
      hold("plan-question"),
    ],
  },
  { state: "reviewing", args: [sess({}), gate({ findings: ["a", "b"] }), true, undefined] },
  {
    state: "revising",
    args: [sess({ status: "running" }), gate({ round: 3, cap: 3 }), false, undefined],
  },
  {
    state: "quota",
    args: [sess({ status: "idle" }), gate({ round: 3, cap: 3 }), false, hold("plan-rework")],
  },
  {
    state: "error",
    args: [
      sess({ status: "idle" }),
      gate({ decision: "error", approved: false, blocks: qBlocks }),
      false,
      hold("plan-question"),
    ],
  },
  {
    state: "question",
    args: [
      sess({ status: "idle" }),
      gate({ round: 1, cap: 3, blocks: qBlocks, answeredQuestionKeys: [] }),
      false,
      hold("plan-question"),
    ],
  },
  {
    state: "awaiting-rereview",
    args: [sess({ status: "idle" }), gate({ round: 1, cap: 3, blocks: [] }), false, undefined],
  },
  {
    state: "ready",
    args: [
      sess({ status: "idle" }),
      gate({ approved: true, decision: "approved", blocks: [] }),
      false,
      undefined,
    ],
  },
  { state: "none", args: [sess({ status: "idle" }), undefined, false, hold("plan-rework")] },
];

describe("properties", () => {
  it("P1 exhaustive maps: every RowState resolves a defined line/action", () => {
    const allStates: RowState[] = [
      "passthrough",
      "dismissed",
      "reviewing",
      "revising",
      "quota",
      "error",
      "question",
      "awaiting-rereview",
      "ready",
      "none",
    ];
    expect(new Set(CASES.map((c) => c.state))).toEqual(new Set(allStates));
    for (const { state, args } of CASES) {
      expect(rowState(...args)).toBe(state);
      const r = rowHold(...args);
      expect(r.line === null || typeof r.line === "string").toBe(true);
      expect(r.action === null || typeof r.action === "object").toBe(true);
    }
  });

  it("P2 no blanked server line", () => {
    const table: Array<[Session, PlanGate | undefined, boolean, HoldReason]> = [
      [
        sess({ status: "running" }),
        gate({ dismissed: true, round: 0, blocks: qBlocks, answeredQuestionKeys: [] }),
        false,
        hold("plan-question"),
      ], // fixture 6, dismissed
      [
        sess({ status: "running" }),
        gate({
          approved: true,
          decision: "approved",
          blocks: qBlocks,
          answeredQuestionKeys: [],
        }),
        false,
        hold("plan-question"),
      ], // fixture 8, none
      [sess({ status: "idle" }), undefined, false, hold("plan-rework")], // fixture 9, none
      [sess({ status: "idle", haltReason: "error" }), gate({}), false, hold("halted-error")], // fixture 11, passthrough
      [sess({ planPhase: "executing" }), undefined, false, hold("manual-steps")], // fixture 17, passthrough
    ];
    for (const [s, g, pr, sh] of table) {
      const r = rowHold(s, g, pr, sh);
      expect(r.line).toBe(holdLine(sh));
    }
  });

  it("P3 re-review only for error/awaiting-rereview, never reviewing/revising", () => {
    for (const { state, args } of CASES) {
      const r = rowHold(...args);
      if (r.action?.kind === "rereview") {
        expect(["error", "awaiting-rereview"]).toContain(state);
      }
    }
    const reviewing = rowHold(sess({}), gate({ findings: ["a", "b"] }), true, undefined);
    expect(reviewing.action?.kind).not.toBe("rereview");
    const revising = rowHold(
      sess({ status: "running" }),
      gate({ round: 3, cap: 3 }),
      false,
      undefined,
    );
    expect(revising.action?.kind).not.toBe("rereview");
  });

  it("P4 go only for ready", () => {
    for (const { state, args } of CASES) {
      const r = rowHold(...args);
      expect(r.action?.kind === "go").toBe(state === "ready");
    }
    const blocked = rowHold(
      sess({ status: "blocked" }),
      gate({ approved: true, decision: "approved", blocks: [] }),
      false,
      undefined,
    );
    expect(blocked.action?.kind).not.toBe("go");
  });

  it("P5 dismissed -> no action", () => {
    const withPendingQuestion = rowHold(
      sess({ status: "running" }),
      gate({ dismissed: true, round: 0, blocks: qBlocks, answeredQuestionKeys: [] }),
      false,
      hold("plan-question"),
    );
    expect(withPendingQuestion.state).toBe("dismissed");
    expect(withPendingQuestion.action).toBeNull();

    const withNothingPending = rowHold(
      sess({}),
      gate({ dismissed: true, round: 0, blocks: [] }),
      false,
      undefined,
    );
    expect(withNothingPending.state).toBe("dismissed");
    expect(withNothingPending.action).toBeNull();
  });
});
