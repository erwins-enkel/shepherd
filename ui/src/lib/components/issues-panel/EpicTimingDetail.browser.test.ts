import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import EpicTimingDetail from "./EpicTimingDetail.svelte";
import { automationFocus } from "#lib/automation-focus.js";
import { m } from "#lib/paraglide/messages.js";
import type { Epic, EpicChild, EpicChildState, EpicForecast, EpicTiming } from "#lib/types.js";

const MIN = 60_000;
// Local wall clock, so the clock labels don't depend on the runner's time zone.
const NOW = new Date(2026, 9, 9, 12, 43).getTime();
const START = NOW - 142 * MIN; // 10:21
const at = (h: number, min: number) => new Date(2026, 9, 9, h, min).getTime();
const hm = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const child = (
  number: number,
  order: number,
  state: EpicChildState,
  title: string,
  extra: Partial<EpicChild> = {},
): EpicChild => ({
  number,
  title,
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
  finishAt: NOW + 435 * MIN,
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
  ],
  ...p,
});

const epic = (p: Partial<Epic> = {}, status: Epic["run"]["status"] = "running"): Epic => ({
  repoPath: "/repo",
  parentIssueNumber: 158,
  parentTitle: "Calendar",
  source: "native",
  children: [
    child(160, 1, "merged", "Baseline", { startedAt: START, endedAt: START + 130 * MIN }),
    child(161, 2, "running", "Bun", { startedAt: NOW - 253_000, sessionId: "s1" }),
    child(159, 3, "ready", "Testserver"),
    child(162, 4, "blocked", "Drizzle", { blockedBy: [161] }),
  ],
  warnings: [],
  run: { repoPath: "/repo", parentIssueNumber: 158, mode: "auto", status },
  timing: timing(),
  forecast: forecast(),
  ...p,
});

const faster = () =>
  epic({
    forecast: forecast({ fasterWithSlots: { slots: 2, finishAt: at(18, 15), savedMs: 105 * MIN } }),
  });

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const allowButton = () => page.getByRole("button", { name: "Allow 2 slots" });

beforeEach(async () => {
  await page.viewport(1100, 800);
});

describe("EpicTimingDetail — ZEIT", () => {
  it("shows the four running tiles", async () => {
    render(EpicTimingDetail, { epic: epic(), nowMs: NOW, slots: 1 });

    await expect.element(page.getByText("Running for")).toBeVisible();
    await expect.element(page.getByText("2 h 22 min", { exact: true })).toBeVisible();
    await expect.element(page.getByText("2 h 14 min", { exact: true })).toBeVisible();
    await expect.element(page.getByText("8 min with no agent running")).toBeVisible();
    await expect.element(page.getByText("~7 h 15 min", { exact: true })).toBeVisible();
    await expect.element(page.getByText("range 5 h 30 min – 9 h 30 min")).toBeVisible();
    await expect.element(page.getByText(`~${hm(at(20, 0))}`, { exact: true })).toBeVisible();
    await expect.element(page.getByText("confidence low")).toBeVisible();
    expect(document.querySelectorAll(".tile")).toHaveLength(4);
    expect(document.querySelectorAll(".tile .cell.on")).toHaveLength(1);
  });

  it("shows the totals once landed, with no now line", async () => {
    const e = epic({
      children: [
        child(160, 1, "merged", "Baseline", { startedAt: START, endedAt: START + 20 * MIN }),
        child(161, 2, "merged", "Bun", { startedAt: START + 25 * MIN, endedAt: START + 75 * MIN }),
      ],
      timing: timing({
        pausedAt: NOW - 30 * MIN,
        landingStartedAt: NOW - 30 * MIN,
        landedAt: NOW - 10 * MIN,
      }),
      forecast: null,
    });
    render(EpicTimingDetail, { epic: e, nowMs: NOW });

    await expect.element(page.getByText("Fastest / slowest")).toBeVisible();
    await expect.element(page.getByText("20 min / 50 min")).toBeVisible();
    expect(q(".now")).toBeNull();
    expect(q('[data-row="finish"]')).toBeNull();
  });

  it("says the clock has not started before the epic ran", async () => {
    render(EpicTimingDetail, {
      epic: epic({ timing: timing({ startedAt: null }) }, "idle"),
      nowMs: NOW,
    });

    await expect.element(page.getByText(m.epic_tip_summary_unstarted())).toBeVisible();
    expect(q(".tile")).toBeNull();
    expect(q(".timeline")).toBeNull();
  });

  it("renders nothing without the epic clock", async () => {
    render(EpicTimingDetail, { epic: epic({ timing: undefined }), nowMs: NOW });

    expect(q(".epic-timing")).toBeNull();
  });
});

