import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, EpicSummary } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics } from "$lib/api";

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

beforeEach(() => {
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const noop = () => {};

describe("IssuesPanel epic badge", () => {
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
