import { describe, expect, test } from "bun:test";
import type { Epic, EpicChild, EpicChildState, EpicClock } from "../src/epic-core";
import { withEpicTiming, type EpicTimingInput } from "../src/epic-timing";

const MIN = 60_000;

function child(number: number, state: EpicChildState): EpicChild {
  return {
    number,
    title: `child ${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: state === "merged",
    integrationMerged: false,
    claimed: false,
  };
}

function epic(children: EpicChild[]): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 1,
    parentTitle: "epic",
    source: "native",
    children,
    warnings: [],
    run: { repoPath: "/repo", parentIssueNumber: 1, mode: "auto", status: "running" },
  };
}

function clock(c: Partial<EpicClock> = {}): EpicClock {
  return {
    startedAt: 0,
    pausedAt: null,
    pauses: [],
    landingStartedAt: null,
    landedAt: null,
    firstFinishAt: null,
    ...c,
  };
}

function input(i: Partial<EpicTimingInput>): EpicTimingInput {
  return { clock: null, sessions: [], facts: [], integratedAt: new Map(), now: 0, ...i };
}

describe("withEpicTiming — epic clock", () => {
  test("no clock: never started, no idle, agent time still summed", () => {
    const t = withEpicTiming(
      epic([child(2, "running")]),
      input({
        sessions: [{ id: "a", issueNumber: 2, createdAt: 10 * MIN, endedAt: null }],
        now: 30 * MIN,
      }),
    ).timing!;
    expect(t).toEqual({
      startedAt: null,
      pausedAt: null,
      pausedMs: 0,
      landingStartedAt: null,
      landedAt: null,
      agentMs: 20 * MIN,
      idleMs: 0,
    });
  });

  test("copies the clock and sums its closed pauses", () => {
    const t = withEpicTiming(
      epic([]),
      input({
        clock: clock({
          startedAt: 0,
          pausedAt: 90 * MIN,
          pauses: [
            [10 * MIN, 20 * MIN],
            [40 * MIN, 45 * MIN],
          ],
          landingStartedAt: 90 * MIN,
          landedAt: 120 * MIN,
        }),
        now: 200 * MIN,
      }),
    ).timing!;
    expect(t).toMatchObject({
      startedAt: 0,
      pausedAt: 90 * MIN,
      pausedMs: 15 * MIN,
      landingStartedAt: 90 * MIN,
      landedAt: 120 * MIN,
    });
  });

  test("idle counts running time with no child session alive, never paused time", () => {
    // Runs 0–60, paused 20–30. One child session alive 5–15, another 25–40 (alive across the
    // pause). Running intervals: [0,20] + [30,60] = 50 min; covered: 5–15 and 30–40 = 20 min.
    const t = withEpicTiming(
      epic([child(2, "merged"), child(3, "running")]),
      input({
        clock: clock({ startedAt: 0, pauses: [[20 * MIN, 30 * MIN]] }),
        sessions: [
          { id: "a", issueNumber: 2, createdAt: 5 * MIN, endedAt: 15 * MIN },
          { id: "b", issueNumber: 3, createdAt: 25 * MIN, endedAt: 40 * MIN },
        ],
        now: 60 * MIN,
      }),
    ).timing!;
    expect(t.pausedMs).toBe(10 * MIN);
    expect(t.idleMs).toBe(30 * MIN);
    expect(t.agentMs).toBe(25 * MIN);
  });

  test("an open stop ends the running clock; time after it is neither running nor idle", () => {
    const t = withEpicTiming(
      epic([]),
      input({ clock: clock({ startedAt: 0, pausedAt: 10 * MIN }), now: 100 * MIN }),
    ).timing!;
    expect(t.idleMs).toBe(10 * MIN);
  });

  test("overlapping child sessions add up in agent time but cover idle only once", () => {
    const t = withEpicTiming(
      epic([child(2, "running"), child(3, "running")]),
      input({
        clock: clock({ startedAt: 0 }),
        sessions: [
          { id: "a", issueNumber: 2, createdAt: 0, endedAt: null },
          { id: "b", issueNumber: 3, createdAt: 5 * MIN, endedAt: null },
        ],
        now: 10 * MIN,
      }),
    ).timing!;
    expect(t.agentMs).toBe(15 * MIN);
    expect(t.idleMs).toBe(0);
  });

  test("a pruned session's merged fact still counts; one without a merge has no known end", () => {
    const t = withEpicTiming(
      epic([child(2, "merged"), child(3, "ready")]),
      input({
        clock: clock({ startedAt: 0 }),
        facts: [
          { sessionId: "gone", issueNumber: 2, createdAt: 0, mergedAt: 10 * MIN },
          { sessionId: "gone2", issueNumber: 3, createdAt: 10 * MIN, mergedAt: null },
        ],
        now: 20 * MIN,
      }),
    ).timing!;
    expect(t.agentMs).toBe(10 * MIN);
    expect(t.idleMs).toBe(10 * MIN);
  });

  test("a fact whose session row still exists is not counted twice", () => {
    const t = withEpicTiming(
      epic([child(2, "merged")]),
      input({
        sessions: [{ id: "a", issueNumber: 2, createdAt: 0, endedAt: 10 * MIN }],
        facts: [{ sessionId: "a", issueNumber: 2, createdAt: 0, mergedAt: 10 * MIN }],
        now: 20 * MIN,
      }),
    ).timing!;
    expect(t.agentMs).toBe(10 * MIN);
  });

  test("sessions on issues outside the epic are ignored", () => {
    const t = withEpicTiming(
      epic([child(2, "running")]),
      input({
        clock: clock({ startedAt: 0 }),
        sessions: [
          { id: "x", issueNumber: 99, createdAt: 0, endedAt: null },
          { id: "y", issueNumber: null, createdAt: 0, endedAt: null },
        ],
        now: 10 * MIN,
      }),
    ).timing!;
    expect(t.agentMs).toBe(0);
    expect(t.idleMs).toBe(10 * MIN);
  });
});

describe("withEpicTiming — child start/end", () => {
  test("start is the child's earliest session or fact; unknown → null", () => {
    const e = withEpicTiming(
      epic([child(2, "running"), child(3, "blocked")]),
      input({
        sessions: [{ id: "b", issueNumber: 2, createdAt: 30 * MIN, endedAt: null }],
        facts: [{ sessionId: "a", issueNumber: 2, createdAt: 10 * MIN, mergedAt: null }],
        now: 60 * MIN,
      }),
    );
    expect(e.children.map((c) => [c.startedAt, c.endedAt])).toEqual([
      [10 * MIN, null],
      [null, null],
    ]);
  });

  test("an integrated child ends at its epic_integrated stamp, even with a later fact merge", () => {
    const e = withEpicTiming(
      epic([child(2, "merged")]),
      input({
        facts: [{ sessionId: "a", issueNumber: 2, createdAt: 0, mergedAt: 50 * MIN }],
        integratedAt: new Map([[2, 40 * MIN]]),
        now: 60 * MIN,
      }),
    );
    expect(e.children[0]).toMatchObject({ startedAt: 0, endedAt: 40 * MIN });
  });

  test("a closed, non-integrated child ends at its latest fact merge; without one, null", () => {
    const e = withEpicTiming(
      epic([child(2, "merged"), child(3, "merged")]),
      input({
        facts: [
          { sessionId: "a", issueNumber: 2, createdAt: 0, mergedAt: 20 * MIN },
          { sessionId: "b", issueNumber: 2, createdAt: 25 * MIN, mergedAt: 30 * MIN },
        ],
        now: 60 * MIN,
      }),
    );
    expect(e.children.map((c) => c.endedAt)).toEqual([30 * MIN, null]);
  });

  test("a child that is not done has no end, even with a merged fact", () => {
    const e = withEpicTiming(
      epic([child(2, "in-review")]),
      input({
        facts: [{ sessionId: "a", issueNumber: 2, createdAt: 0, mergedAt: 20 * MIN }],
        integratedAt: new Map([[2, 20 * MIN]]),
        now: 60 * MIN,
      }),
    );
    expect(e.children[0]!.endedAt).toBeNull();
  });
});
