import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { UsageLimits, UsageProjection, UsageRange } from "$lib/types";

const BASE = Date.now();
const H = 3_600_000;

const inlineLimits: UsageLimits = {
  session5h: { pct: 38, resetAt: BASE + 2.5 * H },
  week: { pct: 22, resetAt: BASE + 58 * H },
  credits: null,
  stale: false,
  calibratedAt: BASE - 5 * 60_000,
  subscriptionOnly: false,
};

const inlineProjections: UsageProjection[] = [
  { window: "5H", projectedPct: 64, resetAt: BASE + 2.5 * H, burnRatePerHour: 48_000 },
  { window: "WK", projectedPct: 41, resetAt: BASE + 58 * H, burnRatePerHour: 31_000 },
];

// The page fetches live data from $lib/api; mock those two calls with the retained
// fixtures so this suite is deterministic and backend-independent (CI has no server,
// and a real backend would otherwise serve environment-specific data).
vi.mock("$lib/api", async () => {
  const { mockBreakdown } = await import("$lib/usage-mock");
  return {
    getUsageBreakdown: (range: UsageRange) => Promise.resolve(mockBreakdown(range)),
    getUsageLimits: () => Promise.resolve({ limits: inlineLimits, projections: inlineProjections }),
    getUsageHistory: () =>
      Promise.resolve({ caps: { session5h: [], week: [] }, credit: [], since: BASE }),
  };
});

const { default: UsagePage } = await import("./+page.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("UsagePage (/usage)", () => {
  it("defaults to the Spend tab and renders Spend lens content", async () => {
    render(UsagePage);

    // Spend tab button is active
    const spendBtn = document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(spendBtn, "one active tab button").not.toBeNull();
    expect(spendBtn?.textContent?.trim()).toContain("Spend");

    // SpendLens renders repo rows from the default 7d fixture
    await expect.element(page.getByText("shepherd")).toBeInTheDocument();
  });

  it("clicking the Overhead tab swaps to Overhead lens content", async () => {
    render(UsagePage);

    const overheadBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Overhead",
    );
    expect(overheadBtn, "Overhead tab button exists").not.toBeNull();

    overheadBtn!.click();

    // Overhead lens renders the reviewer-tax section
    await expect.element(page.getByText("Reviewer tax")).toBeInTheDocument();
  });

  it("clicking the Limits tab swaps to Limits lens and hides range selector", async () => {
    render(UsagePage);

    const limitsBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Limits",
    );
    expect(limitsBtn, "Limits tab button exists").not.toBeNull();

    limitsBtn!.click();

    // Wait for the Limits lens to appear (it has meter-track elements)
    await expect.poll(() => document.querySelectorAll(".meter-track").length).toBe(2);

    // Range selector must not be present on the Limits tab
    const rangeGroup = document.querySelector('[role="group"][aria-label]');
    expect(rangeGroup, "range selector hidden on Limits tab").toBeNull();
  });

  it("range selector is present on the Spend tab", async () => {
    render(UsagePage);

    // Default tab is Spend — range group should be rendered
    const rangeGroup = document.querySelector('[role="group"][aria-label]');
    expect(rangeGroup, "range selector present on Spend tab").not.toBeNull();

    // 7d should be the default active range
    const activeBtns = Array.from(
      rangeGroup!.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]'),
    );
    expect(activeBtns.length, "one active range button").toBe(1);
    expect(activeBtns[0].textContent?.trim()).toBe("7d");
  });
});
