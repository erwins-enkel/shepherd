import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { getLocale, setLocale } from "#lib/paraglide/runtime.js";
import "../../app.css";
import type { CompletedEpic, CompletedEpicChild } from "#lib/types.js";
import IntegratedEpicRow from "./IntegratedEpicRow.svelte";
const child = (over: Partial<CompletedEpicChild> = {}): CompletedEpicChild => ({
  number: 11,
  title: "Child task",
  url: "https://github.com/o/r/issues/11",
  prNumber: 101,
  prUrl: "https://github.com/o/r/pull/101",
  mergedAt: 1000,
  integrated: true,
  ...over,
});
const epic = (over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/repo",
  parentIssueNumber: 327,
  parentTitle: "A long epic title that remains readable in the sidebar",
  completedAt: 1000,
  children: [child(), child({ number: 12, integrated: false, prNumber: null, prUrl: null })],
  integrationBranch: "epic/327-original-title",
  landingPrNumber: 55,
  landingPrUrl: "https://github.com/o/r/pull/55",
  landingState: "open",
  landingChecks: "success",
  landingMergeable: true,
  landingReady: true,
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  ...over,
});
const props = (e: CompletedEpic) => ({
  epic: e,
  nowMs: 600_000,
  onland: vi.fn(),
  ondismiss: vi.fn(),
  onackmigrations: vi.fn(),
});
const locale = getLocale();
afterEach(async () => {
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--ui-scale");
  setLocale(locale, { reload: false });
  await page.viewport(1280, 900);
});

describe("IntegratedEpicRow", () => {
  it("shows the turn and summary before expanding", async () => {
    await render(IntegratedEpicRow, props(epic()));
    await expect.element(page.getByText("READY TO LAND", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Landing PR #55 is green", { exact: true }))
      .toBeInTheDocument();
    expect(document.querySelector(".landing-path")).toBeNull();
  });
  it("shows all tasks done separately from PR inclusion", async () => {
    await render(IntegratedEpicRow, props(epic()));
    await page.getByRole("button", { name: "Expand epic #327" }).click();
    await expect.element(page.getByText("2/2", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("1 with PR · 1 without PR", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("epic/327-original-title", { exact: true }))
      .toBeInTheDocument();
    expect(document.querySelector(".child")).toBeNull();
    await page.getByRole("button", { name: "In the landing PR · 1 of 2 sub-tasks" }).click();
    await expect
      .element(page.getByRole("link", { name: "PR #101", exact: true }))
      .toHaveAttribute("href", "https://github.com/o/r/pull/101");
    await expect
      .element(page.getByText("without PR · not included", { exact: true }))
      .toBeInTheDocument();
    expect(
      document
        .querySelector(".landing-path")!
        .compareDocumentPosition(document.querySelector(".children")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it.each([
    [{ landingState: "pending" }, "NOTHING TO DO"],
    [{ landingReady: false, landingChecks: "pending" }, "NOTHING TO DO"],
    [{ landingRepairing: true }, "NOTHING TO DO"],
    [{ landingChecks: "failure" }, "YOUR TURN"],
    [{ landingMergeable: false }, "YOUR TURN"],
    [{ landingState: "none" }, "YOUR TURN"],
    [{ landingState: "merged" }, "DONE"],
    [{ landingState: "error" }, "YOUR TURN"],
  ] as const)("shows the right turn for %j", async (over, label) => {
    await render(IntegratedEpicRow, props(epic(over)));
    await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument();
    expect(document.querySelector(".row")!.classList.contains("ready")).toBe(false);
  });
  it("#2872: a red landing Shepherd still retries is nobody's turn yet", async () => {
    await render(
      IntegratedEpicRow,
      props(
        epic({
          landingChecks: "failure",
          landingCiAutomation: {
            reruns: { status: "pending", used: 0, cap: 2, skipReason: null },
            repair: {
              status: "pending",
              used: 0,
              cap: 1,
              skipReason: null,
              sessionId: null,
              sessionStartedAt: null,
            },
          },
        }),
      ),
    );
    await expect.element(page.getByText("NOTHING TO DO", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Shepherd is re-running the red checks", { exact: true }))
      .toBeInTheDocument();
  });
  it("uses completion age for waiting and preserves stale conflicts", async () => {
    await render(
      IntegratedEpicRow,
      props(
        epic({ landingStranded: true, landingConflictStranded: true, landingConflictSince: 1000 }),
      ),
    );
    await expect.element(page.getByText("Waiting for 9m")).toBeInTheDocument();
    await expect.element(page.getByText("conflict unresolved for 9m")).toBeInTheDocument();
  });
  it.each(["en", "de"] as const)(
    "keeps the title on its own line at 340px in %s",
    async (language) => {
      setLocale(language, { reload: false });
      await page.viewport(340, 800);
      await render(IntegratedEpicRow, props(epic()));
      const title = await vi.waitFor(() => {
        const el = document.querySelector<HTMLElement>(".epic-title");
        if (!el) throw new Error("missing title");
        return el;
      });
      expect(title.getBoundingClientRect().width).toBeGreaterThan(200);
      expect(title.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        document.querySelector(".identity")!.getBoundingClientRect().bottom,
      );
      expect(getComputedStyle(title).webkitLineClamp).toBe("1");
      (document.querySelector(".row-head") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(getComputedStyle(title).webkitLineClamp).toBe("3"));
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(340);
      document.documentElement.style.setProperty("--ui-scale", "1.2");
      const collected = document.querySelectorAll(".landing-path li")[1];
      expect(
        collected.querySelector(".step-value")!.getBoundingClientRect().right,
      ).toBeGreaterThanOrEqual(
        collected.querySelector(".step-content")!.getBoundingClientRect().right - 1,
      );
    },
  );
  it("retains missing PR metadata and redundant title fallbacks", async () => {
    await render(
      IntegratedEpicRow,
      props(
        epic({
          children: [child({ prNumber: null }), child({ number: 12, title: "#12", prUrl: null })],
        }),
      ),
    );
    await page.getByRole("button", { name: "Expand epic #327" }).click();
    await page.getByRole("button", { name: "In the landing PR · 2 of 2 sub-tasks" }).click();
    await expect
      .element(page.getByRole("link", { name: "PR", exact: true }))
      .toHaveAttribute("href", "https://github.com/o/r/pull/101");
    expect(document.querySelectorAll(".child .child-title")).toHaveLength(1);
  });
});
