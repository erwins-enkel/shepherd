import { describe, it, expect } from "vitest";
import { sessionlessEpicWait } from "./epic-sessionless";
import { epicHoldLine } from "./epic-panel";
import { m } from "#lib/paraglide/messages.js";
import type { DrainRunSummary, DrainStatus, Epic, EpicChild } from "#lib/types.js";

function child(number: number, over: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `child #${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy: [],
    state: "merged",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
    ...over,
  };
}

function epic(children: EpicChild[], status: Epic["run"]["status"] = "running") {
  return {
    parentIssueNumber: 3451,
    children,
    run: { repoPath: "/r", parentIssueNumber: 3451, mode: "auto" as const, status },
  };
}

const summary = (over: Partial<DrainRunSummary> = {}): DrainRunSummary => ({
  leadingEpic: 3451,
  windingDown: [],
  slots: { used: 0, max: 2, holders: [] },
  next: [],
  after: [],
  ...over,
});

function drain(over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath: "/r",
    enabled: true,
    paused: false,
    reason: "empty",
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 2,
    epicParent: 3451,
    runSummary: summary(),
    ...over,
  };
}

/** The #3451 picture from 08.11.2026: 8/10 merged, #3449 open + claimed with no session or PR
 *  (the epic reads it as in-review), #3450 blocked by it, nothing startable, 0/2 slots. */
const observed = () =>
  epic([
    ...[3441, 3442, 3443, 3444, 3445, 3446, 3447, 3448].map((n) => child(n)),
    child(3449, { state: "in-review", claimed: true }),
    child(3450, { state: "blocked", blockedBy: [3449] }),
  ]);

describe("sessionlessEpicWait", () => {
  it("#3451: names the claim as ownership-unknown and what waits on it — never a running review", () => {
    const wait = sessionlessEpicWait(observed(), drain());
    expect(wait.status).toBe(m.epic_sessionless_running());
    expect(wait.lines).toEqual([
      m.epic_sessionless_claimed_unknown({ number: 3449 }),
      m.epic_sessionless_waits_on({ number: 3450, blockers: "#3449" }),
    ]);
    expect(wait.lines.join(" ")).not.toContain(m.epic_state_in_review());
  });

  it("paused: the pause is the reason, even with in-flight children", () => {
    const e = { ...observed(), run: { ...observed().run, status: "paused" as const } };
    const wait = sessionlessEpicWait(e, drain());
    expect(wait.status).toBe(m.epic_sessionless_paused());
    expect(wait.lines).toEqual([m.epic_sessionless_reason_paused()]);
  });

  it("a drain hold on this epic is the one reason", () => {
    const d = drain({ reason: "cap", inFlight: 2, max: 2 });
    const wait = sessionlessEpicWait(observed(), d);
    expect(wait.lines).toEqual([epicHoldLine(d, true, observed().children)]);
  });

  it("a drain that runs another epic contributes neither its hold nor its next-up", () => {
    const e = epic([child(1, { state: "ready" })]);
    const other = drain({ epicParent: 99, reason: "blocked", detail: "TASK-1" });
    expect(sessionlessEpicWait(e, other).lines).toEqual([m.epic_sessionless_unknown()]);
    const otherNext = drain({ epicParent: 99, reason: null, runSummary: summary({ next: [1] }) });
    expect(sessionlessEpicWait(e, otherNext).lines).toEqual([m.epic_sessionless_unknown()]);
  });

  it("an in-flight child: its machine, else its PR, else unknown ownership without a claim", () => {
    const host = { instanceId: "i-1", name: "studio", platform: "darwin" };
    const e = epic([
      child(1, { state: "running", elsewhere: { host, sessionId: null, prNumber: null } }),
      child(2, { state: "in-review", claimed: true, retiredPrNumber: 77 }),
      child(3, { state: "running", sessionId: "gone" }),
    ]);
    expect(sessionlessEpicWait(e, drain()).lines).toEqual([
      m.epic_sessionless_elsewhere({ number: 1, machine: "studio" }),
      m.epic_sessionless_pr_open({ number: 2, pr: 77 }),
      m.epic_sessionless_inflight_unknown({ number: 3 }),
    ]);
  });

  it("a blocked child lists all its open blockers once one of them is in flight", () => {
    const e = epic([
      child(1, { state: "in-review", claimed: true }),
      child(2, { state: "blocked", blockedBy: [9] }),
      child(3, { state: "blocked", blockedBy: [1, 2] }),
    ]);
    expect(sessionlessEpicWait(e, drain()).lines).toEqual([
      m.epic_sessionless_claimed_unknown({ number: 1 }),
      m.epic_sessionless_waits_on({ number: 3, blockers: "#1, #2" }),
    ]);
  });

  it("nothing in flight: the drain's next-up, else the explicit unknown", () => {
    const e = epic([child(1, { state: "ready" })]);
    const next = drain({ reason: null, runSummary: summary({ next: [1] }) });
    expect(sessionlessEpicWait(e, next).lines).toEqual([m.epic_sessionless_next({ number: 1 })]);
    expect(sessionlessEpicWait(e, drain()).lines).toEqual([m.epic_sessionless_unknown()]);
    expect(sessionlessEpicWait(e, undefined).lines).toEqual([m.epic_sessionless_unknown()]);
  });
});
