import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CompletedEpic } from "#lib/types.js";
import IntegratedEpicLanding from "./IntegratedEpicLanding.svelte";
const epic = (over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/repo",
  parentIssueNumber: 327,
  parentTitle: "Big epic",
  completedAt: 1000,
  children: [
    {
      number: 11,
      title: "Child",
      url: "https://github.com/o/r/issues/11",
      prNumber: 101,
      prUrl: "https://github.com/o/r/pull/101",
      mergedAt: 1000,
      integrated: true,
    },
  ],
  integrationBranch: "epic/327-original-title",
  landingPrNumber: 55,
  landingPrUrl: "https://github.com/o/r/pull/55",
  landingState: "open",
  landingChecks: "pending",
  landingMergeable: true,
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  ...over,
});
const props = (e: CompletedEpic) => ({
  epic: e,
  onland: vi.fn(),
  ondismiss: vi.fn(),
  onackmigrations: vi.fn(),
  onresolveconflicts: vi.fn(),
});
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  );
afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntegratedEpicLanding next step", () => {
  it.each([
    [{ landingState: "pending" }, "Shepherd is preparing the landing PR", null],
    [{}, "CI is checking landing PR #55", "waiting for checks"],
    [
      { landingRepairing: true, landingMergeable: false },
      "An agent is resolving the conflicts",
      "repair in progress",
    ],
    [
      { landingRepairing: true, landingChecks: "failure" },
      "An agent is repairing the landing PR",
      "repair in progress",
    ],
    [{ landingChecks: "failure" }, "CI is failing on landing PR #55", "green CI required"],
    [{ landingMergeable: false }, "Landing PR #55 conflicts with main", "resolve conflicts first"],
    [{ landingState: "none" }, "Nothing to land", null],
    [{ landingReady: true, landingChecks: "success" }, "All green — you can land the epic", null],
    [{ landingState: "merged" }, "Landed in main", null],
    [{ landingState: "error" }, "Couldn't open the landing PR — retrying", null],
    [
      { landingChecks: "success", landingReady: false },
      "Landing PR is not merge-ready yet",
      "Landing PR is not ready to merge yet",
    ],
  ] as const)("explains %j with a visible blocking reason", async (over, heading, reason) => {
    await render(IntegratedEpicLanding, props(epic(over)));
    await expect
      .element(page.getByRole("heading", { name: heading, exact: true }))
      .toBeInTheDocument();
    expect(document.querySelectorAll(".landing-path li")).toHaveLength(4);
    if (reason) {
      await expect.element(page.getByText(reason, { exact: true })).toBeInTheDocument();
      const land = button("Land epic")!;
      expect(land.disabled).toBe(true);
      expect(document.getElementById(land.getAttribute("aria-describedby")!)?.textContent).toBe(
        reason,
      );
      expect(land.hasAttribute("title")).toBe(false);
    }
  });
  it("links failed checks to the PR checks page", async () => {
    await render(IntegratedEpicLanding, props(epic({ landingChecks: "failure" })));
    await expect
      .element(page.getByRole("link", { name: "View checks ↗" }))
      .toHaveAttribute("href", "https://github.com/o/r/pull/55/checks");
  });
  it("keeps both nothing-to-land explanations accurate", async () => {
    const { rerender } = await render(IntegratedEpicLanding, props(epic({ landingState: "none" })));
    await expect.element(page.getByText("There is no open landing PR.")).toBeInTheDocument();
    await expect.element(page.getByText("No open landing PR", { exact: true })).toBeInTheDocument();
    expect(document.querySelector(".landing-path li:last-child .step-detail")).toBeNull();
    await expect
      .element(page.getByRole("link", { name: "Open epic issue ↗" }))
      .toHaveAttribute("href", "https://github.com/o/r/issues/327");
    await rerender({ epic: epic({ landingState: "none", children: [] }) });
    await expect
      .element(page.getByText("No sub-task was completed with a PR."))
      .toBeInTheDocument();
    expect(document.querySelector('a[href*="issues/"]')).toBeNull();
  });
  it("confirms included count and migrations before landing", async () => {
    const p = props(epic({ landingReady: true, migrationPaths: ["migrations/1.sql"] }));
    await render(IntegratedEpicLanding, p);
    await page.getByRole("button", { name: "Land epic", exact: true }).click();
    await expect
      .element(page.getByText("This brings 1 sub-task(s) into main and closes epic #327."))
      .toBeInTheDocument();
    await expect.element(page.getByText("1 migration(s) detected")).toBeInTheDocument();
    expect(p.onland).not.toHaveBeenCalled();
    expect(button("Remove from list")).toBeUndefined();
    await page.getByRole("button", { name: "Yes, land now" }).click();
    expect(p.onland).toHaveBeenCalledExactlyOnceWith("/repo", 327);
  });
  it("cancel does not land or remove", async () => {
    const p = props(epic({ landingReady: true }));
    await render(IntegratedEpicLanding, p);
    await page.getByRole("button", { name: "Land epic", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(p.onland).not.toHaveBeenCalled();
    expect(p.ondismiss).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Land epic", exact: true }))
      .toBeEnabled();
  });
  it.each([
    { landingChecks: "failure" },
    { landingRepairing: true },
    { landingMergeable: false },
  ] as const)("invalidates confirmation on %j", async (over) => {
    const p = props(epic({ landingReady: true }));
    const { rerender } = await render(IntegratedEpicLanding, p);
    await page.getByRole("button", { name: "Land epic", exact: true }).click();
    await rerender({ epic: epic({ landingReady: false, ...over }) });
    expect(button("Yes, land now")).toBeUndefined();
    expect(p.onland).not.toHaveBeenCalled();
    await rerender({ epic: epic({ landingReady: true }) });
    expect(button("Yes, land now")).toBeUndefined();
  });
  it("dispatches conflict rework with the shared explanation", async () => {
    const p = props(epic({ landingMergeable: false }));
    await render(IntegratedEpicLanding, p);
    await page.getByRole("button", { name: "Resolve conflicts" }).click();
    expect(p.onresolveconflicts).toHaveBeenCalledExactlyOnceWith("/repo", 327);
    expect(button("Resolve conflicts")!.getAttribute("aria-description")).toContain("force-pushes");
  });
  it.each(["cap", "driver"] as const)(
    "does not offer conflict rework for a %s pause alone",
    async (landingRebasePauseReason) => {
      await render(IntegratedEpicLanding, props(epic({ landingRebasePauseReason })));
      await expect.element(page.getByText("over to you")).toBeInTheDocument();
      expect(button("Resolve conflicts")).toBeUndefined();
    },
  );
  it.each(["pending", "none", "merged", "error"] as const)(
    "retains migration acknowledgement for %s",
    async (landingState) => {
      const p = props(epic({ landingState, migrationPaths: ["db/1.sql"] }));
      await render(IntegratedEpicLanding, p);
      await page.getByRole("button", { name: "Acknowledge migrations & dismiss" }).click();
      expect(p.onackmigrations).toHaveBeenCalledExactlyOnceWith("/repo", 327);
      expect(button("Remove from list")).toBeUndefined();
    },
  );
  it.each(["open", "none", "merged", "pending", "error"] as const)(
    "retains the remove handler for %s",
    async (landingState) => {
      const p = props(epic({ landingState }));
      await render(IntegratedEpicLanding, p);
      await page.getByRole("button", { name: "Remove from list", exact: true }).click();
      expect(p.ondismiss).toHaveBeenCalledExactlyOnceWith("/repo", 327);
      await expect
        .element(page.getByText("hides this row only · PR & branch stay"))
        .toBeInTheDocument();
    },
  );
});

