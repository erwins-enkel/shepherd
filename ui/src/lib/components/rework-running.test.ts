import { expect, test } from "vitest";
import { isReworkRunning } from "./rework-running";
import type { PlanGate, ReviewVerdict, Session } from "$lib/types";

const NOW = 1_000_000_000_000;

function session(
  id: string,
  status: SessionStatus = "running",
  planPhase: Session["planPhase"] = null,
): Pick<Session, "id" | "status" | "planPhase"> {
  return { id, status, planPhase };
}
type SessionStatus = Session["status"];

/** Plan gate mid-loop (round < cap) by default — planStallStatus "round". */
function gate(over: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: "s",
    planHash: "h",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["f"],
    round: 1,
    cap: 5,
    approved: false,
    plan: "",
    updatedAt: NOW,
    ...over,
  };
}

/** Critic verdict mid-loop (addressRound < addressCap) by default — addressStallStatus "round". */
function review(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s",
    headSha: "abc",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["f"],
    addressRound: 1,
    addressCap: 5,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900_000,
    updatedAt: NOW,
    ...over,
  } as ReviewVerdict;
}

test("matches display-running plan-gate changes during planning (mid-loop)", () => {
  expect(isReworkRunning(session("s", "running", "planning"), { planGate: gate() }, {}, NOW)).toBe(
    true,
  );
});

test("keeps the genuine in-flight final round in the group", () => {
  expect(
    isReworkRunning(
      session("s", "running", "planning"),
      { planGate: gate({ round: 5, cap: 5, finalRoundPending: true, updatedAt: NOW }) },
      {},
      NOW,
    ),
  ).toBe(true);
});

test("drops a stalled plan gate (at cap, no pending final round → takeover)", () => {
  expect(
    isReworkRunning(
      session("s", "running", "planning"),
      { planGate: gate({ round: 5, cap: 5, finalRoundPending: false }) },
      {},
      NOW,
    ),
  ).toBe(false);
});

test("drops a dismissed plan gate even mid-loop", () => {
  expect(
    isReworkRunning(
      session("s", "running", "planning"),
      { planGate: gate({ dismissed: true }) },
      {},
      NOW,
    ),
  ).toBe(false);
});

test("does not match plan-gate changes after execution starts", () => {
  expect(isReworkRunning(session("s", "running", "executing"), { planGate: gate() }, {}, NOW)).toBe(
    false,
  );
});

test("matches display-running critic changes (mid-loop)", () => {
  expect(isReworkRunning(session("s"), { review: review() }, {}, NOW)).toBe(true);
});

test("drops a stalled critic streak", () => {
  expect(
    isReworkRunning(
      session("s"),
      { review: review({ addressRound: 5, addressCap: 5, finalRoundPending: false }) },
      {},
      NOW,
    ),
  ).toBe(false);
});

test("drops a dismissed critic verdict", () => {
  expect(isReworkRunning(session("s"), { review: review({ dismissed: true }) }, {}, NOW)).toBe(
    false,
  );
});

test("ignores non-changes decisions", () => {
  expect(isReworkRunning(session("s"), { planGate: gate({ decision: "approved" }) }, {}, NOW)).toBe(
    false,
  );
  expect(
    isReworkRunning(session("s"), { review: review({ decision: "commented" }) }, {}, NOW),
  ).toBe(false);
});

test("requires display-running status", () => {
  expect(isReworkRunning(session("s", "idle"), { review: review() }, {}, NOW)).toBe(false);
});

test("includes working-while-blocked changes-requested rows", () => {
  expect(isReworkRunning(session("s", "blocked"), { review: review() }, { s: true }, NOW)).toBe(
    true,
  );
});

test("keeps genuinely blocked changes-requested rows out of the running group", () => {
  expect(isReworkRunning(session("s", "blocked"), { review: review() }, {}, NOW)).toBe(false);
});
