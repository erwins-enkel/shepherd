import { describe, expect, it } from "vitest";
import { approx, dur, epicMeter, epicTimingExplanation, stepTitle } from "./epic-timing-text";
import type { Epic, EpicChild, EpicChildState, EpicForecast, EpicTiming } from "./types";

const MIN = 60_000;
// Local wall clock, so "today" and the clock labels don't depend on the runner's time zone.
const NOW = new Date(2026, 9, 9, 12, 43).getTime();
const START = NOW - 142 * MIN; // 10:21
const at = (h: number, min: number) => new Date(2026, 9, 9, h, min).getTime();
const hm = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dt = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const child = (
  number: number,
  order: number,
  state: EpicChildState,
  title: string,
  extra: Partial<EpicChild> = {},
): EpicChild => ({
  number,
  title: `Stack-Angleichung (#158): ${title}`,
  url: "",
  order,
  body: "",
  blockedBy: [],
  state,
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
  ...extra,
});

const children = (): EpicChild[] => [
  child(160, 1, "merged", "Baseline", { startedAt: START, endedAt: START + 130 * MIN }),
  child(161, 2, "running", "Bun", { startedAt: NOW - 253_000, sessionId: "s1" }),
  child(159, 3, "ready", "Testserver"),
  child(162, 4, "blocked", "Drizzle", { blockedBy: [161] }),
  child(163, 5, "blocked", "Datenzugriffe", { blockedBy: [162] }),
];

const timing = (p: Partial<EpicTiming> = {}): EpicTiming => ({
  startedAt: START,
  pausedAt: null,
  pausedMs: 0,
  landingStartedAt: null,
  landedAt: null,
  agentMs: 134 * MIN,
  idleMs: 8 * MIN,
  ...p,
});

const forecast = (p: Partial<EpicForecast> = {}): EpicForecast => ({
  finishAt: NOW + 435 * MIN, // 19:58 → "~20:00"
  finishLow: at(18, 15),
  finishHigh: at(22, 15),
  remainingMsFromResume: null,
  confidence: "low",
  stepMs: 105 * MIN,
  landingMs: 20 * MIN,
  epicSamples: 1,
  repoSamples: 23,
  firstFinishAt: NOW + 435 * MIN,
  fasterWithSlots: null,
  children: [
    { number: 161, projectedStart: NOW - 253_000, projectedEnd: NOW + 100 * MIN, overrun: false },
    { number: 159, projectedStart: NOW + 100 * MIN, projectedEnd: NOW + 205 * MIN, overrun: false },
    { number: 162, projectedStart: NOW + 205 * MIN, projectedEnd: NOW + 310 * MIN, overrun: false },
    { number: 163, projectedStart: NOW + 310 * MIN, projectedEnd: NOW + 415 * MIN, overrun: false },
  ],
  ...p,
});

const epic = (p: Partial<Epic> = {}, status: Epic["run"]["status"] = "running"): Epic => ({
  repoPath: "/repo",
  parentIssueNumber: 158,
  parentTitle: "Calendar",
  source: "native",
  children: children(),
  warnings: [],
  run: { repoPath: "/repo", parentIssueNumber: 158, mode: "auto", status },
  timing: timing(),
  forecast: forecast(),
  ...p,
});

const explain = (e: Epic, nowMs = NOW, slots: number | null = 1) =>
  epicTimingExplanation({ epic: e, nowMs, slots });
const section = (x: ReturnType<typeof explain>, label: string) =>
  x.sections.find((s) => s.label === label)!;

