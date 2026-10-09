import { describe, expect, it } from "vitest";
import {
  childDuration,
  epicGantt,
  epicTimeTiles,
  fasterSlotsHint,
  forecastBasisLines,
} from "./epic-timing-detail";
import type { Epic, EpicChild, EpicChildState, EpicForecast, EpicTiming } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
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

const PAUSED_AT = NOW - 38 * MIN; // 12:05
const paused = (status: Epic["run"]["status"] = "paused") =>
  epic(
    {
      timing: timing({ pausedAt: PAUSED_AT }),
      forecast: forecast({
        finishAt: null,
        finishLow: null,
        finishHigh: null,
        remainingMsFromResume: 320 * MIN,
        children: forecast().children.map((c) => ({
          ...c,
          projectedStart: null,
          projectedEnd: null,
        })),
      }),
    },
    status,
  );

// Every step merged before the landing: #159 the fastest (10 min), #162 the slowest (30 min).
const allMerged = () =>
  children().map((c, i) => ({
    ...c,
    state: "merged" as const,
    startedAt: START + i * 25 * MIN,
    endedAt: START + i * 25 * MIN + [20, 20, 10, 30, 20][i] * MIN,
  }));

const LANDING_AT = NOW - 6 * MIN;
const landing = () =>
  epic({
    children: allMerged(),
    timing: timing({ pausedAt: LANDING_AT, landingStartedAt: LANDING_AT }),
    forecast: forecast({
      finishAt: NOW + 14 * MIN,
      finishLow: NOW + 10 * MIN,
      finishHigh: NOW + 25 * MIN,
      children: [],
    }),
  });

const LANDED_AT = NOW - 10 * MIN;
const landed = () =>
  epic({
    children: allMerged(),
    timing: timing({
      pausedAt: LANDED_AT - 21 * MIN,
      landingStartedAt: LANDED_AT - 21 * MIN,
      landedAt: LANDED_AT,
      agentMs: 526 * MIN,
      idleMs: 12 * MIN,
    }),
    forecast: null,
  });

describe("epicTimeTiles", () => {
  it("running: run time, agent time, what is left and when it lands", () => {
    const tiles = epicTimeTiles(epic(), NOW)!;
    expect(tiles.map((t) => t.label)).toEqual([
      "Running for",
      "[[agent-time|Agent time]]",
      "Left · forecast",
      "Done around",
    ]);
    expect(tiles[0]).toMatchObject({ value: "2 h 22 min", sub: `since ${dt(START)}` });
    expect(tiles[1]).toMatchObject({ value: "2 h 14 min", sub: "8 min with no agent running" });
    expect(tiles[2]).toMatchObject({
      value: "~7 h 15 min",
      sub: "range 5 h 30 min – 9 h 30 min",
    });
    expect(tiles[3]).toEqual({
      label: "Done around",
      value: `~${hm(at(20, 0))}`,
      sub: `today · ${hm(at(18, 15))}–${hm(at(22, 15))}`,
      confidence: { rung: 1, text: "confidence low" },
    });
  });

  it("running behind plan: the finish warns and names where it stood", () => {
    const tiles = epicTimeTiles(epic({ forecast: forecast({ firstFinishAt: at(19, 30) }) }), NOW)!;
    expect(tiles[3]).toMatchObject({ tone: "warn", note: `was ~${hm(at(19, 30))}` });
  });

  it("running without a forecast: no countdown, no time", () => {
    const tiles = epicTimeTiles(epic({ forecast: null }), NOW)!;
    expect(tiles[2]).toMatchObject({
      value: "no forecast yet",
      sub: "first estimate after the first merge",
    });
    expect(tiles[3]).toEqual({ label: "Done around", value: "?" });
  });

  it("paused: ran, the pause that doesn't count, and what is left from a resume", () => {
    const tiles = epicTimeTiles(paused(), NOW)!;
    expect(tiles.map((t) => t.label)).toEqual([
      "Ran",
      "[[agent-time|Agent time]]",
      "Paused",
      "Remaining from resume",
    ]);
    expect(tiles[0].value).toBe("1 h 44 min");
    expect(tiles[2]).toMatchObject({
      value: "38 min",
      sub: `since ${hm(PAUSED_AT)} · doesn't count`,
    });
    expect(tiles[3]).toMatchObject({
      value: "~5 h 20 min",
      confidence: { rung: 1, text: "confidence low" },
    });
  });

  it("stopped: the clock stands without a pause", () => {
    expect(epicTimeTiles(paused("idle"), NOW)![2].label).toBe("Stopped");
  });

  it("landing: steps done after, the landing underway, when it lands", () => {
    const tiles = epicTimeTiles(landing(), NOW)!;
    expect(tiles.map((t) => t.label)).toEqual([
      "Steps done after",
      "[[agent-time|Agent time]]",
      "Landing",
      "Done around",
    ]);
    expect(tiles[0].value).toBe("2 h 16 min");
    expect(tiles[2]).toMatchObject({ value: "6 min", sub: "epic PR to main" });
    expect(tiles[3].value).toBe(`~${hm(at(12, 55))}`);
    expect(tiles[3].tone).toBeUndefined();
  });

  it("landed: the totals with the fastest and slowest step", () => {
    const tiles = epicTimeTiles(landed(), NOW)!;
    expect(tiles).toEqual([
      {
        label: "Total",
        value: "2 h 12 min",
        sub: `${dt(START)}–${hm(LANDED_AT)}`,
      },
      { label: "[[agent-time|Agent time]]", value: "8 h 46 min" },
      { label: "Waited / landing", value: "12 min / 21 min" },
      { label: "Fastest / slowest", value: "10 min / 30 min", sub: "#159 / #162" },
    ]);
  });

  it("is empty before the epic ran and absent without an epic clock", () => {
    expect(epicTimeTiles(epic({ timing: timing({ startedAt: null }) }, "idle"), NOW)).toEqual([]);
    expect(epicTimeTiles(epic({ timing: undefined }), NOW)).toBeNull();
  });
});

