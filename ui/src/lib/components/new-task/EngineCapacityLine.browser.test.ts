import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import type { UsageLimits } from "$lib/types";
import EngineCapacityLine from "./EngineCapacityLine.svelte";

// Direct component seam for the compact capacity line. Window-selection RULES
// (hottest window, stale flag, null on unavailable) are pinned at the unit seam
// (usage-gauges.test.ts); this suite owns the DOM: dimming, popover, fallbacks.

const FUTURE_RESET = new Date(2100, 6, 18, 20, 0).getTime();

function limits(resetAt = FUTURE_RESET, codex = true): UsageLimits {
  return {
    session5h: { pct: 30, resetAt },
    week: { pct: 60, resetAt },
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    providers: [
      {
        provider: "claude",
        kind: "limits",
        session5h: { pct: 30, resetAt },
        week: { pct: 60, resetAt },
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
      },
      {
        provider: "codex",
        kind: "tokens",
        totalTokens: 12_000,
        session5hTokens: 1_000,
        weekTokens: 9_000,
        updatedAt: 123,
        stale: false,
        session5h: codex ? { pct: 20, resetAt } : null,
        week: codex ? { pct: 80, resetAt } : null,
      },
    ],
  } as UsageLimits;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EngineCapacityLine compact line", () => {
  it("renders the selected provider's hottest window with code, gauge, and free%", async () => {
    render(EngineCapacityLine, { limits: limits(), provider: "claude" });
    // Claude WK is hotter (60% used → 40% free) than 5H (30% → 70%).
    await expect.poll(() => document.querySelector(".cap-code")?.textContent).toBe("CC·WK");
    expect(document.querySelector(".cap-free")?.textContent).toContain(
      m.newtask_provider_capacity_free({ pct: 40 }),
    );
    const fill = document.querySelector<HTMLElement>(".cap-fill")!;
    expect(fill.style.width).toBe("40%");
  });

  it("hides the line entirely when the provider has no usable windows", async () => {
    render(EngineCapacityLine, { limits: limits(FUTURE_RESET, false), provider: "codex" });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".capline")).toBeNull();
  });

  it("dims a stale provider instead of hiding it (opacity via the stale class)", async () => {
    const stale = limits();
    stale.stale = true;
    stale.providers![0]!.stale = true;
    render(EngineCapacityLine, { limits: stale, provider: "claude" });
    await expect.poll(() => document.querySelector(".capline.stale")).not.toBeNull();
    expect(getComputedStyle(document.querySelector(".capline")!).opacity).toBe("0.55");
  });
});

describe("EngineCapacityLine all-engines popover", () => {
  it("opens on 'all ▾' listing every provider window with gauge + reset time", async () => {
    render(EngineCapacityLine, { limits: limits(), provider: "codex" });
    await expect.poll(() => document.querySelector(".cap-all")).not.toBeNull();

    const all = document.querySelector<HTMLButtonElement>(".cap-all")!;
    expect(all.getAttribute("aria-expanded")).toBe("false");
    all.click();
    await expect.poll(() => document.querySelector(".cap-pop")).not.toBeNull();
    expect(all.getAttribute("aria-expanded")).toBe("true");

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".cap-pop-row"));
    expect(rows.map((r) => r.querySelector(".cap-code")?.textContent)).toEqual([
      "CC·5H",
      "CC·WK",
      "CX·5H",
      "CX·WK",
    ]);
    // Reset times ride along (the free-until copy).
    expect(rows[0]!.textContent).toContain(
      m.newtask_provider_capacity_free_until({ pct: 70, time: "18.7. 20:00" }),
    );
  });

  it("falls back to plain free text when resetAt is unusable, and Escape closes", async () => {
    render(EngineCapacityLine, { limits: limits(0), provider: "claude" });
    await expect.poll(() => document.querySelector(".cap-all")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".cap-all")!.click();
    await expect.poll(() => document.querySelector(".cap-pop")).not.toBeNull();

    const first = document.querySelector<HTMLElement>(".cap-pop-row")!;
    expect(first.textContent).toContain(m.newtask_provider_capacity_free({ pct: 70 }));
    expect(first.textContent).not.toContain("til");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.poll(() => document.querySelector(".cap-pop")).toBeNull();
  });

  it("shows an unavailable provider's row as unavailable, not 100% free", async () => {
    render(EngineCapacityLine, { limits: limits(FUTURE_RESET, false), provider: "claude" });
    await expect.poll(() => document.querySelector(".cap-all")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".cap-all")!.click();
    await expect.poll(() => document.querySelector(".cap-pop")).not.toBeNull();

    const pop = document.querySelector<HTMLElement>(".cap-pop")!;
    expect(pop.textContent).toContain(m.newtask_provider_capacity_unavailable());
    expect(pop.textContent).not.toContain("100%");
  });
});
