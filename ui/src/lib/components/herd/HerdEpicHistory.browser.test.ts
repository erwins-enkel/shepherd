import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { CompletedEpic } from "#lib/types.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getEpicHistory: vi.fn() };
});

const { getEpicHistory } = await import("#lib/api.js");
const { default: HerdEpicHistory } = await import("./HerdEpicHistory.svelte");
const mockHistory = vi.mocked(getEpicHistory);

const AT = Date.UTC(2026, 10, 10, 1, 2, 21);
const row = (n: number, repo: string, over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: repo,
  parentIssueNumber: n,
  parentTitle: `Epic ${n}`,
  completedAt: AT - 60_000,
  children: [
    {
      number: n * 10,
      title: "child",
      url: `https://github.com/o/r/issues/${n * 10}`,
      prNumber: n * 100,
      prUrl: `https://github.com/o/r/pull/${n * 100}`,
      mergedAt: AT - 120_000,
      integrated: true,
    },
  ],
  landingPrNumber: 45,
  landingPrUrl: "https://github.com/o/r/pull/45",
  landingState: "merged",
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  outcome: "landed",
  succeededAt: AT,
  acknowledgedAt: null,
  ...over,
});

beforeEach(() => mockHistory.mockReset());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("HerdEpicHistory (#3838)", () => {
  it("lists finished epics with their confirmation state and links, scoped by the repo filter", async () => {
    mockHistory.mockResolvedValue([
      row(23, "/w/sevdesk-mcp", { acknowledgedAt: AT + 3_600_000 }),
      row(24, "/w/sevdesk-mcp"),
      row(18, "/w/sevdesk-mcp", { outcome: "closed-unlanded", succeededAt: null }),
      row(9, "/w/other"),
    ]);
    await render(HerdEpicHistory, {
      repoFilter: new Set(["/w/sevdesk-mcp"]),
      nowMs: AT + 7_200_000,
      onacknowledge: vi.fn(),
    });
    await expect.element(page.getByText("Epic 23")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Epic 9");
    expect(document.querySelectorAll("dd time")).toHaveLength(4); // 23: both · 24: completed · 18
    await expect.element(page.getByText("Not confirmed yet")).toBeInTheDocument();
    await expect.element(page.getByText("CLOSED WITHOUT LANDING")).toBeInTheDocument();
    // Only the unconfirmed success offers the confirmation.
    expect(page.getByRole("button", { name: "Confirm completion" }).elements()).toHaveLength(1);

    await page.getByRole("button", { name: "Expand epic #23" }).click();
    await expect
      .element(page.getByRole("link", { name: "Open epic issue ↗" }))
      .toHaveAttribute("href", "https://github.com/o/r/issues/23");
    await expect.element(page.getByRole("link", { name: "Open landing PR ↗" })).toBeInTheDocument();
  });

  it("confirming from the history re-reads it", async () => {
    mockHistory.mockResolvedValueOnce([row(24, "/w/r")]);
    mockHistory.mockResolvedValueOnce([row(24, "/w/r", { acknowledgedAt: AT + 1 })]);
    const onacknowledge = vi.fn(async () => true);
    await render(HerdEpicHistory, { repoFilter: new Set<string>(), nowMs: AT, onacknowledge });
    await page.getByRole("button", { name: "Confirm completion" }).click();
    expect(onacknowledge).toHaveBeenCalledWith("/w/r", 24);
    await expect.element(page.getByText("Confirmed")).toBeInTheDocument();
    expect(mockHistory).toHaveBeenCalledTimes(2);
  });

  it("offers a retry when the history cannot be read", async () => {
    mockHistory.mockRejectedValueOnce(new Error("offline"));
    mockHistory.mockResolvedValueOnce([]);
    await render(HerdEpicHistory, { repoFilter: new Set<string>(), nowMs: AT });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByText("No finished epics yet.")).toBeInTheDocument();
  });
});