describe("epicGantt", () => {
  it("running: a row per step, the landing, the finish range and now", () => {
    const g = epicGantt(epic(), NOW)!;
    expect(g.rows.map((r) => r.key)).toEqual([
      "#160",
      "#161",
      "#159",
      "#162",
      "#163",
      "landing",
      "finish",
    ]);
    const row = (key: string) => g.rows.find((r) => r.key === key)!;

    expect(row("#160")).toMatchObject({ mark: "ok", note: "2 h 10 min", title: "Baseline" });
    expect(row("#160").bars).toEqual([{ from: 0, to: expect.any(Number), tone: "done" }]);

    expect(row("#161").mark).toBe("run");
    expect(row("#161").bars.map((b) => [b.tone, b.projected ?? false])).toEqual([
      ["run", false],
      ["run", true],
    ]);
    expect(row("#161").note).toBe("running · ~1 h 40 min left");

    expect(row("#159").bars).toEqual([expect.objectContaining({ tone: "done", projected: true })]);
    expect(row("#159").note).toBe("ready · waiting for a slot");
    expect(row("#162").note).toBe("after #161");

    expect(row("landing").bars).toEqual([
      expect.objectContaining({ tone: "landing", projected: true }),
    ]);
    expect(row("landing").note).toBe("CI and merge ~20 min");

    const finish = row("finish");
    expect(finish.title).toBe(`Epic lands ~${hm(at(20, 0))}`);
    expect(finish.note).toBe(`${hm(at(18, 15))}–${hm(at(22, 15))}`);
    expect(finish.noteSide).toBe("before");
    expect(finish.band!.from).toBeLessThan(finish.band!.at);
    expect(finish.band!.at).toBeLessThan(finish.band!.to);
    expect(finish.band!.to).toBe(1);

    expect(g.now!.label).toBe(`now ${hm(NOW)}`);
    expect(g.pause).toBeNull();
    expect(g.legend.map((l) => l.key)).toEqual(["done", "run", "forecast", "range"]);
  });

  it("puts hour ticks on the axis", () => {
    // 10:21 → 22:15: every second hour, from 12:00 to 22:00.
    expect(epicGantt(epic(), NOW)!.ticks.map((t) => t.label)).toEqual(
      [12, 14, 16, 18, 20, 22].map((h) => hm(at(h, 0))),
    );
    // A short epic gets one tick per hour: 10:21 → 15:00.
    const short = epic({ forecast: forecast({ finishAt: at(14, 0), finishHigh: at(15, 0) }) });
    expect(epicGantt(short, NOW)!.ticks.map((t) => t.label)).toEqual(
      [11, 12, 13, 14, 15].map((h) => hm(at(h, 0))),
    );
  });

  it("widens the tick step on a long epic and names the days", () => {
    const g = epicGantt(
      epic({
        children: [],
        timing: timing({
          startedAt: NOW - 72 * HOUR,
          pausedAt: NOW - 30 * MIN,
          landingStartedAt: NOW - 30 * MIN,
          landedAt: NOW,
        }),
        forecast: null,
      }),
      NOW,
    )!;
    expect(g.ticks.length).toBeLessThanOrEqual(9);
    const gaps = g.ticks.slice(1).map((t, i) => t.at - g.ticks[i].at);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.01);
    expect(g.ticks.some((t) => /\d/.test(t.label) && !t.label.includes(":"))).toBe(true);
  });

  it("paused: the pause column, nothing projected", () => {
    const g = epicGantt(paused(), NOW)!;
    expect(g.rows.map((r) => r.key)).not.toContain("landing");
    expect(g.rows.map((r) => r.key)).not.toContain("finish");
    expect(g.pause).not.toBeNull();
    expect(g.pause!.to).toBeGreaterThan(g.pause!.from);
    const running = g.rows.find((r) => r.key === "#161")!;
    expect(running.bars).toEqual([expect.objectContaining({ tone: "run" })]);
    expect(running.note).toBe("running");
    expect(g.rows.find((r) => r.key === "#159")!.note).toBe("ready");
    expect(g.legend.map((l) => l.key)).toContain("pause");
  });

  it("landing: the landing underway and its projected rest", () => {
    const g = epicGantt(landing(), NOW)!;
    const row = g.rows.find((r) => r.key === "landing")!;
    expect(row.bars.map((b) => [b.tone, b.projected ?? false])).toEqual([
      ["landing", false],
      ["landing", true],
    ]);
    expect(row.note).toBe("for 6 min");
    expect(g.rows.at(-1)!.key).toBe("finish");
    expect(g.legend.map((l) => l.key)).toEqual(["done", "forecast", "range", "landing"]);
  });

  it("landed: ends at the landing, no now line, no range", () => {
    const g = epicGantt(landed(), NOW)!;
    expect(g.now).toBeNull();
    expect(g.rows.at(-1)).toMatchObject({ key: "landing", note: "21 min" });
    expect(g.rows.at(-1)!.bars[0].to).toBe(1);
  });

  it("flips a note near the right edge before its bar", () => {
    const g = epicGantt(epic(), NOW)!;
    const late = g.rows.find((r) => r.key === "landing")!;
    expect(late.noteSide).toBe("before");
    expect(late.noteAt).toBe(late.bars[0].from);
    const early = g.rows.find((r) => r.key === "#160")!;
    expect(early.noteSide).toBe("after");
  });

  it("draws nothing before the epic ran", () => {
    expect(epicGantt(epic({ timing: timing({ startedAt: null }) }, "idle"), NOW)).toBeNull();
    expect(epicGantt(epic({ timing: undefined }), NOW)).toBeNull();
  });
});

