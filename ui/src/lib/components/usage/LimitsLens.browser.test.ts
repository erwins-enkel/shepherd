import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type {
  UsageLimits,
  UsageProjection,
  UsageHistoryResponse,
  UsageProviderSnapshot,
} from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { formatTokenLabel } from "$lib/format";

const BASE = Date.now();
const H = 3_600_000;

function limitsFixture(): UsageLimits {
  return {
    session5h: { pct: 38, resetAt: BASE + 2.5 * H },
    week: { pct: 22, resetAt: BASE + 58 * H },
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: BASE - 5 * 60_000,
    subscriptionOnly: false,
  };
}

function projectionsFixture(): UsageProjection[] {
  return [
    { window: "5H", projectedPct: 64, resetAt: BASE + 2.5 * H, burnRatePerHour: 48_000 },
    { window: "WK", projectedPct: 41, resetAt: BASE + 58 * H, burnRatePerHour: 31_000 },
  ];
}

function emptyLimitsFixture(): UsageLimits {
  return {
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
  };
}

function codexUsageFixture(
  overrides: Partial<Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }>> = {},
): Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> {
  return {
    provider: "codex",
    kind: "tokens",
    totalTokens: 884_800_000,
    session5hTokens: 229_700_000,
    weekTokens: 689_900_000,
    updatedAt: BASE - 60_000,
    stale: false,
    session5h: { pct: 42, resetAt: BASE + H },
    week: { pct: 7, resetAt: BASE + 6 * 24 * H },
    ...overrides,
  };
}

