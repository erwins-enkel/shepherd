import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Epic, EpicChild, EpicChildState, EpicRunStatus, EpicTiming } from "../src/epic-core";
import { forecastEpic, type EpicForecastInput } from "../src/epic-forecast";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const ago = (min: number) => NOW - min * MIN;
const ahead = (min: number) => NOW + min * MIN;

afterEach(() => setSystemTime());

function child(number: number, state: EpicChildState, c: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `child ${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: state === "running" || state === "in-review" ? `s${number}` : null,
    prNumber: null,
    issueClosed: state === "merged",
    integrationMerged: false,
    claimed: false,
    startedAt: null,
    endedAt: null,
    ...c,
  };
}

function epic(
  children: EpicChild[],
  status: EpicRunStatus = "running",
  timing: Partial<EpicTiming> = {},
): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 1,
    parentTitle: "epic",
    source: "native",
    children,
    warnings: [],
    run: { repoPath: "/repo", parentIssueNumber: 1, mode: "auto", status },
    timing: {
      startedAt: ago(300),
      pausedAt: status === "running" ? null : ago(1),
      pausedMs: 0,
      landingStartedAt: null,
      landedAt: null,
      agentMs: 0,
      idleMs: 0,
      ...timing,
    },
  };
}

/** Repo median 60 min over 10 tasks, one slot, nothing landed before. */
function input(i: Partial<EpicForecastInput> = {}): EpicForecastInput {
  return {
    repoLeadTime: { value: 60 * MIN, n: 10 },
    maxAuto: 1,
    slotsUsed: 0,
    landingMs: [],
    firstFinishAt: null,
    now: NOW,
    ...i,
  };
}

/** 1/5 merged (in 90 min), #2 running for 30 min, #3–#5 each blocked by the one before. */
function chain(status: EpicRunStatus = "running"): Epic {
  return epic(
    [
      child(1, "merged", { startedAt: ago(150), endedAt: ago(60) }),
      child(2, "running", { blockedBy: [1], startedAt: ago(30) }),
      child(3, "blocked", { blockedBy: [2] }),
      child(4, "blocked", { blockedBy: [3] }),
      child(5, "blocked", { blockedBy: [4] }),
    ],
    status,
  );
}

describe("forecastEpic — design-board cases", () => {
  test("fresh epic: the repo median alone, very-low, widened range", () => {
    const f = forecastEpic(
      epic([child(1, "ready"), child(2, "ready"), child(3, "ready")]),
      input(),
    )!;
    // Three 60-min steps through one slot, then the 20-min default landing.
    expect(f.finishAt).toBe(ahead(200));
    expect(f.finishLow).toBe(ahead(3 * 45 + 20));
    expect(f.finishHigh).toBe(ahead(3 * 81 + 20));
    expect(f).toMatchObject({
      remainingMsFromResume: null,
      confidence: "very-low",
      stepMs: 60 * MIN,
      landingMs: 20 * MIN,
      epicSamples: 0,
      repoSamples: 10,
      firstFinishAt: null,
      fasterWithSlots: null,
    });
    expect(f.children.map((c) => [c.number, c.projectedStart, c.projectedEnd])).toEqual([
      [1, NOW, ahead(60)],
      [2, ahead(60), ahead(120)],
      [3, ahead(120), ahead(180)],
    ]);
  });

  test("1/5 merged with 1 slot: the sequential chain", () => {
    const f = forecastEpic(chain(), input())!;
    // Step = mean(60, 60, 90) = 70; #2 has 40 left; #3–#5 follow one by one; landing 20.
    expect(f.stepMs).toBe(70 * MIN);
    expect(f.finishAt).toBe(ahead(40 + 3 * 70 + 20));
    expect(f.children).toEqual([
      { number: 2, projectedStart: ago(30), projectedEnd: ahead(40), overrun: false },
      { number: 3, projectedStart: ahead(40), projectedEnd: ahead(110), overrun: false },
      { number: 4, projectedStart: ahead(110), projectedEnd: ahead(180), overrun: false },
      { number: 5, projectedStart: ahead(180), projectedEnd: ahead(250), overrun: false },
    ]);
    // p25 60 / p75 75 of (60, 60, 90), widened with one own sample to 52.5 / 94.5.
    expect(f.finishLow).toBe(ahead(52.5 - 30 + 3 * 52.5 + 20));
    expect(f.finishHigh).toBe(ahead(94.5 - 30 + 3 * 94.5 + 20));
    expect(f.confidence).toBe("low");
    expect(f.epicSamples).toBe(1);
    // The first forecast after the first merge becomes the drift anchor.
    expect(f.firstFinishAt).toBe(f.finishAt);
    expect(f.fasterWithSlots).toBeNull();
  });

  test("2 slots and an independent ready child held by the cap: fasterWithSlots", () => {
    const e = epic([
      child(1, "running", { startedAt: ago(10) }),
      child(2, "running", { startedAt: ago(20) }),
      child(3, "ready"),
    ]);
    const f = forecastEpic(e, input({ maxAuto: 2, slotsUsed: 2 }))!;
    // #3 waits for #2 (40 min left), ends at 100; with a third slot it ends at 60.
    expect(f.finishAt).toBe(ahead(120));
    expect(f.fasterWithSlots).toEqual({ slots: 3, finishAt: ahead(80), savedMs: 40 * MIN });
  });

  test("no what-if when the cap does not hold the ready child, or the slot saves < 15 min", () => {
    const e = epic([
      child(1, "running", { startedAt: ago(10) }),
      child(2, "running", { startedAt: ago(20) }),
      child(3, "ready"),
    ]);
    expect(forecastEpic(e, input({ maxAuto: 2, slotsUsed: 1 }))!.fasterWithSlots).toBeNull();
    const almostDone = epic([
      child(1, "running", { startedAt: ago(10) }),
      child(2, "running", { startedAt: ago(55) }),
      child(3, "ready"),
    ]);
    // #2 has 6 min left (the 10 % floor): the third slot saves only 6 min.
    expect(
      forecastEpic(almostDone, input({ maxAuto: 2, slotsUsed: 2 }))!.fasterWithSlots,
    ).toBeNull();
  });

  test("a running child at 1.7× its estimate: overrun, and it ends later than planned", () => {
    const f = forecastEpic(epic([child(1, "running", { startedAt: ago(102) })]), input())!;
    expect(f.children).toEqual([
      // Never less than 10 % of the estimate left — past startedAt + estimate (ago(42)).
      { number: 1, projectedStart: ago(102), projectedEnd: ahead(6), overrun: true },
    ]);
    expect(f.finishAt).toBe(ahead(6 + 20));
    const onTime = forecastEpic(epic([child(1, "running", { startedAt: ago(72) })]), input())!;
    expect(onTime.children[0]!.overrun).toBe(false);
  });

  test("paused: no absolute finish, the remainder from a resume instead", () => {
    const f = forecastEpic(chain("paused"), input())!;
    expect(f).toMatchObject({
      finishAt: null,
      finishLow: null,
      finishHigh: null,
      remainingMsFromResume: (40 + 3 * 70 + 20) * MIN,
      fasterWithSlots: null,
      // Nothing to anchor drift to while the clock is stopped.
      firstFinishAt: null,
    });
    expect(f.children.every((c) => c.projectedStart === null && c.projectedEnd === null)).toBe(
      true,
    );
  });

  test("landing in progress: only the landing's remainder, from past landings", () => {
    const done = [1, 2, 3].map((n) =>
      child(n, "merged", { startedAt: ago(200), endedAt: ago(100) }),
    );
    const landing = (since: number) =>
      forecastEpic(epic(done, "idle", { landingStartedAt: ago(since) }), {
        ...input({ landingMs: [10 * MIN, 30 * MIN, 50 * MIN] }),
      })!;
    const f = landing(5);
    expect(f).toMatchObject({
      finishAt: ahead(25),
      finishLow: ahead(25),
      finishHigh: ahead(25),
      landingMs: 30 * MIN,
      confidence: "high",
      children: [],
    });
    // A landing past its estimate keeps the 10 % floor.
    expect(landing(40).finishAt).toBe(ahead(3));
  });

  test("no data anywhere: no forecast", () => {
    const e = epic([child(1, "running", { startedAt: ago(10) }), child(2, "ready")]);
    expect(forecastEpic(e, input({ repoLeadTime: { value: null, n: 0 } }))).toBeNull();
  });
});

describe("forecastEpic — model details", () => {
  test("a landed epic has nothing left to forecast", () => {
    const e = epic([child(1, "merged")], "idle", { landingStartedAt: ago(30), landedAt: ago(5) });
    expect(forecastEpic(e, input())).toBeNull();
  });

  test("no repo median: this epic's own samples alone", () => {
    const e = epic([
      child(1, "merged", { startedAt: ago(100), endedAt: ago(60) }),
      child(2, "merged", { startedAt: ago(60), endedAt: ago(0) }),
      child(3, "ready"),
      child(4, "ready"),
      child(5, "ready"),
    ]);
    const f = forecastEpic(e, input({ repoLeadTime: { value: null, n: 0 } }))!;
    expect(f.stepMs).toBe(50 * MIN);
    expect(f.repoSamples).toBe(0);
    expect(f.confidence).toBe("medium");
  });

  test("confidence climbs with own samples, and is high once half the children merged", () => {
    const merged = (n: number) => child(n, "merged", { startedAt: ago(100 + n), endedAt: ago(n) });
    const of = (children: EpicChild[]) => forecastEpic(epic(children), input())!.confidence;
    const open = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => child(from + i, "ready"));
    expect(of(open(1, 9))).toBe("very-low");
    expect(of([merged(1), ...open(2, 8)])).toBe("low");
    expect(of([merged(1), merged(2), ...open(3, 7)])).toBe("medium");
    expect(of([merged(1), merged(2), merged(3), ...open(4, 6)])).toBe("medium");
    expect(of([merged(1), merged(2), merged(3), merged(4), ...open(5, 5)])).toBe("high");
    // Half merged, though none of them measured.
    expect(of([child(1, "merged"), child(2, "merged"), ...open(3, 2)])).toBe("high");
  });

  test("three or more own samples: the blend's raw p25 / p75, no widening", () => {
    const e = epic([
      child(1, "merged", { startedAt: ago(40), endedAt: ago(0) }),
      child(2, "merged", { startedAt: ago(60), endedAt: ago(0) }),
      child(3, "merged", { startedAt: ago(80), endedAt: ago(0) }),
      child(4, "ready"),
    ]);
    const f = forecastEpic(e, input({ repoLeadTime: { value: null, n: 0 } }))!;
    expect(f.finishAt).toBe(ahead(60 + 20));
    expect(f.finishLow).toBe(ahead(50 + 20));
    expect(f.finishHigh).toBe(ahead(70 + 20));
  });

  test("an in-review child whose session is gone holds no slot", () => {
    const awaitingMerge = (sessionId: string | null) =>
      forecastEpic(
        epic([child(1, "in-review", { sessionId, startedAt: ago(0) }), child(2, "ready")]),
        input(),
      )!.finishAt;
    expect(awaitingMerge(null)).toBe(ahead(60 + 20));
    expect(awaitingMerge("s1")).toBe(ahead(120 + 20));
  });

  test("a dependency cycle still terminates, starting the first child of it", () => {
    const f = forecastEpic(
      epic([child(1, "blocked", { blockedBy: [2] }), child(2, "blocked", { blockedBy: [1] })]),
      input({ maxAuto: 2 }),
    )!;
    expect(f.finishAt).toBe(ahead(120 + 20));
  });

  test("a persisted drift anchor is passed through unchanged", () => {
    expect(forecastEpic(chain(), input({ firstFinishAt: ahead(90) }))!.firstFinishAt).toBe(
      ahead(90),
    );
  });

  test("deterministic for a given now: the wall clock plays no part", () => {
    setSystemTime(new Date(NOW - 7 * 86_400_000));
    const before = forecastEpic(chain(), input({ maxAuto: 2, slotsUsed: 2 }));
    setSystemTime(new Date(NOW + 7 * 86_400_000));
    expect(forecastEpic(chain(), input({ maxAuto: 2, slotsUsed: 2 }))).toEqual(before);
  });
});
