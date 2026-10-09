import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type {
  Epic,
  EpicChild,
  EpicChildState,
  EpicForecast,
  EpicSummary,
  EpicTiming,
} from "#lib/types.js";

const { default: EpicBadge } = await import("./EpicBadge.svelte");

const MIN = 60_000;
const NOW = new Date(2026, 9, 9, 12, 43).getTime();
const START = NOW - 142 * MIN;
/** The running fixture's finish, rounded to 5 min: NOW + 435 min → 19:58 → 20:00. */
const AT_2000 = new Date(2026, 9, 9, 20, 0).getTime();
const hm = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const summary = (p: Partial<EpicSummary> = {}): EpicSummary => ({
  parentIssueNumber: 327,
  parentTitle: "Epic",
  total: 5,
  merged: 2,
  status: "idle",
  source: "native",
  ...p,
});

const child = (state: EpicChildState, number: number, p: Partial<EpicChild> = {}): EpicChild => ({
  number,
  title: `Epic (#327): c${number}`,
  url: "",
  order: number,
  body: "",
  blockedBy: [],
  state,
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
  ...p,
});

const epic = (children: EpicChild[], p: Partial<Epic> = {}): Epic => ({
  repoPath: "/repo",
  parentIssueNumber: 327,
  parentTitle: "Epic",
  source: "native",
  children,
  warnings: [],
  run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "idle" },
  ...p,
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
  finishLow: NOW + 330 * MIN,
  finishHigh: NOW + 570 * MIN,
  remainingMsFromResume: null,
  confidence: "low",
  stepMs: 105 * MIN,
  landingMs: 20 * MIN,
  epicSamples: 1,
  repoSamples: 23,
  firstFinishAt: NOW + 435 * MIN,
  fasterWithSlots: null,
  children: [
    { number: 2, projectedStart: NOW - 10 * MIN, projectedEnd: NOW + 95 * MIN, overrun: false },
    { number: 3, projectedStart: NOW + 95 * MIN, projectedEnd: NOW + 200 * MIN, overrun: false },
  ],
  ...p,
});

const kids = () => [
  child("merged", 1, { startedAt: START, endedAt: START + 130 * MIN }),
  child("running", 2, { startedAt: NOW - 10 * MIN, sessionId: "s" }),
  child("ready", 3),
];

/** A live, running epic; `p` overrides any field. */
const running = (p: Partial<Epic> = {}) =>
  epic(kids(), {
    run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" },
    timing: timing(),
    forecast: forecast(),
    ...p,
  });

const badge = () => document.querySelector<HTMLButtonElement>(".epic-badge")!;
const segs = () =>
  [...document.querySelectorAll(".epic-seg")].map((s) => s.className.match(/seg-(\w+)/)![1]);

// Hover opens the panel after the shared rest delay; return it once open.
async function hoverOpen() {
  badge().dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  await expect.poll(() => document.querySelector(".status-tip:popover-open")).not.toBeNull();
  return document.querySelector<HTMLElement>(".status-tip")!;
}
const title = (panel: HTMLElement) => panel.querySelector(".tooltip-title")?.textContent;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EpicBadge", () => {
  it("renders EPIC merged/total from the summary when no live Epic", async () => {
    render(EpicBadge, { summary: summary(), repoPath: "/repo", issueNumber: 327, nowMs: NOW });
    await expect.element(page.getByText("EPIC 2/5")).toBeInTheDocument();
  });

  it("prefers live Epic counts over the summary", async () => {
    // summary says 2/5, but live has 4 children, 1 merged → EPIC 1/4
    const live = epic([
      child("merged", 1),
      child("in-review", 2),
      child("running", 3),
      child("ready", 4),
    ]);
    render(EpicBadge, {
      summary: summary({ total: 5, merged: 2 }),
      live,
      repoPath: "/repo",
      issueNumber: 327,
      nowMs: NOW,
    });
    await expect.element(page.getByText("EPIC 1/4")).toBeInTheDocument();
  });

  it("carries no native title — the styled panel is the only hover text", async () => {
    render(EpicBadge, { live: running(), repoPath: "/repo", issueNumber: 327, nowMs: NOW });
    await expect.element(page.getByText("EPIC 1/3")).toBeInTheDocument();
    expect(badge().hasAttribute("title")).toBe(false);
    expect(badge().getAttribute("aria-label")).toBe(
      "Open epic #327 in Repos (1 of 3 sub-issues done)",
    );
  });

  it("a mouse click calls onepic with (repoPath, issueNumber)", async () => {
    const onepic = vi.fn();
    render(EpicBadge, {
      summary: summary(),
      repoPath: "/myrepo",
      issueNumber: 42,
      nowMs: NOW,
      onepic,
    });
    badge().click();
    expect(onepic).toHaveBeenCalledTimes(1);
    expect(onepic).toHaveBeenCalledWith("/myrepo", 42);
  });
});

