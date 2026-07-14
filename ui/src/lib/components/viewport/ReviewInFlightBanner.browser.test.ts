import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import { reviews, planGates, repoConfig } from "$lib/reviews.svelte";
import type { PlanGate, ReviewVerdict } from "$lib/types";

const { default: ReviewInFlightBanner } = await import("./ReviewInFlightBanner.svelte");

const REPO = "/r";
const ID = "s1";

// Minimal session; the banner only reads id/repoPath/planPhase/auto/autopilotEnabled.
const sess = (over: Record<string, unknown> = {}) => ({
  id: ID,
  repoPath: REPO,
  planPhase: null,
  auto: false,
  autopilotEnabled: false,
  ...over,
});

// Props typed loosely — the banner's Session prop is a large type we don't need in full here.
const props = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: sess(),
  dStatus: "idle",
  activity: undefined,
  keystrokes: 0,
  tab: "term",
  ...over,
});

const changesRequested = (): ReviewVerdict => ({
  sessionId: ID,
  headSha: "abc",
  decision: "changes_requested",
  summary: "needs work",
  body: "B",
  findings: ["fix X"],
  addressRound: 1, // < cap → addressStallStatus === "round" (never "stalled"): clock-independent
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 0,
});

const approvedGate = (): PlanGate => ({
  sessionId: ID,
  planHash: "abc",
  decision: "approved",
  summary: "ok",
  body: "B",
  findings: [],
  round: 0,
  cap: 5,
  approved: true,
  plan: "PLAN",
  updatedAt: 0,
});

const feedLines = () => [...document.querySelectorAll(".rb-pv-line")].map((e) => e.textContent);
const banner = () => document.querySelector(".review-banner");

