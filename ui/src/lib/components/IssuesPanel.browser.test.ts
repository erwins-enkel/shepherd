import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, EpicSummary, Epic, Steer } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getEpic } from "$lib/api";
import { steers } from "$lib/steers.svelte";
import { issuesFilter } from "$lib/issues-filter.svelte";

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

describe("IssuesPanel repo slug link", () => {
  it("renders an <a> linking to webUrl when provided", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: "https://github.com/owner/repo",
      issues: [],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue([]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issues-header")).toBeTruthy();
    const link = document.querySelector(".issues-header .repo-link") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe("https://github.com/owner/repo");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.textContent?.trim()).toBe("owner/repo");
  });

  it("renders slug as plain text when webUrl is null", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue([]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issues-header")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".issues-header")?.textContent)
      .toContain("owner/repo");
    const link = document.querySelector(".issues-header .repo-link");
    expect(link).toBeNull();
  });
});

describe("IssuesPanel epic badge", () => {
  function issue(number: number, title: string): Issue {
    return {
      number,
      title,
      url: `https://example.com/issues/${number}`,
      labels: [],
      body: "",
      createdAt: 0,
      assignees: [],
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
    mockListIssues.mockResolvedValue({ slug, webUrl: null, issues, viewer: null });
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

  it("disables the +Task button on an epic-parent row, enables it on a normal one", async () => {
    seed([issue(30, "Epic parent"), issue(31, "Plain issue")], [epic(30, 1, 2, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Wait until both rows have rendered their +Task buttons.
    await expect.poll(() => document.querySelectorAll(".task-btn").length).toBe(2);

    const rows = document.querySelectorAll(".issue-row");
    const taskBtn = (row: Element) => row.querySelector(".task-btn") as HTMLButtonElement;

    // Row order mirrors the seeded issue order: 30 (epic parent) then 31 (plain).
    const epicTask = taskBtn(rows[0]);
    const plainTask = taskBtn(rows[1]);

    expect(epicTask.disabled).toBe(true);
    expect(epicTask.getAttribute("aria-label")).toBe(m.issuespanel_task_button_epic_disabled());
    expect(epicTask.getAttribute("title")).toBe(m.issuespanel_task_button_epic_disabled());

    expect(plainTask.disabled).toBe(false);
    expect(plainTask.getAttribute("aria-label")).toBe(m.issuespanel_task_button());
  });

  it("disables quick-launch steers on an epic-parent row, enables them on a normal one", async () => {
    const steer: Steer = {
      id: "qa",
      label: "QA",
      text: "Run QA on this issue",
      inSteerBar: false,
      onIssues: true,
    };
    const prev = steers.list;
    steers.list = [steer];
    try {
      seed([issue(40, "Epic parent"), issue(41, "Plain issue")], [epic(40, 1, 2, "markdown")]);
      // onquick must be set for .quick-btn to render at all.
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, onquick: noop });

      // One quick-btn per onIssues steer per row → 2 rows × 1 steer = 2 buttons.
      await expect.poll(() => document.querySelectorAll(".quick-btn").length).toBe(2);

      const rows = document.querySelectorAll(".issue-row");
      const quickBtn = (row: Element) => row.querySelector(".quick-btn") as HTMLButtonElement;

      // Row order mirrors the seeded issue order: 40 (epic parent) then 41 (plain).
      const epicQuick = quickBtn(rows[0]);
      const plainQuick = quickBtn(rows[1]);

      expect(epicQuick.disabled).toBe(true);
      expect(epicQuick.getAttribute("aria-label")).toBe(m.issuespanel_task_button_epic_disabled());
      expect(epicQuick.getAttribute("title")).toBe(m.issuespanel_task_button_epic_disabled());

      expect(plainQuick.disabled).toBe(false);
      expect(plainQuick.getAttribute("aria-label")).toBe(
        m.issuespanel_action_aria({ label: steer.label }),
      );
      expect(plainQuick.getAttribute("title")).toBe(steer.text);
    } finally {
      steers.list = prev;
    }
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
      assignees: [],
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
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327), issue(400)],
      viewer: null,
    });
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
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327), issue(400)],
      viewer: null,
    });
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
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327)],
      viewer: null,
    });
    mockEpics.mockResolvedValue([summary(327)]);
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: null });

    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    // Badge stays collapsed; no targeted fetch.
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).not.toHaveBeenCalled();
  });
});

describe("IssuesPanel mine & unassigned filter (#824)", () => {
  // The toggle store is a localStorage-backed singleton shared across tests;
  // reset it to the defaults (hideOthers on, hideActive off) before each case so
  // order can't leak state.
  beforeEach(() => {
    issuesFilter.set(true);
    issuesFilter.setActive(false);
  });
  afterEach(() => {
    issuesFilter.set(true);
    issuesFilter.setActive(false);
  });

  // Resolve a filter chip by its label text — the bar can hold two chips.
  const chipByLabel = (label: string) =>
    [...document.querySelectorAll(".filter-chip")].find(
      (el) => el.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined;
  const mineChip = () => chipByLabel(m.issues_filter_mine_label());
  const activeChip = () => chipByLabel(m.issues_filter_active_label());

  function withAssignees(number: number, title: string, assignees: string[]): Issue {
    return {
      number,
      title,
      body: "",
      url: `https://example.com/i/${number}`,
      labels: [],
      createdAt: 0,
      assignees,
    };
  }

  function seedMixed(viewer: string | null) {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer,
      issues: [
        withAssignees(1, "Unassigned issue", []),
        withAssignees(2, "Mine issue", ["octocat"]),
        withAssignees(3, "Theirs issue", ["someone-else"]),
      ],
    });
    mockGetEpics.mockResolvedValue([]);
  }

  const titles = () =>
    [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim());

  it("hides others' issues by default and shows the toggle when viewer is known", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => mineChip()).toBeTruthy();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    expect(titles()).toEqual(["Unassigned issue", "Mine issue"]);
    expect(titles()).not.toContain("Theirs issue");
  });

  it("toggling the chip off reveals every issue", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => mineChip()).toBeTruthy();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    mineChip()!.click();

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    expect(titles()).toContain("Theirs issue");
  });

  it("hides the mine chip but keeps the hide-in-progress chip when viewer is unknown (fail open)", async () => {
    seedMixed(null);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // mine filter fails open (viewer unknown) → all 3 show; its chip is gone, but
    // the viewer-agnostic hide-in-progress chip still renders.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    expect(mineChip()).toBeUndefined();
    expect(activeChip()).toBeTruthy();
  });

  it("hide-in-progress chip drops shepherd:active issues and restores them when toggled off", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer: null,
      issues: [
        { ...withAssignees(1, "Plain issue", []), labels: [] },
        { ...withAssignees(2, "Claimed issue", []), labels: ["shepherd:active"] },
      ],
    });
    mockGetEpics.mockResolvedValue([]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Off by default → both visible.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    activeChip()!.click();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(1);
    expect(titles()).toEqual(["Plain issue"]);

    activeChip()!.click();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    expect(titles()).toContain("Claimed issue");
  });
});