describe("EpicTimingDetail — ZEITLEISTE", () => {
  it("draws merged, running, projected, landing and range rows", async () => {
    render(EpicTimingDetail, { epic: epic(), nowMs: NOW, slots: 1 });

    await expect.element(page.getByText("2 h 10 min", { exact: true })).toBeVisible();
    expect(q('[data-row="#160"] .bar-done:not(.projected)')).not.toBeNull();
    expect(q('[data-row="#161"] .bar-run:not(.projected)')).not.toBeNull();
    expect(q('[data-row="#161"] .bar-run.projected')).not.toBeNull();
    await expect.element(page.getByText("running · ~1 h 40 min left")).toBeVisible();
    expect(q('[data-row="#159"] .bar-done.projected')).not.toBeNull();
    await expect.element(page.getByText("ready · waiting for a slot")).toBeVisible();
    await expect.element(page.getByText("after #161")).toBeVisible();
    expect(q('[data-row="landing"] .bar-landing.projected')).not.toBeNull();
    await expect.element(page.getByText("Landing · epic PR to main")).toBeVisible();
    expect(q('[data-row="finish"] .band')).not.toBeNull();
    expect(q('[data-row="finish"] .band-tick')).not.toBeNull();
    await expect.element(page.getByText(`now ${hm(NOW)}`)).toBeVisible();
    expect(q(".now")).not.toBeNull();
    for (const label of ["merged", "running", "forecast", "range"])
      await expect
        .element(page.getByRole("listitem").filter({ hasText: label }).first())
        .toBeVisible();
  });

  it("marks the pause and projects nothing while paused", async () => {
    const e = epic(
      {
        timing: timing({ pausedAt: NOW - 38 * MIN }),
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
      "paused",
    );
    render(EpicTimingDetail, { epic: e, nowMs: NOW });

    await expect.element(page.getByText("Remaining from resume")).toBeVisible();
    expect(q(".pause")).not.toBeNull();
    expect(q(".bar.projected")).toBeNull();
    expect(q('[data-row="finish"]')).toBeNull();
  });
});

describe("EpicTimingDetail — faster with slots", () => {
  it("is absent without the forecast's what-if", async () => {
    render(EpicTimingDetail, { epic: epic(), nowMs: NOW, onopenautomation: vi.fn() });

    await expect.element(page.getByText("Running for")).toBeVisible();
    expect(allowButton().query()).toBeNull();
    expect(page.getByText(/one more agent works in parallel/).query()).toBeNull();
  });

  it("explains the saving and opens Automation at the slot cap", async () => {
    const onopenautomation = vi.fn();
    render(EpicTimingDetail, { epic: faster(), nowMs: NOW, onopenautomation });

    await expect
      .element(page.getByText(/#159 depends on no other open step and could run alongside #161/))
      .toBeVisible();
    await allowButton().click();

    expect(onopenautomation).toHaveBeenCalledOnce();
    expect(automationFocus.take("max-auto")).toBe(true);
  });
});

describe("EpicTimingDetail — how the forecast is made", () => {
  it("opens the three basis lines", async () => {
    render(EpicTimingDetail, { epic: epic(), nowMs: NOW, slots: 1 });

    await page.getByText(m.epicdetail_basis_title()).click();
    await expect
      .element(page.getByText(/blended from this epic \(#160 took 2 h 10 min\)/))
      .toBeVisible();
    await expect.element(page.getByText(/the steps run one after another/)).toBeVisible();
    await expect
      .element(page.getByText(/The range narrows with every finished step/))
      .toBeVisible();
  });
});

describe("EpicTimingDetail — phone width", () => {
  it("wraps the tiles 2×2 and scrolls the chart in its own box, not the page", async () => {
    await page.viewport(360, 740);
    render(EpicTimingDetail, { epic: faster(), nowMs: NOW, slots: 1, onopenautomation: vi.fn() });

    await expect.element(page.getByText("Running for")).toBeVisible();
    const tops = [...document.querySelectorAll(".tile")].map((t) => t.getBoundingClientRect().top);
    expect(tops).toHaveLength(4);
    expect(tops[1]).toBe(tops[0]);
    expect(tops[2]).toBeGreaterThan(tops[0]);
    expect(tops[3]).toBe(tops[2]);

    const scroll = q(".gantt-scroll")!;
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    const root = document.documentElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  });
});
