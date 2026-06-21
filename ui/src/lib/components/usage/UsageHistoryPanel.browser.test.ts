import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { UsageHistoryResponse } from "$lib/types";

const BASE = Date.now();
const H = 3_600_000;

const { default: UsageHistoryPanel } = await import("./UsageHistoryPanel.svelte");

function fullHistory(): UsageHistoryResponse {
  const reset5h = BASE + 2.5 * H;
  const resetWk = BASE + 58 * H;
  return {
    caps: {
      session5h: [
        { window: "session5h", cap: 100, resetAt: reset5h, pct: 12, scrapedAt: BASE - 1 * H },
        { window: "session5h", cap: 100, resetAt: reset5h, pct: 30, scrapedAt: BASE - 0.5 * H },
      ],
      week: [
        // two distinct reset cycles → must segment, not connect across the reset
        { window: "week", cap: 100, resetAt: BASE - 50 * H, pct: 60, scrapedAt: BASE - 80 * H },
        { window: "week", cap: 100, resetAt: resetWk, pct: 8, scrapedAt: BASE - 40 * H },
        { window: "week", cap: 100, resetAt: resetWk, pct: 18, scrapedAt: BASE - 10 * H },
      ],
    },
    credit: [
      {
        spent: 0.1,
        cap: 50,
        currency: "€",
        pct: 0,
        resetAt: BASE + 200 * H,
        scrapedAt: BASE - 20 * H,
      },
      {
        spent: 0.3,
        cap: 50,
        currency: "€",
        pct: 1,
        resetAt: BASE + 200 * H,
        scrapedAt: BASE - 2 * H,
      },
    ],
    since: BASE - 90 * 24 * H,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("UsageHistoryPanel", () => {
  it("renders all three series from a fixture", async () => {
    render(UsageHistoryPanel, { history: fullHistory() });

    const sections = document.querySelectorAll(".series");
    expect(sections.length, "one section per non-empty series (5H, WK, credit)").toBe(3);

    // WK has two reset cycles → two segmented sparklines in its .cycles row
    const cycleRows = document.querySelectorAll(".cycles");
    expect(cycleRows.length).toBe(3);
    // Total sparkline SVGs: 5H(1) + WK(2) + credit(1) = 4
    expect(document.querySelectorAll(".cycles svg").length).toBe(4);
  });

  it("skips empty series and shows empty state when all are empty", async () => {
    const empty: UsageHistoryResponse = {
      caps: { session5h: [], week: [] },
      credit: [],
      since: BASE - 90 * 24 * H,
    };
    render(UsageHistoryPanel, { history: empty });

    expect(document.querySelectorAll(".series").length).toBe(0);
    await expect.element(page.getByText(/no recorded history/i)).toBeInTheDocument();
  });

  it("renders only the non-empty series", async () => {
    const partial: UsageHistoryResponse = {
      caps: {
        session5h: [
          { window: "session5h", cap: 100, resetAt: BASE + H, pct: 25, scrapedAt: BASE - 0.5 * H },
        ],
        week: [],
      },
      credit: [],
      since: BASE - 90 * 24 * H,
    };
    render(UsageHistoryPanel, { history: partial });

    expect(document.querySelectorAll(".series").length, "only 5H series renders").toBe(1);
  });
});