function luminance(color: string): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((n) => {
    const x = n / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const initialTheme = document.documentElement.getAttribute("data-theme");
const initialContrast = document.documentElement.getAttribute("data-contrast");
afterEach(() => {
  for (const [name, value] of [
    ["data-theme", initialTheme],
    ["data-contrast", initialContrast],
  ]) {
    if (value == null) document.documentElement.removeAttribute(name!);
    else document.documentElement.setAttribute(name!, value);
  }
});
it.each([
  ["dark", "", "open"],
  ["light", "", "open"],
  ["dark", "high", "open"],
  ["light", "high", "open"],
  ["dark", "", "merged"],
  ["light", "", "merged"],
  ["dark", "high", "merged"],
  ["light", "high", "merged"],
] as const)("filled actions meet AA in %s/%s/%s", async (theme, contrast, landingState) => {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-contrast", contrast);
  const { rerender } = await render(
    IntegratedEpicLanding,
    props(epic({ landingState, landingReady: true })),
  );
  for (const over of [
    { landingReady: true },
    { landingChecks: "failure", landingReady: false },
  ] as const) {
    await rerender({ epic: epic({ landingState, ...over }) });
    const el = document.querySelector<HTMLElement>(".primary")!;
    const style = getComputedStyle(el);
    const fg = luminance(style.color);
    const bg = luminance(style.backgroundColor);
    expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
