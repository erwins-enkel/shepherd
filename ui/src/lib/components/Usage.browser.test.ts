import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { UsageLimits, UsageProjection, UsageRange, UsageTimeline } from "$lib/types";
import { formatTokenLabel } from "$lib/format";
import { m } from "$lib/paraglide/messages";
import * as api from "$lib/api";

const BASE = Date.now();
const H = 3_600_000;

const inlineLimits: UsageLimits = {
  session5h: { pct: 38, resetAt: BASE + 2.5 * H },
  week: { pct: 22, resetAt: BASE + 58 * H },
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: BASE - 5 * 60_000,
  subscriptionOnly: false,
  providers: [
    {
      provider: "claude",
      kind: "limits",
      session5h: { pct: 38, resetAt: BASE + 2.5 * H },
      week: { pct: 22, resetAt: BASE + 58 * H },
      perModelWeek: [],
      credits: null,
      stale: false,
      calibratedAt: BASE - 5 * 60_000,
      subscriptionOnly: false,
    },
    {
      provider: "codex",
      kind: "tokens",
      totalTokens: 123_456_789,
      session5hTokens: 23_456_789,
      weekTokens: 87_654_321,
      updatedAt: BASE - 60_000,
      stale: false,
      session5h: { pct: 42, resetAt: BASE + H },
      week: { pct: 7, resetAt: BASE + 6 * 24 * H },
    },
  ],
};

const inlineProjections: UsageProjection[] = [
  { window: "5H", projectedPct: 64, resetAt: BASE + 2.5 * H, burnRatePerHour: 48_000 },
  { window: "WK", projectedPct: 41, resetAt: BASE + 58 * H, burnRatePerHour: 31_000 },
];

// Pin the timeline buckets to a fixed mid-day point of "today" so both hours always fall on the
// SAME local calendar day → one 24-cell heatmap row, at every wall-clock time. A Date.now()-relative
// fixture flakes during the 01:00 local hour (one bucket lands on the previous day → 2 rows /
// 48 cells), which kept the doc-PR `verify` CI red whenever it ran in that nightly window.
const TODAY_NOON = (() => {
  const d = new Date(BASE);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})();

const inlineTimeline: UsageTimeline = {
  range: "7d",
  generatedAt: BASE,
  hours: [
    { hourStart: TODAY_NOON - 2 * H, units: 12 },
    { hourStart: TODAY_NOON - H, units: 40 },
  ],
  totalUnits: 52,
  peakHourUnits: 40,
};

// Mock the API so tests are deterministic and backend-independent.
vi.mock("$lib/api", async () => {
  const { mockBreakdown } = await import("$lib/usage-mock");
  return {
    getUsageBreakdown: vi.fn((range: UsageRange) => Promise.resolve(mockBreakdown(range))),
    getUsageTimeline: vi.fn((range: UsageRange) => Promise.resolve({ ...inlineTimeline, range })),
    getUsageLimits: vi.fn(() =>
      Promise.resolve({ limits: inlineLimits, projections: inlineProjections }),
    ),
    getGithubRateLimit: vi.fn(() =>
      Promise.resolve({
        rest: { limit: 5000, used: 173, remaining: 4827, resetAt: BASE + H },
        graphql: { limit: 5000, used: 5002, remaining: 0, resetAt: BASE + H },
        search: { limit: 30, used: 0, remaining: 30, resetAt: BASE + H },
        fetchedAt: BASE,
        backoff: { remaining: 0, resetAt: BASE + H, pausedUntil: BASE + H, blocked: true },
      }),
    ),
  };
});

