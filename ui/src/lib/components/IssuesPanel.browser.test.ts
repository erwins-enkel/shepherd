import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, EpicSummary, Epic } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getEpic } from "$lib/api";

// Mock the API so no network calls fire; each test seeds the results.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getEpic: vi.fn(),
  };
});

const { default: IssuesPanel } = await import("./IssuesPanel.svelte");

const mockListIssues = vi.mocked(listIssues);
const mockGetEpics = vi.mocked(getEpics);
const mockEpic = vi.mocked(getEpic);
// expandEpic suite below was authored against these aliases — keep them pointing at
// the same mocks so both suites share one reset.
const mockIssues = mockListIssues;
const mockEpics = mockGetEpics;

beforeEach(() => {
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
  mockEpic.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const noop = () => {};

describe("IssuesPanel epic badge", () => {
  function issue(number: number, title: string): Issue {
    return {
      number,
      title,
      url: `https://example.com/issues/${number}`,
      labels: [],
      body: "",
      createdAt: 0,
    };
  }

  function epic(
    parentIssueNumber: number,
    merged: number,
    total: number,
    source: EpicSummary["source"],
  ): EpicSummary {
    return {
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      merged,
      total,
      status: "idle",
      source,
    };
  }

  function seed(issues: Issue[], epics: EpicSummary[] = [], slug = "owner/repo") {
    mockListIssues.mockResolvedValue({ slug, issues });
    mockGetEpics.mockResolvedValue(epics);
  }

  it("native source renders SUB-ISSUES merged/total badge", async () => {
    seed([issue(10, "Parent issue")], [epic(10, 1, 3, "native")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // badge text is the accessible content — assert it directly
    const expectedText = m.subissues_badge({ merged: 1, total: 3 });
    await expect.element(page.getByText(expectedText)).toBeInTheDocument();
    // confirm it's the .epic-badge button
    const badge = document.querySelector(".epic-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).toBe(expectedText);
  });

  it("markdown source renders EPIC merged/total badge", async () => {
    seed([issue(20, "Epic parent")], [epic(20, 2, 4, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    const expectedText = m.epic_badge({ merged: 2, total: 4 });
    await expect.element(page.getByText(expectedText)).toBeInTheDocument();
    const badge = document.querySelector(".epic-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).toBe(expectedText);
  });
});

describe("IssuesPanel expandEpic", () => {
  function issue(number: number, title = `Issue ${number}`): Issue {
    return {
      number,
      title,
      body: "",
      url: `https://example.com/i/${number}`,
      labels: [],
      createdAt: 0,
    };
  }

  function summary(parentIssueNumber: number): EpicSummary {
    return {
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      total: 3,
      merged: 1,
      status: "idle",
      source: "native",
    };
  }

  function epic(parentIssueNumber: number): Epic {
    return {
      repoPath: "/repo",
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      source: "native",
      children: [],
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber, mode: "auto", status: "idle" },
    };
  }

  it("auto-expands the targeted epic's badge (aria-expanded=true)", async () => {
    mockIssues.mockResolvedValue({ slug: "acme/repo", issues: [issue(327), issue(400)] });
    mockEpics.mockResolvedValue([summary(327)]);
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

    // Wait for the epic badge to render, then for it to become expanded.
    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");

    // The one-shot getEpic fetch fired for the target.
    expect(mockEpic).toHaveBeenCalledWith("/repo", 327);
  });

  it("lets the user collapse the targeted epic — it does NOT spring back open", async () => {
    mockIssues.mockResolvedValue({ slug: "acme/repo", issues: [issue(327), issue(400)] });
    mockEpics.mockResolvedValue([summary(327)]);
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

    // Wait for the targeted auto-expand to land.
    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");

    // User clicks the badge to collapse it.
    (document.querySelector(".epic-badge") as HTMLButtonElement).click();

    // It collapses and STAYS collapsed — the effect must not re-expand it.
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("false");
    // Give the effect a chance to (incorrectly) re-fire; assert it stayed collapsed.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does NOT auto-expand any epic when expandEpic is null", async () => {
    mockIssues.mockResolvedValue({ slug: "acme/repo", issues: [issue(327)] });
    mockEpics.mockResolvedValue([summary(327)]);
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: null });

    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    // Badge stays collapsed; no targeted fetch.
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).not.toHaveBeenCalled();
  });
});
