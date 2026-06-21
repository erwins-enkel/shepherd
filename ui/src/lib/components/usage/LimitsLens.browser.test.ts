import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { mockLimits, mockProjections } from "$lib/usage-mock";

const { default: LimitsLens } = await import("./LimitsLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("LimitsLens", () => {
  it("renders a meter block for each window", async () => {
    const limits = mockLimits();
    const projections = mockProjections();
    render(LimitsLens, { limits, projections });

    // Two window blocks — one per gauge (5H and WK)
    const meterTracks = document.querySelectorAll(".meter-track");
    expect(meterTracks.length, "one meter per window").toBe(2);
  });

  it("shows the current pct for each window", async () => {
    const limits = mockLimits(); // session5h.pct=38, week.pct=22
    const projections = mockProjections();
    render(LimitsLens, { limits, projections });

    await expect.element(page.getByText("38%")).toBeInTheDocument();
    await expect.element(page.getByText("22%")).toBeInTheDocument();
  });

  it("renders reset-time captions for each window", async () => {
    const limits = mockLimits();
    const projections = mockProjections();
    render(LimitsLens, { limits, projections });

    // Both windows should show "resets in …"
    const resets = document.querySelectorAll(".reset-time");
    expect(resets.length, "reset caption per window").toBe(2);
    // Each caption should contain "resets in"
    for (const el of resets) {
      expect(el.textContent).toMatch(/resets in/i);
    }
  });

  it("renders projection info for matched windows", async () => {
    const limits = mockLimits();
    const projections = mockProjections(); // 5H: projectedPct=64, burnRate=48_000; WK: projectedPct=41, burnRate=31_000
    render(LimitsLens, { limits, projections });

    // Projection info rows should be present for both windows
    const projInfos = document.querySelectorAll(".proj-info");
    expect(projInfos.length, "projection info per window").toBe(2);

    // 5H: projected 64% at reset
    await expect.element(page.getByText(/projected 64%/i)).toBeInTheDocument();
    // WK: projected 41% at reset
    await expect.element(page.getByText(/projected 41%/i)).toBeInTheDocument();
  });

  it("renders burn rate captions", async () => {
    const limits = mockLimits();
    const projections = mockProjections();
    render(LimitsLens, { limits, projections });

    // Both windows have projections → two burn rate captions
    const burnRates = document.querySelectorAll(".burn-rate");
    expect(burnRates.length, "burn rate caption per matched window").toBe(2);

    // 5H burn rate: 48_000 → "48K/h"
    await expect.element(page.getByText(/48K\/h/)).toBeInTheDocument();
    // WK burn rate: 31_000 → "31K/h"
    await expect.element(page.getByText(/31K\/h/)).toBeInTheDocument();
  });

  it("shows projection tick on the meter", async () => {
    const limits = mockLimits();
    const projections = mockProjections();
    render(LimitsLens, { limits, projections });

    const ticks = document.querySelectorAll(".proj-tick");
    expect(ticks.length, "one tick per matched projection").toBe(2);
  });

  it("renders 'no data' message when limits are empty", async () => {
    const emptyLimits = {
      session5h: null,
      week: null,
      credits: null,
      stale: false,
      calibratedAt: null,
      subscriptionOnly: false,
    };
    render(LimitsLens, { limits: emptyLimits, projections: [] });

    await expect.element(page.getByText(/no usage-window data/i)).toBeInTheDocument();
  });
});
