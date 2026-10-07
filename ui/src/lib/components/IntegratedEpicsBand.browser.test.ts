import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { CompletedEpic } from "$lib/types";

const { default: IntegratedEpicsBand } = await import("./IntegratedEpicsBand.svelte");

const epic = (n: number, over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: `/home/me/work/repo${n}`,
  parentIssueNumber: 300 + n,
  parentTitle: `Epic ${n}`,
  completedAt: Date.now() - 60_000,
  children: [
    {
      number: n * 10,
      title: "c",
      url: `https://github.com/o/r/issues/${n * 10}`,
      prNumber: n * 100,
      prUrl: `https://github.com/o/r/pull/${n * 100}`,
      mergedAt: Date.now() - 30_000,
      integrated: true,
    },
  ],
  landingPrNumber: null,
  landingPrUrl: null,
  landingState: "pending",
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  ...over,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntegratedEpicsBand", () => {
  it("renders nothing when epics is empty", async () => {
    await render(IntegratedEpicsBand, {
      epics: [],
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    expect(document.querySelector(".band")).toBeNull();
    expect(document.querySelector(".band-head")).toBeNull();
  });

  it("header shows the count and expanding reveals one row per epic", async () => {
    await render(IntegratedEpicsBand, {
      epics: [epic(1), epic(2)],
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    await expect.element(page.getByText("Epics to land (2)")).toBeInTheDocument();
    // collapsed by default → no rows
    expect(document.querySelectorAll(".rows .row").length).toBe(0);
    (document.querySelector(".band-head") as HTMLButtonElement).click();
    const rows = await vi.waitFor(() => {
      const r = document.querySelectorAll(".rows .row");
      if (r.length !== 2) throw new Error("rows not yet rendered");
      return r;
    });
    expect(rows.length).toBe(2);
  });
});

const handlers = { ondismiss: vi.fn(), onackmigrations: vi.fn(), onland: vi.fn() };
it("opens for actionable epics, counts only operator turns and sorts stably", async () => {
  await render(IntegratedEpicsBand, {
    ...handlers,
    epics: [
      epic(1),
      epic(2, { landingState: "open", landingChecks: "failure" }),
      epic(3, { landingState: "open", landingReady: true, landingPrNumber: 33 }),
      epic(4, { landingState: "none" }),
      epic(5, { landingState: "open", landingRepairing: true }),
      epic(6, { landingState: "merged" }),
    ],
  });
  await expect.element(page.getByText("3 waiting on you", { exact: true })).toBeInTheDocument();
  expect(
    [...document.querySelectorAll(".rows .row")].map((el) => el.getAttribute("aria-label")),
  ).toEqual(["Epic 3", "Epic 2", "Epic 4", "Epic 1", "Epic 5", "Epic 6"]);
});
it("keeps summary and help visible when collapsed and retains the user choice on refresh", async () => {
  const { rerender } = await render(IntegratedEpicsBand, {
    ...handlers,
    epics: [epic(1, { landingState: "none" })],
  });
  await page.getByRole("button", { name: "Epics to land (1)", exact: true }).click();
  await rerender({ epics: [epic(1, { landingState: "none", parentTitle: "Refreshed" })] });
  expect(document.querySelector(".row")).toBeNull();
  await expect
    .element(page.getByText("All sub-tasks done — one final PR brings the work into main."))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "How it works", exact: true }))
    .toBeInTheDocument();
});
it("opens a structured explanation with a readable hover bridge and Escape dismissal", async () => {
  await render(IntegratedEpicsBand, { ...handlers, epics: [epic(1)] });
  const trigger = document.querySelector<HTMLButtonElement>(".help")!;
  trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  await vi.waitFor(() => expect(document.querySelector(".status-tip:popover-open")).not.toBeNull());
  const tip = document.querySelector<HTMLElement>(".status-tip")!;
  expect(tip.textContent).toContain("Your part");
  expect(tip.textContent).toContain("Not included");
  trigger.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
  tip.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  expect(tip.matches(":popover-open")).toBe(true);
  await page.getByRole("button", { name: "How it works" }).click();
  trigger.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch" }));
  expect(tip.matches(":popover-open")).toBe(true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await vi.waitFor(() => expect(tip.matches(":popover-open")).toBe(false));
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(tip.matches(":popover-open")).toBe(true));
  expect(trigger.getAttribute("title")).toBeNull();
});