describe("epicTimingExplanation — running", () => {
  const x = explain(epic());

  it("leads with the run time and when the epic lands at this pace", () => {
    expect(x.title).toBe("Epic #158 running for 2 h 22 min");
    expect(x.summary).toBe(
      `1 of 5 steps merged. At this pace the epic lands today around ${hm(at(20, 0))}.`,
    );
    expect(x.sections.map((s) => s.label)).toEqual(["Time", "Forecast", "Steps"]);
  });

  it("time: started, agents active, waited without an agent", () => {
    expect(section(x, "Time").rows).toEqual([
      { text: "Started", aside: dt(START) },
      { text: "Agents active", aside: "2 h 14 min" },
      { text: "Waited, no agent ran", aside: "8 min" },
    ]);
  });

  it("forecast: remaining, finish with range, a confidence meter and the basis", () => {
    const f = section(x, "Forecast");
    expect(f.rows).toEqual([
      { text: "Remaining", aside: "~7 h 15 min" },
      { text: "Done around", aside: `~${hm(at(20, 0))}` },
      { text: "Range", aside: `${hm(at(18, 15))}–${hm(at(22, 15))}` },
      { text: "Confidence", meter: { value: 1, max: 3 }, aside: "low" },
    ]);
    expect(f.note).toBe(
      "~1 h 45 min per step, one after another (1 slot), plus ~20 min landing. 1 step measured so far.",
    );
    expect(section(explain(epic(), NOW, 3), "Forecast").note).toMatch(
      /^~1 h 45 min per step, up to 3 at once/,
    );
    expect(section(explain(epic(), NOW, null), "Forecast").note).toMatch(
      /^~1 h 45 min per step, plus/,
    );
  });

  it("steps: one full-width row per child, parent prefix stripped, in epic order", () => {
    const s = section(x, "Steps");
    expect(s.full).toBe(true);
    expect(s.rows).toEqual([
      { text: "#160 Baseline", tone: "ok", aside: "2 h 10 min" },
      { text: "#161 Bun", tone: "run", aside: "04:13 · ~1 h 40 min left" },
      { text: "#159 Testserver", aside: "ready · waiting for a slot" },
      { text: "#162 Drizzle", aside: "after #161 · ~1 h 45 min" },
      { text: "#163 Datenzugriffe", aside: "after #162 · ~1 h 45 min" },
    ]);
  });

  it("timeline: merged, running, projected steps and the landing, with a now marker", () => {
    const tl = x.timeline!;
    expect(tl.start).toBe(hm(START));
    expect(tl.end).toBe(`~${hm(at(20, 0))}`);
    expect(tl.now?.label).toBe(`now ${hm(NOW)}`);
    expect(tl.now?.at).toBeCloseTo(142 / 577, 3);
    expect(tl.segments.map((s) => `${s.tone}${s.projected ? "*" : ""}`)).toEqual([
      "done",
      "run",
      "run*",
      "done*",
      "done*",
      "done*",
      "landing*",
    ]);
    expect(tl.segments.at(-1)?.to).toBe(1);
    expect(tl.legend.map((l) => l.label)).toEqual(["merged", "running", "forecast", "landing"]);
  });

  it("footer: where, the ticking epic clock, what a click does", () => {
    expect(x.footer).toEqual([
      "/repo · Epic #158",
      `⏱ 2h 22m on the clock, ticking since ${dt(START)}`,
      "Click opens the epic in Repos.",
    ]);
  });
});