describe("fasterSlotsHint", () => {
  it("is absent unless the forecast offers one more slot", () => {
    expect(fasterSlotsHint(epic(), NOW)).toBeNull();
  });

  it("names the step that could run alongside, the saving and the cost", () => {
    const e = epic({
      forecast: forecast({
        fasterWithSlots: { slots: 2, finishAt: at(18, 15), savedMs: 105 * MIN },
      }),
    });
    expect(fasterSlotsHint(e, NOW)).toEqual({
      title: `With 2 [[agent-slot|agent slots]] done around ~${hm(at(18, 15))} instead of ~${hm(at(20, 0))}`,
      body: "#159 depends on no other open step and could run alongside #161. Cost: one more agent works in parallel.",
      action: "Allow 2 slots",
    });
  });
});

describe("forecastBasisLines", () => {
  it("blends this epic's step with the repo median, orders by slots, adds the landing", () => {
    expect(forecastBasisLines(epic(), 1)).toEqual([
      "Each step ~1 h 45 min: blended from this epic (#160 took 2 h 10 min) and the repo's median over the last 30 days (23 tasks).",
      "Order from the dependencies; with 1 [[agent-slot|agent slot]] the steps run one after another. Plus ~20 min for the landing: epic PR to main, CI, merge.",
      "The range narrows with every finished step. While the epic is paused, the [[epic-clock|epic clock]] stands still.",
    ]);
  });

  it("reads the repo median alone before the first merge, and parallel slots", () => {
    const lines = forecastBasisLines(epic({ forecast: forecast({ epicSamples: 0 }) }), 3)!;
    expect(lines[0]).toBe(
      "Each step ~1 h 45 min: the repo's median over the last 30 days, across 23 tasks. From the first merge on, this epic's own steps count too.",
    );
    expect(lines[1]).toContain("with 3 [[agent-slot|agent slots]] up to 3 steps run at once");
  });

  it("counts several measured steps, and is absent without a forecast", () => {
    expect(forecastBasisLines(epic({ forecast: forecast({ epicSamples: 3 }) }), null)![0]).toBe(
      "Each step ~1 h 45 min: blended from this epic (3 steps measured) and the repo's median over the last 30 days (23 tasks).",
    );
    expect(forecastBasisLines(epic({ forecast: null }), 1)).toBeNull();
  });
});

describe("childDuration", () => {
  const e = epic();
  const c = (n: number) => e.children.find((x) => x.number === n)!;

  it("merged: how long it took", () => {
    expect(childDuration(c(160), e, NOW)).toEqual({ text: "2 h 10 min", tone: "done" });
  });

  it("running: its clock and what is left", () => {
    expect(childDuration(c(161), e, NOW)).toEqual({
      clock: "04:13",
      text: "~1 h 40 min left",
      tone: "run",
    });
  });

  it("waiting: the step estimate", () => {
    expect(childDuration(c(159), e, NOW)).toEqual({
      text: "~1 h 45 min · forecast",
      tone: "forecast",
    });
    expect(childDuration(c(159), epic({ forecast: null }), NOW)).toBeNull();
  });

  it("is absent without an epic clock", () => {
    expect(childDuration(c(160), epic({ timing: undefined }), NOW)).toBeNull();
  });
});