function historyFixture(): UsageHistoryResponse {
  const reset5h = BASE + 2.5 * H;
  const resetWk = BASE + 58 * H;
  return {
    caps: {
      session5h: [
        { window: "session5h", cap: 100, resetAt: reset5h, pct: 12, scrapedAt: BASE - 1 * H },
        { window: "session5h", cap: 100, resetAt: reset5h, pct: 30, scrapedAt: BASE - 0.5 * H },
      ],
      week: [
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

const { default: LimitsLens } = await import("./LimitsLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("LimitsLens", () => {
  it("renders a meter block for each window", async () => {
    const limits = limitsFixture();
    const projections = projectionsFixture();
    render(LimitsLens, { limits, projections });

    // Two window blocks — one per gauge (5H and WK)
    const meterTracks = document.querySelectorAll(".provider-claude .meter-track");
    expect(meterTracks.length, "one meter per window").toBe(2);
  });

  it("shows the current pct for each window", async () => {
    const limits = limitsFixture(); // session5h.pct=38, week.pct=22
    const projections = projectionsFixture();
    render(LimitsLens, { limits, projections });

    await expect.element(page.getByText("38%")).toBeInTheDocument();
    await expect.element(page.getByText("22%")).toBeInTheDocument();
  });

  it("renders reset-time captions for each window", async () => {
    const limits = limitsFixture();
    const projections = projectionsFixture();
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
    const limits = limitsFixture();
    const projections = projectionsFixture(); // 5H: projectedPct=64, burnRate=48_000; WK: projectedPct=41, burnRate=31_000 (see projectionsFixture)
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
    const limits = limitsFixture();
    const projections = projectionsFixture();
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
    const limits = limitsFixture();
    const projections = projectionsFixture();
    render(LimitsLens, { limits, projections });

    const ticks = document.querySelectorAll(".proj-tick");
    expect(ticks.length, "one tick per matched projection").toBe(2);
  });

  it("renders inline sparklines and a working history toggle when history is present", async () => {
    const limits = limitsFixture();
    const projections = projectionsFixture();
    const history = historyFixture();
    render(LimitsLens, { limits, projections, history });

    // One inline sparkline per gauge (5H + WK)
    expect(document.querySelectorAll(".spark-row svg").length, "inline spark per window").toBe(2);

    // Toggle present, collapsed by default
    const toggle = document.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle, "history toggle present").not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".history-panel"), "panel hidden initially").toBeNull();

    // Expands the panel
    toggle!.click();
    await expect.poll(() => document.querySelector(".history-panel")).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  });

  it("still renders gauges + projection and hides the toggle when history is null", async () => {
    const limits = limitsFixture();
    const projections = projectionsFixture();
    render(LimitsLens, { limits, projections, history: null });

    expect(document.querySelectorAll(".provider-claude .meter-track").length).toBe(2);
    expect(document.querySelectorAll(".provider-claude .proj-tick").length).toBe(2);
    // No recorded history ⇒ no toggle
    expect(document.querySelector("button[aria-expanded]"), "no toggle without history").toBeNull();
    // Inline sparkline still renders (single live "now" point)
    expect(document.querySelectorAll(".spark-row svg").length).toBe(2);
  });

  it("renders a per-model passthrough bar (Fable) separate from the 5H/WK meters", async () => {
    const limits = limitsFixture();
    limits.perModelWeek = [
      { model: "fable", pct: 7, resetAt: null, scrapedAt: BASE, stale: false },
    ];
    render(LimitsLens, { limits, projections: projectionsFixture() });

    // Its own block, NOT a 5H/WK meter-track (those stay at 2)
    expect(
      document.querySelectorAll(".provider-claude .meter-track").length,
      "5H/WK meters unchanged",
    ).toBe(2);
    const mwBar = document.querySelector(".model-week-block .mw-bar");
    expect(mwBar, "Fable passthrough bar present").not.toBeNull();
    await expect.element(page.getByText("Weekly window (Fable)")).toBeInTheDocument();
    await expect.element(page.getByText("7%")).toBeInTheDocument();
  });

  it("renders 'no data' message when limits are empty", async () => {
    const emptyLimits = emptyLimitsFixture();
    render(LimitsLens, { limits: emptyLimits, projections: [] });

    await expect.element(page.getByText(/no usage-window data/i)).toBeInTheDocument();
  });

  it("renders provider-scoped Claude and Codex sections without mixing stale state", async () => {
    const limits = limitsFixture();
    const codexUsage = codexUsageFixture({ stale: true });
    render(LimitsLens, { limits, projections: projectionsFixture(), codexUsage });

    await expect
      .element(page.getByText(m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.topbar_usage_provider_title({ provider: m.agent_provider_codex() })))
      .toBeInTheDocument();

    const claude = document.querySelector<HTMLElement>(".provider-claude");
    const codex = document.querySelector<HTMLElement>(".provider-codex");
    expect(claude, "Claude section present").not.toBeNull();
    expect(codex, "Codex section present").not.toBeNull();
    expect(claude!.classList.contains("stale"), "Claude does not inherit Codex stale").toBe(false);
    expect(codex!.classList.contains("stale"), "Codex uses its own stale flag").toBe(true);
    expect(claude!.querySelectorAll(".meter-track").length, "Claude meters").toBe(2);
    expect(codex!.querySelectorAll(".sheet-gauge-row").length, "Codex top-menu gauge rows").toBe(2);
  });

  it("renders codex-only limit gauges without the generic no-data message", async () => {
    const limits = emptyLimitsFixture();
    const codexUsage = codexUsageFixture();
    render(LimitsLens, { limits, projections: [], codexUsage });

    expect(document.querySelector(".provider-claude"), "no empty Claude section").toBeNull();
    const codex = document.querySelector<HTMLElement>(".provider-codex");
    expect(codex, "Codex section present").not.toBeNull();
    expect(codex!.querySelectorAll(".sheet-gauge-row").length, "Codex gauges").toBe(2);
    expect(document.querySelector(".no-data"), "no generic no-data with Codex usage").toBeNull();
    await expect.element(page.getByText("42%")).toBeInTheDocument();
    await expect.element(page.getByText("7%")).toBeInTheDocument();
  });

  it("renders codex token-only fallback without fake gauges", async () => {
    const limits = emptyLimitsFixture();
    const codexUsage = codexUsageFixture({ session5h: null, week: null });
    render(LimitsLens, { limits, projections: [], codexUsage });

    const codex = document.querySelector<HTMLElement>(".provider-codex");
    expect(codex, "Codex section present").not.toBeNull();
    expect(codex!.querySelectorAll(".sheet-gauge-row").length, "no fake Codex gauges").toBe(0);
    await expect.element(page.getByText(m.topbar_codex_limits_unavailable())).toBeInTheDocument();
    await expect.element(page.getByText(formatTokenLabel(884_800_000))).toBeInTheDocument();
    expect(document.querySelector(".no-data"), "no generic no-data with token fallback").toBeNull();
  });
});