describe("EpicBadge segment meter", () => {
  it("one segment per child in epic order: merged, running (also in review), rest", async () => {
    const live = epic([
      child("ready", 4),
      child("merged", 1),
      child("in-review", 2),
      child("running", 3),
      child("blocked", 5),
    ]);
    render(EpicBadge, { live, repoPath: "/repo", issueNumber: 327, nowMs: NOW });
    await expect.element(page.getByText("EPIC 1/5")).toBeInTheDocument();
    expect(segs()).toEqual(["merged", "running", "running", "rest", "rest"]);
  });

  it("from the summary alone: merged first, then the rest", async () => {
    render(EpicBadge, { summary: summary(), repoPath: "/repo", issueNumber: 327, nowMs: NOW });
    await expect.element(page.getByText("EPIC 2/5")).toBeInTheDocument();
    expect(segs()).toEqual(["merged", "merged", "rest", "rest", "rest"]);
  });

  it("total: 0 renders no segments without error", async () => {
    render(EpicBadge, {
      summary: summary({ total: 0, merged: 0 }),
      repoPath: "/repo",
      issueNumber: 327,
      nowMs: NOW,
    });
    await expect.element(page.getByText("EPIC 0/0")).toBeInTheDocument();
    expect(segs()).toEqual([]);
  });
});