const { default: Usage } = await import("./Usage.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Usage modal component", () => {
  it("defaults to the Spend tab and renders Spend lens content", async () => {
    render(Usage, { onclose: vi.fn() });

    // Spend tab button is active
    const spendBtn = document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    expect(spendBtn, "one active tab button").not.toBeNull();
    expect(spendBtn?.textContent?.trim()).toContain("Spend");

    // SpendLens renders repo rows from the default 7d fixture
    await expect.element(page.getByText("shepherd")).toBeInTheDocument();
  });

  it("clicking the Overhead tab swaps to Overhead lens content", async () => {
    render(Usage, { onclose: vi.fn() });

    const overheadBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Overhead",
    );
    expect(overheadBtn, "Overhead tab button exists").not.toBeNull();

    overheadBtn!.click();

    // Overhead lens renders the reviewer-tax section
    await expect.element(page.getByText("Reviewer tax")).toBeInTheDocument();
  });

  it("clicking the Limits tab swaps to Limits lens and hides range selector", async () => {
    render(Usage, { onclose: vi.fn() });

    const limitsBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Limits",
    );
    expect(limitsBtn, "Limits tab button exists").not.toBeNull();

    limitsBtn!.click();

    // Wait for the Limits lens to appear. Claude meters stay in their provider section, and
    // Codex uses the reused top-menu LimitGaugeRow primitive rather than the lens meter markup.
    await expect
      .poll(() => document.querySelectorAll(".provider-claude .meter-track").length)
      .toBe(2);
    await expect
      .poll(() => document.querySelectorAll(".provider-codex .sheet-gauge-row").length)
      .toBe(2);
    expect(
      document.querySelector(".provider-strip"),
      "Codex strip suppressed on Limits tab",
    ).toBeNull();

    // Range selector must not be present on the Limits tab
    const rangeGroup = document.querySelector('[role="group"][aria-label]');
    expect(rangeGroup, "range selector hidden on Limits tab").toBeNull();
  });

  it("clicking the Timeline tab renders the heatmap and keeps the range selector", async () => {
    render(Usage, { onclose: vi.fn() });

    const timelineBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === m.usage_timeline_tab(),
    );
    expect(timelineBtn, "Timeline tab button exists").not.toBeNull();

    timelineBtn!.click();

    // The lazily-loaded heatmap appears: at least one day row with 24 hour cells.
    await expect.poll(() => document.querySelectorAll(".tl-row").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".tl-row .tl-cell").length).toBe(24);

    // Timeline is a ranged tab — the range selector stays visible.
    const rangeGroup = document.querySelector('[role="group"][aria-label]');
    expect(rangeGroup, "range selector present on Timeline tab").not.toBeNull();
  });

  it("clicking the Models tab renders separate ranged provider blocks", async () => {
    render(Usage, { onclose: vi.fn() });

    const modelsBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === m.usage_models_tab(),
    );
    expect(modelsBtn, "Models tab button exists").not.toBeNull();
    modelsBtn!.click();

    await expect.poll(() => document.querySelectorAll(".provider-block").length).toBe(2);
    expect(document.querySelector('[data-provider="claude"]')).not.toBeNull();
    expect(document.querySelector('[data-provider="codex"]')).not.toBeNull();
    expect(document.querySelector('[role="group"][aria-label]')).not.toBeNull();
    expect(document.querySelector(".provider-strip"), "non-ranged Codex strip hidden").toBeNull();
  });

  it("clicking the GitHub tab shows REST + GraphQL buckets and the GraphQL-paused banner", async () => {
    render(Usage, { onclose: vi.fn() });

    const githubBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "GitHub",
    );
    expect(githubBtn, "GitHub tab button exists").not.toBeNull();

    githubBtn!.click();

    // Both bucket labels render; the exhausted GraphQL bucket surfaces a paused banner.
    await expect.element(page.getByText(m.github_lens_rest_label())).toBeInTheDocument();
    await expect.element(page.getByText(m.github_lens_graphql_label())).toBeInTheDocument();
    await expect.element(page.getByRole("alert")).toBeInTheDocument();

    // Range selector must not be present on the GitHub tab.
    const rangeGroup = document.querySelector('[role="group"][aria-label]');
    expect(rangeGroup, "range selector hidden on GitHub tab").toBeNull();
  });

  it("range selector is present on the Spend tab", async () => {
    render(Usage, { onclose: vi.fn() });

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

  it("shows Codex token usage in the modal chrome", async () => {
    render(Usage, { onclose: vi.fn() });

    await expect.element(page.getByText(m.agent_provider_codex())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.topbar_tokens_window({ period: "5H" })))
      .toBeInTheDocument();
    await expect.element(page.getByText(formatTokenLabel(123_456_789))).toBeInTheDocument();
  });

  it("clicking the ✕ close button calls onclose", async () => {
    const onclose = vi.fn();
    render(Usage, { onclose });

    const closeBtn = document.querySelector<HTMLButtonElement>("button[aria-label]");
    expect(closeBtn, "close button exists").not.toBeNull();

    closeBtn!.click();

    expect(onclose).toHaveBeenCalledOnce();
  });

  it("shows loading state initially", async () => {
    // Override both fetches with never-resolving promises so loading stays visible.
    vi.mocked(api.getUsageBreakdown).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(api.getUsageLimits).mockImplementationOnce(() => new Promise(() => {}));

    render(Usage, { onclose: vi.fn() });

    // Loading text must be present before any data resolves.
    await expect.element(page.getByText("loading…")).toBeInTheDocument();
  });

  it("renders the modal overlay wrapper", async () => {
    render(Usage, { onclose: vi.fn() });

    const overlay = document.querySelector('[role="presentation"]');
    expect(overlay, "overlay wrapper exists").not.toBeNull();

    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog, "dialog element exists").not.toBeNull();
  });
});
