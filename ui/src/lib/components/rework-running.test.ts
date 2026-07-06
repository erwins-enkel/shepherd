import { expect, test } from "vitest";
import { isReworkRunning } from "./rework-running";
import type { Session, SessionStatus } from "$lib/types";

function session(
  id: string,
  status: SessionStatus = "running",
  planPhase: Session["planPhase"] = null,
): Pick<Session, "id" | "status" | "planPhase"> {
  return { id, status, planPhase };
}

test("matches display-running plan-gate changes during planning", () => {
  expect(
    isReworkRunning(
      session("s", "running", "planning"),
      { planGate: { decision: "changes_requested" } },
      {},
    ),
  ).toBe(true);
});

test("does not match plan-gate changes after execution starts", () => {
  expect(
    isReworkRunning(
      session("s", "running", "executing"),
      { planGate: { decision: "changes_requested" } },
      {},
    ),
  ).toBe(false);
});

test("matches display-running critic changes", () => {
  expect(isReworkRunning(session("s"), { review: { decision: "changes_requested" } }, {})).toBe(
    true,
  );
});

test("ignores non-changes decisions", () => {
  expect(isReworkRunning(session("s"), { planGate: { decision: "approved" } }, {})).toBe(false);
  expect(isReworkRunning(session("s"), { review: { decision: "commented" } }, {})).toBe(false);
});

test("requires display-running status", () => {
  expect(
    isReworkRunning(session("s", "idle"), { review: { decision: "changes_requested" } }, {}),
  ).toBe(false);
});

test("includes working-while-blocked changes-requested rows", () => {
  expect(
    isReworkRunning(
      session("s", "blocked"),
      { review: { decision: "changes_requested" } },
      { s: true },
    ),
  ).toBe(true);
});

test("keeps genuinely blocked changes-requested rows out of the running group", () => {
  expect(
    isReworkRunning(session("s", "blocked"), { review: { decision: "changes_requested" } }, {}),
  ).toBe(false);
});
