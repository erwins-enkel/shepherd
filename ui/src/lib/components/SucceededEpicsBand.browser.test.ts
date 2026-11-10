import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CompletedEpic } from "#lib/types.js";

const { default: SucceededEpicsBand } = await import("./SucceededEpicsBand.svelte");

const SUCCEEDED_AT = Date.UTC(2026, 10, 10, 1, 2, 21);

/** sevdesk-mcp #23: landing PR #45 merged, the parent closed — no child session left anywhere. */
const epic23 = (over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/home/me/work/sevdesk-mcp",
  parentIssueNumber: 23,
  parentTitle: "M0: Code-Mode spine",
  completedAt: SUCCEEDED_AT - 5 * 60_000,
  children: [
    {
      number: 3,
      title: "docs: add work contract",
      url: "https://github.com/o/sevdesk-mcp/issues/3",
      prNumber: 25,
      prUrl: "https://github.com/o/sevdesk-mcp/pull/25",
      mergedAt: SUCCEEDED_AT - 9 * 3_600_000,
      integrated: true,
    },
  ],
  integrationBranch: "epic/23-m0-code-mode-spine",
  landingPrNumber: 45,
  landingPrUrl: "https://github.com/o/sevdesk-mcp/pull/45",
  landingState: "merged",
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  outcome: "landed",
  succeededAt: SUCCEEDED_AT,
  acknowledgedAt: null,
  ...over,
});

const openLanding = (): CompletedEpic =>
  epic23({
    parentIssueNumber: 24,
    parentTitle: "Still landing",
    landingState: "open",
    outcome: null,
    succeededAt: null,
  });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SucceededEpicsBand (#3838)", () => {
  it("renders nothing while no epic has succeeded", async () => {
    await render(SucceededEpicsBand, { epics: [openLanding()], onacknowledge: vi.fn() });
    expect(document.querySelector(".band")).toBeNull();
  });

  it("shows a landed epic on its own with its status and completion time", async () => {
    await render(SucceededEpicsBand, {
      epics: [epic23(), openLanding()],
      onacknowledge: vi.fn(),
      nowMs: SUCCEEDED_AT + 7 * 3_600_000,
    });
    await expect.element(page.getByText("Successfully completed (1)")).toBeInTheDocument();
    await expect
      .element(page.getByText("SUCCESSFULLY COMPLETED", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("M0: Code-Mode spine")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Still landing");
    const stamp = document.querySelector("time.stamp")!;
    expect(stamp.getAttribute("datetime")).toBe(new Date(SUCCEEDED_AT).toISOString());
    await expect
      .element(page.getByText("1/1 sub-tasks · landing PR #45 merged"))
      .toBeInTheDocument();
  });

  it("opening the epic never confirms it; only the button does", async () => {
    let resolve!: (ok: boolean) => void;
    const onacknowledge = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    await render(SucceededEpicsBand, { epics: [epic23()], onacknowledge });

    await page.getByRole("button", { name: "Expand epic #23" }).click();
    await expect.element(page.getByText("Landed in main", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "Open landing PR ↗" })).toBeInTheDocument();
    expect(onacknowledge).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Confirm completion" }).click();
    expect(onacknowledge).toHaveBeenCalledWith("/home/me/work/sevdesk-mcp", 23);
    await expect.element(page.getByRole("button", { name: "Confirming…" })).toBeDisabled();
    resolve(true);
    await expect.element(page.getByRole("button", { name: "Confirm completion" })).toBeEnabled();
  });

  it("says so when the confirmation failed", async () => {
    await render(SucceededEpicsBand, { epics: [epic23()], onacknowledge: async () => false });
    await page.getByRole("button", { name: "Confirm completion" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Couldn't confirm the completion — try again");
  });

  it("an incremental epic needs no landing PR", async () => {
    await render(SucceededEpicsBand, {
      epics: [
        epic23({
          outcome: "incremental",
          landingState: "none",
          landingPrNumber: null,
          landingPrUrl: null,
          integrationBranch: null,
        }),
      ],
      onacknowledge: vi.fn(),
    });
    await expect
      .element(page.getByText("1 sub-tasks merged into main one by one"))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Expand epic #23" }).click();
    await expect.element(page.getByText("no landing PR needed")).toBeInTheDocument();
  });

  it("pending landing-PR migrations are confirmed together with the success", async () => {
    const onacknowledge = vi.fn();
    const onackmigrations = vi.fn();
    await render(SucceededEpicsBand, {
      epics: [epic23({ migrationPaths: ["db/001.sql"] })],
      onacknowledge,
      onackmigrations,
    });
    await page.getByRole("button", { name: "Confirm migrations & completion" }).click();
    expect(onackmigrations).toHaveBeenCalledWith("/home/me/work/sevdesk-mcp", 23);
    expect(onacknowledge).not.toHaveBeenCalled();
  });
});