describe("epicTimingExplanation — forecast states", () => {
  it("just started: only the repo median, very low confidence", () => {
    const x = explain(
      epic({
        children: children().map((c) =>
          c.number === 160 ? { ...c, state: "running", endedAt: null } : c,
        ),
        forecast: forecast({ confidence: "very-low", epicSamples: 0, firstFinishAt: null }),
      }),
    );
    expect(x.summary).toBe(
      "0 of 5 steps merged. Until the first merge, the forecast uses only the repo median.",
    );
    const f = section(x, "Forecast");
    expect(f.rows!.at(-1)).toEqual({
      text: "Confidence",
      meter: { value: 0, max: 3 },
      aside: "very low · repo median only",
    });
    expect(f.note).toMatch(/Median over 23 tasks in this repo\.$/);
  });

  it("behind plan: a warn mark on the slipped finish and the overrunning step", () => {
    const x = explain(
      epic({
        forecast: forecast({
          finishAt: at(20, 30),
          firstFinishAt: at(20, 0),
          children: [
            {
              number: 161,
              projectedStart: NOW - 175 * MIN,
              projectedEnd: NOW + 10 * MIN,
              overrun: true,
            },
          ],
        }),
        children: children().map((c) =>
          c.number === 161 ? { ...c, startedAt: NOW - 175 * MIN } : c,
        ),
      }),
    );
    expect(x.summary).toBe(
      "1 of 5 steps merged. #161 is taking much longer than usual; the landing slips by ~30 min.",
    );
    expect(section(x, "Forecast").rows!.slice(0, 4)).toEqual([
      { text: "Done around", tone: "warn", aside: `~${hm(at(20, 30))} (so far ~${hm(at(20, 0))})` },
      { text: "#161 Bun", tone: "run", aside: "2 h 55 min" },
      { text: "usual per step", aside: "~1 h 45 min" },
      { text: "Remaining", aside: "~7 h 45 min" },
    ]);
  });

  it("no data yet: no forecast until the first merge, an open-ended strip", () => {
    const x = explain(epic({ forecast: null }));
    expect(x.summary).toBe(
      "1 of 5 steps merged. A forecast needs one finished step, in this epic or in the repo.",
    );
    expect(section(x, "Forecast").rows).toEqual([
      { text: "Remaining", aside: "no forecast yet" },
      { text: "First estimate", aside: "after the first merge" },
    ]);
    expect(x.timeline!.end).toBe("?");
    expect(x.timeline!.segments.at(-1)?.tone).toBe("unknown");
    expect(x.timeline!.now?.at).toBeCloseTo(0.25, 2);
  });
});