beforeEach(() => {
  reviews.map = {};
  reviews.reviewing = {};
  reviews.reviewerEnv = {};
  reviews.activity = {};
  planGates.map = {};
  planGates.reviewing = {};
  planGates.reviewerEnv = {};
  planGates.activity = {};
  repoConfig.autoAddress = {};
  repoConfig.autopilot = {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ReviewInFlightBanner preview — in-flight tier", () => {
  it("shows the Plan Gate reviewer's CLI, model, and effort below the headline", async () => {
    planGates.applyReviewing(ID, true, {
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    render(ReviewInFlightBanner, props() as never);

    await expect
      .poll(() => document.querySelector(".rb-env")?.textContent?.trim())
      .toBe("Codex · gpt-5.5 · High");
  });

  it("shows the critic reviewer's environment when auto-address makes the banner visible", async () => {
    repoConfig.autoAddress = { [REPO]: true };
    reviews.setReviewing(ID, true, {
      provider: "claude",
      model: "opus",
      effort: "high",
    });
    render(ReviewInFlightBanner, props() as never);

    await expect
      .poll(() => document.querySelector(".rb-env")?.textContent?.trim())
      .toBe("Claude Code · opus · High");
  });

  it("keeps the current banner unchanged when the reviewer provider is unavailable", async () => {
    planGates.applyReviewing(ID, true, { provider: null, model: "opus", effort: "high" });
    render(ReviewInFlightBanner, props() as never);

    await expect.poll(() => banner()).not.toBeNull();
    expect(document.querySelector(".rb-env")).toBeNull();
  });

  it("critic in-flight (auto-address on): renders the rolling activity feed, oldest→newest", async () => {
    repoConfig.autoAddress = { [REPO]: true };
    reviews.setReviewing(ID, true);
    reviews.setActivity(ID, "read review.ts");
    reviews.setActivity(ID, "$ git diff main...HEAD");
    render(ReviewInFlightBanner, props() as never);
    await expect.poll(feedLines).toEqual(["read review.ts", "$ git diff main...HEAD"]); // newest line sits at the bottom
  });

  it("plan-gate in-flight: renders the reviewer's activity feed", async () => {
    planGates.applyReviewing(ID, true);
    planGates.setActivity(ID, "read .shepherd-plan.md");
    render(ReviewInFlightBanner, props() as never);
    await expect.poll(feedLines).toEqual(["read .shepherd-plan.md"]);
  });

  it("caps the preview at 2 lines, dropping the oldest (newest at the bottom)", async () => {
    planGates.applyReviewing(ID, true);
    for (const l of ["act-1", "act-2", "act-3", "act-4", "act-5"]) planGates.setActivity(ID, l);
    render(ReviewInFlightBanner, props() as never);
    await expect.poll(feedLines).toEqual(["act-4", "act-5"]);
  });

  it("shows the waiting placeholder (no feed lines) before the first activity arrives", async () => {
    planGates.applyReviewing(ID, true);
    render(ReviewInFlightBanner, props() as never);
    await expect
      .poll(() => document.querySelector(".rb-pv-wait")?.textContent)
      .toBe(m.reviewbanner_preview_waiting());
    expect(feedLines()).toEqual([]);
  });

  it("keeps a stable banner height as the feed fills from 0 to 2 lines", async () => {
    planGates.applyReviewing(ID, true);
    render(ReviewInFlightBanner, props() as never);
    await expect
      .poll(() => document.querySelector(".rb-pv-wait")?.textContent)
      .toBe(m.reviewbanner_preview_waiting());
    const emptyH = banner()!.getBoundingClientRect().height;
    for (const l of ["act-1", "act-2"]) planGates.setActivity(ID, l);
    await expect.poll(() => feedLines().length).toBe(2);
    const fullH = banner()!.getBoundingClientRect().height;
    expect(fullH).toBe(emptyH); // reserved 2-row preview area → one xterm refit, not per-line churn
  });

  // The reflow guarantee: in a short pane the banner caps its own height so the terminal
  // (.term-mount = 100% - --review-banner-h, floored at 4rem) can always reflow ABOVE it —
  // i.e. banner ≤ containerHeight - 4rem, so .term-mount never drops under its floor and the
  // prompt is never overlaid. See ReviewInFlightBanner's .review-banner max-height.
  it("caps its height in a short pane so the terminal keeps its 4rem reflow floor", async () => {
    planGates.applyReviewing(ID, true, {
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    for (const l of ["act-1", "act-2"]) planGates.setActivity(ID, l);
    render(ReviewInFlightBanner, props() as never);
    await expect.poll(() => banner()).not.toBeNull();
    // The banner is position:absolute; make its mount div a positioned, definite short
    // containing block — otherwise the % cap resolves against the viewport and is never
    // exercised. (Read the host off the DOM: render()'s typed result varies by version.)
    const host = banner()!.parentElement as HTMLElement;
    host.style.position = "relative";
    host.style.height = "120px";
    await expect.poll(() => feedLines().length).toBe(2);
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const containerH = host.getBoundingClientRect().height;
    const bannerH = banner()!.getBoundingClientRect().height;
    expect(bannerH).toBeLessThanOrEqual(containerH - 4 * remPx + 0.5); // +0.5px rounding tolerance
    expect(bannerH).toBeGreaterThan(0); // clamped, not collapsed — headline still shows at 120px
    expect(document.querySelector(".rb-text")?.textContent?.trim()).toBeTruthy(); // headline present (ellipsized)
    expect(document.querySelector(".rb-env")?.textContent?.trim()).toBe("Codex · gpt-5.5 · High");
  });
});

describe("ReviewInFlightBanner preview — negative cases (no preview / no dim)", () => {
  it("critic in-flight with auto-address OFF: banner hidden entirely, so no preview", async () => {
    repoConfig.autoAddress = { [REPO]: false };
    reviews.setReviewing(ID, true);
    render(ReviewInFlightBanner, props() as never);
    // criticInFlightShows is false → the whole banner suppresses; nothing to dim behind.
    await expect.poll(() => banner()).toBeNull();
    expect(document.querySelector(".rb-preview")).toBeNull();
  });

  it("addressing phase (agent reworks in the PTY): banner shows, but no preview", async () => {
    reviews.map = { [ID]: changesRequested() }; // not reviewing; running; executing → addressing
    render(
      ReviewInFlightBanner,
      props({ session: sess({ planPhase: "executing" }), dStatus: "running" }) as never,
    );
    await expect.poll(() => banner()?.getAttribute("data-phase")).toBe("addressing");
    expect(document.querySelector(".rb-preview")).toBeNull();
  });

  it("conclusion phase (verdict just landed): banner shows, but no preview", async () => {
    planGates.applyReviewing(ID, true);
    render(ReviewInFlightBanner, props() as never);
    await expect
      .poll(() => document.querySelector(".rb-pv-wait")?.textContent)
      .toBe(m.reviewbanner_preview_waiting());
    // land an approved verdict and end the review → the brief conclusion tier
    planGates.map = { [ID]: approvedGate() };
    planGates.applyReviewing(ID, false);
    await expect.poll(() => banner()?.getAttribute("data-phase")).toBe("conclusion");
    expect(document.querySelector(".rb-preview")).toBeNull();
  });
});
