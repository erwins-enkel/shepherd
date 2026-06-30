import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { UsageTimeline, UsageTimelineHour } from "$lib/types";

const { default: TimelineLens } = await import("./TimelineLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

/** Build a timeline from local-time hour specs; peak/total derived from the data. */
function makeTimeline(hours: UsageTimelineHour[]): UsageTimeline {
  let total = 0;
  let peak = 0;
  for (const h of hours) {
    total += h.units;
    if (h.units > peak) peak = h.units;
  }
  return { range: "7d", generatedAt: Date.now(), hours, totalUnits: total, peakHourUnits: peak };
}

/** Local-time hour epoch (y, monthIndex, day, hour). */
function hr(y: number, mon: number, day: number, hour: number, units: number): UsageTimelineHour {
  return { hourStart: new Date(y, mon, day, hour, 0, 0, 0).getTime(), units };
}

describe("TimelineLens", () => {
  it("renders one row per local day with 24 cells each, newest first", async () => {
    const tl = makeTimeline([
      hr(2025, 5, 10, 14, 100), // peak
      hr(2025, 5, 10, 3, 10), // low, same day
      hr(2025, 5, 9, 9, 50), // previous day
    ]);
    render(TimelineLens, { timeline: tl });

    const rows = document.querySelectorAll(".tl-row");
    expect(rows.length, "two distinct local days").toBe(2);
    for (const row of rows) {
      expect(row.querySelectorAll(".tl-cell").length, "24 hour cells per row").toBe(24);
    }
  });

  it("scales cell intensity by units / peak (floored for nonzero, inset for zero)", async () => {
    const tl = makeTimeline([hr(2025, 5, 10, 14, 100), hr(2025, 5, 10, 3, 10)]);
    render(TimelineLens, { timeline: tl });

    const cells = document.querySelectorAll<HTMLElement>(".tl-row .tl-cell");
    const iOf = (el: HTMLElement) => Number(el.style.getPropertyValue("--i"));

    // Hour 14 (peak) → 100; hour 3 (10/100) → floored 8 + 9.2 = 17.2; an empty hour → 0.
    expect(iOf(cells[14]!)).toBeCloseTo(100, 5);
    expect(iOf(cells[3]!)).toBeCloseTo(17.2, 5);
    expect(iOf(cells[0]!), "empty hour reads as inset (0)").toBe(0);
  });

  it("shows peak and total stats", async () => {
    const tl = makeTimeline([hr(2025, 5, 10, 14, 100), hr(2025, 5, 9, 9, 50)]);
    render(TimelineLens, { timeline: tl });

    const stats = document.querySelector(".tl-stats")?.textContent ?? "";
    expect(stats).toContain("100"); // peak
    expect(stats).toContain("150"); // total
  });

  it("renders the empty state when there are no hours", async () => {
    render(TimelineLens, { timeline: makeTimeline([]) });
    await expect.element(page.getByText(/no usage recorded/i)).toBeInTheDocument();
    expect(document.querySelectorAll(".tl-row").length).toBe(0);
  });

  it("caps the grid at 35 rows and shows the '+N earlier days' note", async () => {
    // 40 consecutive days, one hour each → 35 rows shown, 5 hidden.
    const hours: UsageTimelineHour[] = [];
    for (let d = 1; d <= 40; d++) hours.push(hr(2025, 0, d, 12, 10));
    render(TimelineLens, { timeline: makeTimeline(hours) });

    expect(document.querySelectorAll(".tl-row").length, "capped at 35 rows").toBe(35);
    const more = document.querySelector(".tl-more");
    expect(more, "more-days note present").not.toBeNull();
    expect(more?.textContent ?? "").toContain("5");
  });
});