describe("epicTimingExplanation — clock states", () => {
  it("paused: the clock stands, the forecast counts from the resume", () => {
    const pausedAt = NOW - 38 * MIN;
    const e = epic(
      {
        timing: timing({ pausedAt }),
        forecast: forecast({
          finishAt: null,
          finishLow: null,
          finishHigh: null,
          remainingMsFromResume: 320 * MIN,
          children: [],
        }),
      },
      "paused",
    );
    const x = explain(e);
    expect(x.title).toBe(`Epic #158 paused since ${hm(pausedAt)}`);
    expect(x.summary).toMatch(/the epic clock stands and the forecast counts from the resume\.$/);
    expect(section(x, "Time").rows!.slice(0, 2)).toEqual([
      { text: "Ran", aside: "1 h 44 min" },
      { text: "Paused", aside: "38 min (doesn't count)" },
    ]);
    expect(section(x, "Forecast").rows![0]).toEqual({
      text: "Remaining from resume",
      aside: "~5 h 20 min",
    });
    expect(x.timeline!.now).toBeUndefined();
    expect(x.timeline!.segments.some((s) => s.tone === "pause")).toBe(true);
    expect(x.footer![1]).toBe(`⏱ 1h 44m on the clock, stopped at ${hm(pausedAt)}`);
    // The clock stands: a minute later the run time reads the same.
    expect(section(explain(e, NOW + MIN), "Time").rows![0]).toEqual({
      text: "Ran",
      aside: "1 h 44 min",
    });
  });

  it("landing: steps done after, the landing so far with its CI, when it lands", () => {
    const landingStartedAt = NOW - 6 * MIN;
    const x = epicTimingExplanation({
      epic: epic(
        {
          children: children().map((c) => ({
            ...c,
            state: "merged",
            startedAt: c.startedAt ?? START,
            endedAt: c.endedAt ?? landingStartedAt,
          })),
          timing: timing({ pausedAt: landingStartedAt, landingStartedAt }),
          forecast: forecast({ finishAt: NOW + 14 * MIN, children: [] }),
        },
        "idle",
      ),
      nowMs: NOW,
      slots: 1,
      landingChecks: "pending",
    });
    expect(x.title).toBe("Epic #158 is landing");
    expect(x.summary).toBe("5 of 5 steps merged. The landing PR into main is underway.");
    expect(section(x, "Time").rows).toEqual([
      { text: "Steps done after", tone: "ok", aside: "2 h 16 min" },
      { text: "Landing", tone: "run", aside: "for 6 min · CI running" },
      { text: "Done around", aside: `~${hm(at(12, 55))}` },
    ]);
    expect(x.timeline!.segments.at(-1)).toMatchObject({ tone: "landing", projected: true });
  });

  it("landed: the totals", () => {
    const landingStartedAt = START + 538 * MIN;
    const landedAt = START + 559 * MIN; // 9 h 19 min after the start
    const x = explain(
      epic(
        {
          children: children().map((c) => ({ ...c, state: "merged" })),
          timing: timing({
            pausedAt: landingStartedAt,
            landingStartedAt,
            landedAt,
            agentMs: 526 * MIN,
            idleMs: 12 * MIN,
          }),
          forecast: null,
        },
        "idle",
      ),
      landedAt + 5 * MIN,
    );
    expect(x.title).toBe("Epic #158 landed after 9 h 19 min");
    expect(x.summary).toBe(`5 of 5 steps merged. Started ${dt(START)}, landed ${hm(landedAt)}.`);
    expect(section(x, "Totals").rows).toEqual([
      { text: "Started", aside: dt(START) },
      { text: "Agent time", aside: "8 h 46 min" },
      { text: "Waited, no agent ran", aside: "12 min" },
      { text: "Landing", aside: "21 min" },
    ]);
    expect(x.timeline!.end).toBe(hm(landedAt));
    expect(x.timeline!.now).toBeUndefined();
  });

  it("unstarted and older servers: counts and steps only", () => {
    const unstarted = explain(
      epic({ timing: timing({ startedAt: null }), forecast: null }, "idle"),
    );
    expect(unstarted.title).toBe("Epic #158 has not started yet");
    expect(unstarted.timeline).toBeUndefined();
    expect(unstarted.sections.map((s) => s.label)).toEqual(["Steps"]);
    expect(unstarted.footer).toEqual(["/repo · Epic #158", "Click opens the epic in Repos."]);
    const plain = explain(epic({ timing: undefined, forecast: undefined }, "idle"));
    expect(plain.title).toBe("Epic #158");
    expect(plain.summary).toBe("1 of 5 steps merged.");
  });
});

describe("epicMeter / stepTitle / durations", () => {
  it("meter: one segment per child in epic order; in review counts as running", () => {
    const kids = [
      child(3, 3, "ready", "c"),
      child(1, 1, "merged", "a"),
      child(2, 2, "in-review", "b"),
      child(4, 4, "running", "d"),
      child(5, 5, "blocked", "e"),
    ];
    expect(epicMeter(kids)).toEqual(["merged", "running", "rest", "running", "rest"]);
  });

  it("strips a prefix only when it names the parent", () => {
    expect(stepTitle("Stack-Angleichung (#158): Bun", 158)).toBe("Bun");
    expect(stepTitle("Epic #158: Bun", 158)).toBe("Bun");
    expect(stepTitle("Fix #1580: Bun", 158)).toBe("Fix #1580: Bun");
    expect(stepTitle("Docs: Bun", 158)).toBe("Docs: Bun");
  });

  it("formats measured and projected durations", () => {
    expect(dur(8.9 * MIN)).toBe("8 min");
    expect(dur(120 * MIN)).toBe("2 h");
    expect(dur(142 * MIN)).toBe("2 h 22 min");
    expect(dur(28 * 60 * MIN)).toBe("1 d 4 h");
    expect(approx(20 * 1000)).toBe("1 min");
    expect(approx(103 * MIN)).toBe("1 h 45 min");
  });
});