describe("EpicBadge hover panel", () => {
  const show = (live: Epic, slots: number | null = 1) =>
    render(EpicBadge, { live, repoPath: "/repo", issueNumber: 327, nowMs: NOW, slots });

  it("running: time, forecast, steps, the timeline and the clock footer", async () => {
    show(running());
    const panel = await hoverOpen();
    expect(panel.classList.contains("status-tip-panel")).toBe(true);
    expect(title(panel)).toBe("Epic #327 running for 2 h 22 min");
    expect(panel.querySelector(".tooltip-summary")?.textContent).toBe(
      `1 of 3 steps merged. At this pace the epic lands today around ${hm(AT_2000)}.`,
    );
    const labels = [...panel.querySelectorAll(".tooltip-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Time", "Forecast", "Steps"]);
    expect(panel.querySelector(".tooltip-section.full")?.textContent).toContain("#2 c2");
    expect(panel.querySelectorAll(".tooltip-meter-cell.on")).toHaveLength(1);
    expect(panel.textContent).toContain("~1 h 45 min per step, one after another (1 slot)");
    expect(panel.querySelector(".tl-now")).not.toBeNull();
    expect(panel.querySelector(".tl-now-label")?.textContent).toBe(`now ${hm(NOW)}`);
    const footer = panel.querySelector(".tooltip-footer")!.textContent!;
    expect(footer).toContain("2h 22m on the clock, ticking since");
    expect(footer).toContain("Click opens the epic in Repos.");
  });

  it("just started: very low confidence on the repo median only", async () => {
    show(running({ forecast: forecast({ confidence: "very-low", epicSamples: 0 }) }));
    const panel = await hoverOpen();
    expect(panel.textContent).toContain("very low · repo median only");
    expect(panel.querySelectorAll(".tooltip-meter-cell.on")).toHaveLength(0);
  });

  it("behind plan: a warn mark on the slipped finish and the overrunning step", async () => {
    show(
      running({
        forecast: forecast({
          finishAt: NOW + 465 * MIN,
          firstFinishAt: NOW + 435 * MIN,
          children: [
            {
              number: 2,
              projectedStart: NOW - 10 * MIN,
              projectedEnd: NOW + 5 * MIN,
              overrun: true,
            },
          ],
        }),
      }),
    );
    const panel = await hoverOpen();
    expect(panel.querySelector(".tooltip-summary")?.textContent).toContain(
      "#2 is taking much longer than usual; the landing slips by ~30 min.",
    );
    const warn = panel.querySelector(".tooltip-row.tone-warn")!;
    expect(warn.textContent).toContain("Done around");
    expect(warn.textContent).toContain("so far ~");
    expect(panel.textContent).toContain("usual per step");
  });

  it("paused: the clock stands and the rest counts from the resume", async () => {
    const pausedAt = NOW - 38 * MIN;
    show(
      running({
        run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "paused" },
        timing: timing({ pausedAt }),
        forecast: forecast({
          finishAt: null,
          finishLow: null,
          finishHigh: null,
          remainingMsFromResume: 320 * MIN,
          children: [],
        }),
      }),
    );
    const panel = await hoverOpen();
    expect(title(panel)).toBe(`Epic #327 paused since ${hm(pausedAt)}`);
    expect(panel.textContent).toContain("Remaining from resume");
    expect(panel.textContent).toContain("38 min (doesn't count)");
    expect(panel.querySelector(".tl-now")).toBeNull();
    expect(panel.querySelector(".tooltip-footer")?.textContent).toContain(
      `stopped at ${hm(pausedAt)}`,
    );
  });

  it("landing: steps done after, the landing so far", async () => {
    const landingStartedAt = NOW - 6 * MIN;
    show(
      epic(
        kids().map((c) => ({ ...c, state: "merged", startedAt: START, endedAt: landingStartedAt })),
        {
          timing: timing({ pausedAt: landingStartedAt, landingStartedAt }),
          forecast: forecast({ finishAt: NOW + 14 * MIN, children: [] }),
        },
      ),
    );
    const panel = await hoverOpen();
    expect(title(panel)).toBe("Epic #327 is landing");
    expect(panel.textContent).toContain("Steps done after");
    expect(panel.textContent).toContain("for 6 min");
  });

  it("landed: the totals", async () => {
    const landingStartedAt = START + 538 * MIN;
    const landedAt = START + 559 * MIN;
    render(EpicBadge, {
      live: epic(
        kids().map((c) => ({ ...c, state: "merged" })),
        {
          timing: timing({ pausedAt: landingStartedAt, landingStartedAt, landedAt }),
          forecast: null,
        },
      ),
      repoPath: "/repo",
      issueNumber: 327,
      nowMs: landedAt + 5 * MIN,
    });
    const panel = await hoverOpen();
    expect(title(panel)).toBe("Epic #327 landed after 9 h 19 min");
    const labels = [...panel.querySelectorAll(".tooltip-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Totals", "Steps"]);
    expect(panel.textContent).toContain("Agent time");
  });

  it("no data yet: no forecast until the first merge", async () => {
    show(running({ forecast: null }));
    const panel = await hoverOpen();
    expect(panel.textContent).toContain("no forecast yet");
    expect(panel.textContent).toContain("after the first merge");
    expect(panel.querySelector(".tl-unknown")).not.toBeNull();
  });

  it("opens from the keyboard and closes on Escape", async () => {
    render(EpicBadge, { live: running(), repoPath: "/repo", issueNumber: 327, nowMs: NOW });
    await expect.element(page.getByText("EPIC 1/3")).toBeInTheDocument();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(badge());
    await expect
      .poll(() => document.querySelector(".status-tip")?.matches(":popover-open"))
      .toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".status-tip")?.matches(":popover-open")).toBe(false);
  });

  it("touch: the first tap previews the panel, the second opens the epic", async () => {
    const onepic = vi.fn();
    render(EpicBadge, {
      live: running(),
      repoPath: "/repo",
      issueNumber: 327,
      nowMs: NOW,
      onepic,
    });
    await expect.element(page.getByText("EPIC 1/3")).toBeInTheDocument();
    const tap = () => {
      badge().dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
      );
      badge().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    };
    tap();
    expect(onepic).not.toHaveBeenCalled();
    expect(document.querySelector(".status-tip")?.matches(":popover-open")).toBe(true);
    tap();
    expect(onepic).toHaveBeenCalledWith("/repo", 327);
    expect(document.querySelector(".status-tip")?.matches(":popover-open")).toBe(false);
  });
});
