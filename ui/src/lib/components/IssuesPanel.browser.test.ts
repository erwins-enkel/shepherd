import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, EpicSummary, Epic, Steer } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getEpic } from "$lib/api";
import { steers } from "$lib/steers.svelte";
import { issuesFilter } from "$lib/issues-filter.svelte";
import { backlogRefresh } from "$lib/backlog-refresh.svelte";
import { reactiveRecord } from "./reactive-fixture.svelte";

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
  mockEpic.mockImplementation((repoPath: string, parentIssueNumber: number) =>
    Promise.resolve({
      repoPath,
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      source: "native",
      children: [],
      warnings: [],
      run: { repoPath, parentIssueNumber, mode: "auto", status: "idle" },
    }),
  );
});

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1024, 768);
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
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
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
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issues-header")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".issues-header")?.textContent)
      .toContain("owner/repo");
    const link = document.querySelector(".issues-header .repo-link");
    expect(link).toBeNull();
  });
});

describe("IssuesPanel empty vs fetch-failed", () => {
  it("shows the no-open-issues message when the listing is a genuine zero", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain(m.common_no_open_issues());
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(
      m.common_issues_load_failed(),
    );
  });

  it("shows the load-failed message when the forge listing errored (e.g. rate limit)", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
      error: "fetch_failed",
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain(m.common_issues_load_failed());
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(
      m.common_no_open_issues(),
    );
  });
});

describe("IssuesPanel compact issue rows", () => {
  it("uses the shared row hierarchy and keeps Task beside bounded forge labels", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer: null,
      issues: [
        {
          number: 42,
          title: "Compact issue row",
          body: "",
          url: "https://example.com/issues/42",
          labels: ["enhancement", "feedback", "operator UX"],
          labelColors: {
            enhancement: "#a2eeef",
            feedback: "#d4c5f9",
            "operator UX": "#7057ff",
          },
          createdAt: 0,
          assignees: [],
          author: "octocat",
        },
      ],
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issue-main")).toBeTruthy();
    const row = document.querySelector<HTMLElement>(".issue-main")!;
    expect(row.classList).toContain("issue-list-row");
    expect(row.querySelector(".issue-list-number")?.textContent).toBe("#42");
    expect(row.querySelector(".issue-list-title")?.textContent).toBe("Compact issue row");
    expect(row.querySelector(".issue-list-author")?.textContent).toContain("octocat");
    expect(row.querySelectorAll(".issue-label-chip:not(.issue-label-more)")).toHaveLength(2);
    expect(row.querySelector(".issue-label-more")?.textContent).toContain("+1");
    expect(row.querySelector(".issue-list-actions .task-btn")).not.toBeNull();
  });

  it("keeps every narrow-row action scroll-reachable and issue links touch-sized", async () => {
    await page.viewport(400, 800);
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer: null,
      issues: [
        {
          number: 42,
          title: "Issue with several quick actions",
          body: "",
          url: "https://example.com/issues/42",
          labels: [],
          createdAt: 0,
          assignees: [],
        },
      ],
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });

    const previousSteers = steers.list;
    steers.list = Array.from({ length: 8 }, (_, index) => ({
      id: `quick-${index}`,
      label: `Long action ${index + 1}`,
      text: `Run action ${index + 1}`,
      inSteerBar: false,
      onIssues: true,
    }));

    try {
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, onquick: noop });
      await expect.poll(() => document.querySelectorAll(".quick-btn").length).toBe(8);

      const actions = document.querySelector<HTMLElement>(".issue-actions")!;
      const buttons = actions.querySelectorAll<HTMLElement>("button");
      const actionsRect = actions.getBoundingClientRect();
      expect(actions.scrollWidth).toBeGreaterThan(actions.clientWidth);
      expect(buttons[0]!.getBoundingClientRect().left).toBeGreaterThanOrEqual(actionsRect.left);

      actions.scrollLeft = actions.scrollWidth;
      await expect.poll(() => actions.scrollLeft).toBeGreaterThan(0);
      expect(buttons[buttons.length - 1]!.getBoundingClientRect().right).toBeLessThanOrEqual(
        actionsRect.right + 1,
      );

      const hitSize = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
      );
      for (const selector of [".issue-num", ".issue-title"]) {
        const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        expect(rect.height).toBeGreaterThanOrEqual(hitSize);
        expect(rect.width).toBeGreaterThanOrEqual(hitSize);
      }
    } finally {
      steers.list = previousSteers;
    }
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

  function seed(
    issues: Issue[],
    epics: EpicSummary[] = [],
    slug = "owner/repo",
    subIssues: number[] = [],
  ) {
    mockListIssues.mockResolvedValue({ slug, webUrl: null, issues, viewer: null });
    mockGetEpics.mockResolvedValue({ epics, subIssues });
  }

  function liveEpic(
    parentIssueNumber: number,
    states: Epic["children"][number]["state"][],
    source: Epic["source"] = "native",
  ): Epic {
    return {
      repoPath: "/repo",
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      source,
      children: states.map((state, i) => ({
        number: 100 + i,
        title: `Child ${100 + i}`,
        url: `https://example.com/issues/${100 + i}`,
        order: i,
        body: "",
        blockedBy: [],
        state,
        sessionId: null,
        prNumber: null,
        issueClosed: state === "merged",
        claimed: false,
      })),
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber, mode: "auto", status: "idle" },
    };
  }

  it("native source renders SUB-ISSUES merged/total badge", async () => {
    seed([issue(10, "Parent issue")], [epic(10, 1, 3, "native")]);
    mockEpic.mockResolvedValue(liveEpic(10, ["merged", "running", "running"], "native"));
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
    mockEpic.mockResolvedValue(
      liveEpic(20, ["merged", "merged", "running", "running"], "markdown"),
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    const expectedText = m.epic_badge({ merged: 2, total: 4 });
    await expect.element(page.getByText(expectedText)).toBeInTheDocument();
    const badge = document.querySelector(".epic-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).toBe(expectedText);
  });

  it("prefers the live epic's authoritative count over a stale markdown summary", async () => {
    // The list summary is markdown-first and goes stale after an epic is restructured
    // (e.g. badge "0/6"); the live/native record is authoritative ("3/6"). When a live
    // record exists, the collapsed badge must show ITS count, not the stale summary's.
    seed([issue(60, "Epic parent")], [epic(60, 0, 6, "markdown")]); // stale summary → 0/6
    const live: Epic = {
      repoPath: "/repo",
      parentIssueNumber: 60,
      parentTitle: "Epic 60",
      source: "native",
      children: (["merged", "merged", "merged", "running", "running", "running"] as const).map(
        (state, i) => ({
          number: 200 + i,
          title: `Child ${200 + i}`,
          url: `https://example.com/i/${200 + i}`,
          order: i,
          body: "",
          blockedBy: [],
          state,
          sessionId: null,
          prNumber: null,
          issueClosed: state === "merged",
          claimed: false,
        }),
      ),
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber: 60, mode: "auto", status: "idle" },
    };
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, epics: { "/repo#60": live } });

    // The badge shows the live 3/6, never the stale summary 0/6.
    await expect.element(page.getByText(m.epic_badge({ merged: 3, total: 6 }))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(m.epic_badge({ merged: 0, total: 6 }));
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

describe("IssuesPanel blocked badge", () => {
  function issue(number: number, title: string, blockedBy?: number[]): Issue {
    return {
      number,
      title,
      url: `https://example.com/issues/${number}`,
      labels: [],
      body: "",
      createdAt: 0,
      assignees: [],
      ...(blockedBy ? { blockedBy } : {}),
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

  function seed(issues: Issue[], epics: EpicSummary[] = []) {
    mockListIssues.mockResolvedValue({ slug: "owner/repo", webUrl: null, issues, viewer: null });
    mockGetEpics.mockResolvedValue({ epics, subIssues: [] });
  }

  it("renders a blocked-on badge when the issue has open blockers", async () => {
    seed([issue(70, "Blocked issue", [1642])]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    const expectedText = m.issuerow_blocked_on({ deps: "#1642" });
    await expect.element(page.getByText(expectedText)).toBeInTheDocument();
    const chip = document.querySelector(".blocked-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent?.trim()).toBe(expectedText);
  });

  it("renders no blocked chip when the issue has no blockers", async () => {
    seed([issue(71, "Unblocked issue")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issue-title")).toBeTruthy();
    expect(document.querySelector(".blocked-chip")).toBeNull();
  });

  it("does not render the standalone blocked chip on an epic-parent row", async () => {
    seed([issue(72, "Epic parent", [1642])], [epic(72, 1, 3, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    expect(document.querySelector(".blocked-chip")).toBeNull();
  });

  it("renders the in-flight pill on an epic others are working (#1616)", async () => {
    seed(
      [issue(80, "Operator language")],
      [
        {
          parentIssueNumber: 80,
          parentTitle: "Operator language",
          merged: 0,
          total: 5,
          status: "idle",
          source: "markdown",
          inFlight: 5,
          inFlightBy: ["scoop"],
          assignedOthers: [],
          authoredByOther: "scoop",
        },
      ],
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".others-pill")).toBeTruthy();
    expect(document.querySelector(".others-pill")!.textContent).toContain(
      m.issuerow_epic_inflight_pill({ count: 5, who: "scoop" }),
    );
  });

  it("renders an authored pill for a fresh epic set up by someone else", async () => {
    seed(
      [issue(82, "Fresh epic")],
      [
        {
          parentIssueNumber: 82,
          parentTitle: "Fresh epic",
          merged: 0,
          total: 3,
          status: "idle",
          source: "markdown",
          inFlight: 0,
          inFlightBy: [],
          assignedOthers: [],
          authoredByOther: "scoop",
        },
      ],
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".others-pill")).toBeTruthy();
    expect(document.querySelector(".others-pill")!.textContent).toContain(
      m.issuerow_epic_authored_pill({ who: "scoop" }),
    );
  });

  it("renders no pill when the epic isn't flagged for others", async () => {
    seed([issue(81, "My own epic")], [epic(81, 0, 3, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();
    expect(document.querySelector(".others-pill")).toBeNull();
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
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
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

  // Cheap regression guard for the open-epic group container (#1808): the wrapper
  // only reads as one bounded unit while `epic-open` is on it. This asserts the hook
  // exists and tracks the toggle — it does NOT prove the visual result, which rests
  // on the design tokens and review.
  it("marks the wrapper epic-open only while the epic is expanded", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327), issue(400)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

    const row = () => document.querySelector("#epic-issue-row-327");
    await expect.poll(() => row()).toBeTruthy();

    // Expanded (auto-expand targeted it): the wrapper is the group container.
    await expect.poll(() => row()?.classList.contains("epic-open")).toBe(true);

    // Collapsed: the container treatment is gone, so the row renders as before.
    (document.querySelector(".epic-badge") as HTMLButtonElement).click();
    await expect.poll(() => row()?.classList.contains("epic-open")).toBe(false);
    // ...while it stays an epic row — only the OPEN state gained the container.
    expect(row()?.classList.contains("is-epic")).toBe(true);
  });

  it("lets the user collapse the targeted epic — it does NOT spring back open", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327), issue(400)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
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

  it("auto-expands only the topmost epic when expandEpic is null", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(400), issue(327)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(400), summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(400));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: null });

    await expect.poll(() => document.querySelectorAll(".epic-badge").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-badge")];
    await expect.poll(() => badges[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(badges[1]?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).toHaveBeenCalledWith("/repo", 400);
  });

  it("waits for listIssues when getEpics settles first before default-expanding the topmost epic", async () => {
    let resolveIssues!: (r: Awaited<ReturnType<typeof listIssues>>) => void;
    let resolveEpics!: (r: Awaited<ReturnType<typeof getEpics>>) => void;
    mockIssues.mockReturnValue(new Promise((res) => (resolveIssues = res)));
    mockEpics.mockReturnValue(new Promise((res) => (resolveEpics = res)));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    resolveEpics({ epics: [summary(2), summary(1)], subIssues: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".epic-badge")).toBeNull();
    expect(mockEpic).not.toHaveBeenCalled();

    resolveIssues({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(2), issue(1)],
      viewer: null,
    });

    await expect.poll(() => document.querySelectorAll(".epic-badge").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-badge")];
    await expect.poll(() => badges[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(badges[1]?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).toHaveBeenCalledWith("/repo", 2);
  });

  it("expandEpic targeting a non-first epic suppresses default-opening the first epic", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(1), issue(2)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(1), summary(2)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(2));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 2 });

    await expect.poll(() => document.querySelectorAll(".epic-badge").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-badge")];
    await expect.poll(() => badges[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(badges[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).toHaveBeenCalledTimes(1);
    expect(mockEpic).toHaveBeenCalledWith("/repo", 2);
  });

  it("clicking an epic card toggles the same expansion state as the badge", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");
    const row = document.querySelector<HTMLElement>(".issue-row")!;
    row.click();
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("false");
    row.click();
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("clicking inside the expanded EpicPanel subtree does not toggle the row", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue({
      ...epic(327),
      children: [
        {
          number: 500,
          title: "Child row",
          url: "https://example.com/i/500",
          order: 0,
          body: "",
          blockedBy: [],
          state: "running",
          sessionId: null,
          prNumber: null,
          issueClosed: false,
          claimed: false,
        },
      ],
    });

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.element(page.getByText("Child row")).toBeInTheDocument();
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("true");
    document.querySelector<HTMLElement>("[data-epic-panel]")!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("waits for getEpics to settle before scrolling, then lands on the sorted-first row", async () => {
    // Race guard: listIssues and getEpics resolve independently. The scroll must NOT fire
    // on the raw issue list (target still un-pinned, mid-list) — it must wait until
    // getEpics settles so sortEpicsFirst has floated the epic to visibleIssues[0], then
    // scroll THERE. Pin the shared filter singleton (a prior test may have left it dirty)
    // so both issues stay visible and 327 sorts first deterministically; viewer=null also
    // makes hideOthers fail open.
    const prev = {
      others: issuesFilter.hideOthers,
      active: issuesFilter.hideActive,
      sub: issuesFilter.hideSubIssues,
    };
    issuesFilter.set(false);
    issuesFilter.setActive(false);
    issuesFilter.setSubIssues(false);

    const scrollCalls: { id: string; firstRowId: string | undefined }[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrollCalls.push({ id: this.id, firstRowId: document.querySelector(".issue-row")?.id });
    };

    let resolveIssues!: (r: Awaited<ReturnType<typeof listIssues>>) => void;
    let resolveEpics!: (r: Awaited<ReturnType<typeof getEpics>>) => void;
    mockIssues.mockReturnValue(new Promise((res) => (resolveIssues = res)));
    mockEpics.mockReturnValue(new Promise((res) => (resolveEpics = res)));
    mockEpic.mockResolvedValue(epic(327));

    try {
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

      // Issues arrive FIRST, target NOT at position 0, epics still pending.
      resolveIssues({
        slug: "acme/repo",
        webUrl: null,
        issues: [issue(400), issue(327)],
        viewer: null,
      });
      await expect.poll(() => document.querySelectorAll(".issue-row").length).toBe(2);
      // getEpics has not settled → epicsSettled false → NO scroll yet (the bug scrolled here).
      expect(scrollCalls.length).toBe(0);

      // Epics settle: sortEpicsFirst pins 327 to the top and the scroll is released.
      resolveEpics({ epics: [summary(327)], subIssues: [] });
      await expect.poll(() => scrollCalls.length).toBe(1);
      // It scrolled the TARGET row, which is now the first row in the DOM (visibleIssues[0]).
      expect(scrollCalls[0].id).toBe("epic-issue-row-327");
      expect(scrollCalls[0].firstRowId).toBe("epic-issue-row-327");
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      issuesFilter.set(prev.others);
      issuesFilter.setActive(prev.active);
      issuesFilter.setSubIssues(prev.sub);
    }
  });

  it("lands on a target epic even when the mine & unassigned filter would hide it", async () => {
    // hideOthers ON + the epic assigned to someone else would drop its row — but an
    // explicit EPIC-badge navigation must force it back in AND scroll to it.
    const prev = {
      others: issuesFilter.hideOthers,
      active: issuesFilter.hideActive,
      sub: issuesFilter.hideSubIssues,
    };
    issuesFilter.set(true); // hideOthers ON — the case under test
    issuesFilter.setActive(false);
    issuesFilter.setSubIssues(false);

    const scrolled: string[] = [];
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };

    // 327 (target) is assigned to another user → hideOthers would filter it out.
    const target: Issue = { ...issue(327), assignees: ["someone-else"] };
    const mine: Issue = { ...issue(400), assignees: ["me"] };
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [mine, target],
      viewer: "me",
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(327));

    try {
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

      // The filtered-out epic row is force-included…
      await expect.poll(() => document.getElementById("epic-issue-row-327")).toBeTruthy();
      // …and the scroll actually fires on it (not just that the row renders).
      await expect.poll(() => scrolled).toContain("epic-issue-row-327");
    } finally {
      Element.prototype.scrollIntoView = origScroll;
      issuesFilter.set(prev.others);
      issuesFilter.setActive(prev.active);
      issuesFilter.setSubIssues(prev.sub);
    }
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

  // Open the Filters popover by clicking the trigger button.
  const openPopover = () => {
    const trigger = document.querySelector<HTMLButtonElement>(".filter-bar button");
    trigger?.click();
  };

  // Find a checkbox in the open popover by its row label text.
  const checkboxByLabel = (label: string): HTMLInputElement | undefined => {
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      "[popover] input[type=checkbox]",
    );
    return [...checkboxes].find((cb) => {
      const row = cb.closest("label");
      return row?.textContent?.includes(label);
    });
  };

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
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
  }

  const titles = () =>
    [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim());

  it("hides others' issues by default and shows the Filters trigger when viewer is known", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // The Filters trigger button renders in the filter bar.
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>(".filter-bar button"))
      .toBeTruthy();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    expect(titles()).toEqual(["Unassigned issue", "Mine issue"]);
    expect(titles()).not.toContain("Theirs issue");
  });

  it("toggling mine & unassigned off reveals every issue", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    // Open popover then click the mine & unassigned checkbox.
    openPopover();
    await expect.poll(() => checkboxByLabel(m.issues_filter_mine_label())).toBeTruthy();
    checkboxByLabel(m.issues_filter_mine_label())!.click();

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    expect(titles()).toContain("Theirs issue");
  });

  it("hides the mine row but still shows the Filters trigger when viewer is unknown (fail open)", async () => {
    seedMixed(null);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // mine filter fails open (viewer unknown) → all 3 show; Filters trigger still renders.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    // The trigger button is always present (hide-in-progress row is viewer-agnostic).
    expect(document.querySelector(".filter-bar button")).not.toBeNull();

    // Open the popover and confirm mine row is absent but active row is present.
    openPopover();
    await expect
      .poll(() => document.querySelector("[popover] input[type=checkbox]"))
      .not.toBeNull();
    expect(checkboxByLabel(m.issues_filter_mine_label())).toBeUndefined();
    expect(checkboxByLabel(m.issues_filter_active_label())).toBeTruthy();
  });

  // Assignee chips (#824 follow-up): exposed per issue row only when the mine &
  // unassigned filter isn't hiding others' issues.
  const assigneeChips = () => document.querySelectorAll(".label-chip.assignee");
  const assigneeText = () => [...assigneeChips()].map((el) => el.textContent ?? "");

  it("shows no assignee chips while the mine & unassigned filter is active", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    // Filter on + viewer known → every visible issue is mine-or-unassigned, so chips
    // would be redundant and are suppressed.
    expect(assigneeChips().length).toBe(0);
  });

  it("reveals assignee chips when the mine & unassigned filter is toggled off", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    openPopover();
    await expect.poll(() => checkboxByLabel(m.issues_filter_mine_label())).toBeTruthy();
    checkboxByLabel(m.issues_filter_mine_label())!.click();

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    // One chip per assignee login; the unassigned issue contributes none.
    await expect.poll(() => assigneeChips().length).toBe(2);
    expect(assigneeText().some((t) => t.includes("octocat"))).toBe(true);
    expect(assigneeText().some((t) => t.includes("someone-else"))).toBe(true);
  });

  it("shows assignee chips when the viewer is unknown even with the filter on (fail open)", async () => {
    seedMixed(null);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Fail open: all 3 issues show AND the chips render without toggling the filter —
    // guards the `|| viewer == null` clause in IssuesPanel's showAssignees.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    await expect.poll(() => assigneeChips().length).toBe(2);
    expect(assigneeText().some((t) => t.includes("someone-else"))).toBe(true);
  });

  it("hide-in-progress checkbox drops shepherd:active issues and restores them when toggled off", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer: null,
      issues: [
        { ...withAssignees(1, "Plain issue", []), labels: [] },
        { ...withAssignees(2, "Claimed issue", []), labels: ["shepherd:active"] },
      ],
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Off by default → both visible.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    // Open popover and toggle hide-in-progress ON.
    openPopover();
    await expect.poll(() => checkboxByLabel(m.issues_filter_active_label())).toBeTruthy();
    checkboxByLabel(m.issues_filter_active_label())!.click();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(1);
    expect(titles()).toEqual(["Plain issue"]);

    // Open popover again and toggle hide-in-progress OFF.
    openPopover();
    await expect.poll(() => checkboxByLabel(m.issues_filter_active_label())).toBeTruthy();
    checkboxByLabel(m.issues_filter_active_label())!.click();
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    expect(titles()).toContain("Claimed issue");
  });
});

describe("IssuesPanel hide-sub-issues filter (default ON)", () => {
  // Reset filter state before/after each test so order can't leak state.
  // hideSubIssues defaults ON; hideOthers defaults ON; hideActive defaults OFF.
  beforeEach(() => {
    issuesFilter.set(true);
    issuesFilter.setActive(false);
    issuesFilter.setSubIssues(true);
  });
  afterEach(() => {
    issuesFilter.set(true);
    issuesFilter.setActive(false);
    issuesFilter.setSubIssues(true);
  });

  function makeIssue(number: number, title: string): Issue {
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

  function makeSummary(parentIssueNumber: number): EpicSummary {
    return {
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      total: 2,
      merged: 0,
      status: "idle",
      source: "native",
    };
  }

  it("hides a plain sub-issue and keeps a mid-level epic visible (default ON, no toggle)", async () => {
    // Issue 10: plain sub-issue (in subIssues, NOT an epic parent) → must be hidden
    // Issue 20: mid-level epic (in subIssues AND an epic parent) → must stay visible
    // Issue 30: ordinary issue (neither sub-issue nor epic parent) → must stay visible
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      viewer: null,
      issues: [
        makeIssue(10, "Plain sub-issue"),
        makeIssue(20, "Mid-level epic"),
        makeIssue(30, "Ordinary issue"),
      ],
    });
    // subIssues: [10, 20]; epics has 20 as a parent (mid-level epic)
    mockGetEpics.mockResolvedValue({
      epics: [makeSummary(20)],
      subIssues: [10, 20],
    });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Wait for epics to load (badge for issue 20 should appear)
    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();

    const issueTitles = () =>
      [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim());

    // Plain sub-issue (10) is hidden; mid-level epic (20) and ordinary (30) are visible
    await expect.poll(() => issueTitles()).not.toContain("Plain sub-issue");
    expect(issueTitles()).toContain("Mid-level epic");
    expect(issueTitles()).toContain("Ordinary issue");
  });
});

describe("IssuesPanel soft refresh (backlogRefresh)", () => {
  function makeIssue(number: number, title: string): Issue {
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

  function makeSummary(parentIssueNumber: number, merged: number, total: number): EpicSummary {
    return {
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      merged,
      total,
      status: "idle",
      source: "markdown",
    };
  }

  function makeEpic(
    parentIssueNumber: number,
    childStates: Epic["children"][number]["state"][],
  ): Epic {
    return {
      repoPath: "/repo",
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      source: "markdown",
      children: childStates.map((state, i) => ({
        number: 100 + i,
        title: `Child ${100 + i}`,
        url: `https://example.com/i/${100 + i}`,
        order: i,
        body: "",
        blockedBy: [],
        state,
        sessionId: null,
        prNumber: null,
        issueClosed: state === "merged",
        claimed: false,
      })),
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber, mode: "auto", status: "idle" },
    };
  }

  it("mounted with nonce > 0 → single fetch (mount latch swallows the page-lifetime nonce)", async () => {
    // The overlay is {#if}-mounted while the nonce increments page-lifetime, so a
    // panel routinely mounts with nonce > 0 — the latch must NOT read that as a bump.
    backlogRefresh.bump();
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(1, "Only issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(1);
    // Give a (buggy) soft-refresh double-fetch a chance to fire before counting.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(mockGetEpics).toHaveBeenCalledTimes(1);
  });

  it("nonce stable after mount → no extra fetches", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(1, "Only issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(mockGetEpics).toHaveBeenCalledTimes(1);
  });

  it("bump refetches issues + summaries + expanded epic, preserving filter text and expansion", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(50, "Epic parent"), makeIssue(51, "Other issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(50, 1, 3)], subIssues: [] });
    // No `epics` (live store) prop → the expanded panel renders from the one-shot
    // `fetched` cache; the bump must refresh that too.
    mockEpic.mockResolvedValue(makeEpic(50, ["merged", "running", "ready"]));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 50 });

    // Collapsed-row badge from the summary + expanded panel from the fetched Epic.
    await expect.element(page.getByText(m.epic_badge({ merged: 1, total: 3 }))).toBeInTheDocument();
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");
    await expect
      .element(page.getByText(m.epic_progress({ merged: 1, total: 3 })))
      .toBeInTheDocument();
    expect(mockEpic).toHaveBeenCalledTimes(1);

    // Operator types a filter — it must survive the refresh.
    const filterInput = document.querySelector<HTMLInputElement>(".issue-filter")!;
    filterInput.value = "Epic";
    filterInput.dispatchEvent(new InputEvent("input", { bubbles: true }));

    // Reality moved on: one more child merged.
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(50, 2, 3)], subIssues: [] });
    mockEpic.mockResolvedValue(makeEpic(50, ["merged", "merged", "running"]));
    backlogRefresh.bump();

    // Badge + expanded panel both show the new counts…
    await expect.element(page.getByText(m.epic_badge({ merged: 2, total: 3 }))).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_progress({ merged: 2, total: 3 })))
      .toBeInTheDocument();
    // …the expanded fetched-cache epic was re-pulled…
    expect(mockEpic).toHaveBeenCalledTimes(2);
    expect(mockEpic).toHaveBeenLastCalledWith("/repo", 50);
    // …and operator state survived: expansion + filter text intact (no hard reset).
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector<HTMLInputElement>(".issue-filter")?.value).toBe("Epic");
  });

  it("keeps the old list when the refreshed listing reports a fetch failure", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(1, "Survivor issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(1);

    // The wake-refresh hits a rate-limited forge: old data beats an error banner.
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
      error: "fetch_failed",
    });
    backlogRefresh.bump();

    await expect.poll(() => mockListIssues.mock.calls.length).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim()),
    ).toEqual(["Survivor issue"]);
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(
      m.common_issues_load_failed(),
    );
  });

  it("a late-settling mount fetch cannot clobber a newer soft-refresh result", async () => {
    // Mount fetch and soft refresh hit the SAME repo concurrently, so the
    // rp !== repoPath guard alone can't order them — the fetch sequence token must.
    type Listing = Awaited<ReturnType<typeof listIssues>>;
    let rejectMount!: (e: Error) => void;
    const mountFetch = new Promise<Listing>((_res, rej) => {
      rejectMount = rej;
    });
    mockListIssues
      .mockReturnValueOnce(mountFetch) // mount: stays pending
      .mockResolvedValueOnce({
        // soft refresh: settles first, with fresher data
        slug: "owner/repo",
        webUrl: null,
        issues: [makeIssue(2, "Fresh issue")],
        viewer: null,
      });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => mockListIssues.mock.calls.length).toBe(1);
    backlogRefresh.bump();
    await expect.poll(() => mockListIssues.mock.calls.length).toBe(2);

    // The soft result must render even though the mount fetch never settled —
    // i.e. softRefresh clears `loading` so fresh data isn't stuck behind the skeleton.
    await expect
      .poll(() =>
        [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim()),
      )
      .toEqual(["Fresh issue"]);

    // Now the superseded mount fetch settles late — first rejecting would previously
    // stamp loadError over fresh data; a stale .then would restore older issues.
    rejectMount(new Error("late mount failure"));
    await new Promise((r) => setTimeout(r, 50));
    expect(
      [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim()),
    ).toEqual(["Fresh issue"]);
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(
      m.common_issues_load_failed(),
    );
  });

  it("refetches an expanded panel when the live store prunes its record (no stuck loading state)", async () => {
    // A store-backed expanded panel renders via the `epics` prop; when the epic
    // completes, the store PRUNES that record — the backfill must fetch it into the
    // one-shot cache instead of leaving the open panel on its loading state forever.
    // The prune is driven by mutating a deeply-reactive record (see reactiveRecord):
    // the harness's rerender would replace the whole props object and re-run the
    // repo-change reset, which a single store prune never does in production.
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(60, "Epic parent")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(60, 2, 3)], subIssues: [] });
    mockEpic.mockResolvedValue(makeEpic(60, ["merged", "merged", "merged"]));

    const live = reactiveRecord({ "/repo#60": makeEpic(60, ["merged", "merged", "running"]) });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, epics: live, expandEpic: 60 });

    // Panel renders from the live store — no one-shot fetch needed or fired.
    await expect
      .poll(() => document.querySelector(".epic-badge")?.getAttribute("aria-expanded"))
      .toBe("true");
    await expect
      .element(page.getByText(m.epic_progress({ merged: 2, total: 3 })))
      .toBeInTheDocument();
    expect(mockEpic).not.toHaveBeenCalled();

    // The epic finishes → the store drops the key (setEpic finished-prune).
    delete live["/repo#60"];

    // Backfill kicks in: the panel re-renders from the fetched record.
    await expect
      .element(page.getByText(m.epic_progress({ merged: 3, total: 3 })))
      .toBeInTheDocument();
    expect(mockEpic).toHaveBeenCalledWith("/repo", 60);
    expect(document.querySelector(".epic-badge")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a snapshot settling after the live store gained the record is not cached (prune refetches fresh)", async () => {
    // expand → backfill getEpic in flight → epic:update seeds the live record →
    // settle. Caching that pre-run snapshot would make a later finished-prune fall
    // back to stale counts with the backfill seeing a defined record (no refetch).
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(80, "Epic parent")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(80, 0, 3)], subIssues: [] });
    let resolveFirst!: (e: Epic) => void;
    mockEpic
      .mockReturnValueOnce(new Promise<Epic>((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(makeEpic(80, ["merged", "merged", "merged"]));

    const live = reactiveRecord<Epic>({});
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, epics: live, expandEpic: 80 });

    // Backfill fetch #1 fires (no record anywhere) and is held pending.
    await expect.poll(() => mockEpic.mock.calls.length).toBe(1);

    // The epic run starts mid-flight: the live store seeds the record…
    live["/repo#80"] = makeEpic(80, ["merged", "merged", "running"]);
    await expect
      .element(page.getByText(m.epic_progress({ merged: 2, total: 3 })))
      .toBeInTheDocument();
    // …then the pre-run snapshot settles late. It must NOT enter the cache.
    resolveFirst(makeEpic(80, ["ready", "ready", "ready"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".epic-panel, .epic")?.textContent).not.toContain(
      m.epic_progress({ merged: 0, total: 3 }),
    );

    // Epic finishes → store prunes. The backfill must fetch FRESH (call #2), not
    // serve the discarded pre-run snapshot.
    delete live["/repo#80"];
    await expect
      .element(page.getByText(m.epic_progress({ merged: 3, total: 3 })))
      .toBeInTheDocument();
    expect(mockEpic).toHaveBeenCalledTimes(2);
  });

  it("a snapshot settling after seed AND prune both happened mid-flight is discarded", async () => {
    // The narrowest window: expand → backfill getEpic held pending → epic:update
    // seeds the live record → the run completes and the finished-prune drops the
    // key — all BEFORE the fetch settles. At settle epics[key] is undefined again,
    // so the settle-time guard alone would cache the pre-run snapshot; the seed-time
    // invalidation must have already killed the ticket so the prune refetches fresh.
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(90, "Epic parent")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(90, 0, 2)], subIssues: [] });
    let resolveFirst!: (e: Epic) => void;
    mockEpic
      .mockReturnValueOnce(new Promise<Epic>((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(makeEpic(90, ["merged", "merged"]));

    const live = reactiveRecord<Epic>({});
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, epics: live, expandEpic: 90 });
    await expect.poll(() => mockEpic.mock.calls.length).toBe(1); // backfill #1, held pending

    // Run starts (seed) and finishes (prune) while fetch #1 is still in flight.
    live["/repo#90"] = makeEpic(90, ["merged", "running"]);
    await expect
      .element(page.getByText(m.epic_progress({ merged: 1, total: 2 })))
      .toBeInTheDocument();
    delete live["/repo#90"];

    // The prune triggers a FRESH backfill fetch (#2) — the pending flag was cleared
    // at seed time, so the effect isn't blocked by the still-unsettled fetch #1.
    await expect.poll(() => mockEpic.mock.calls.length).toBe(2);
    // Fetch #1's pre-run snapshot settles last; its invalidated ticket discards it.
    resolveFirst(makeEpic(90, ["ready", "ready"]));
    await expect
      .element(page.getByText(m.epic_progress({ merged: 2, total: 2 })))
      .toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain(m.epic_progress({ merged: 0, total: 2 }));
  });

  it("a late epic fetch for a since-collapsed panel is discarded — re-expand refetches", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [makeIssue(70, "Epic parent")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({ epics: [makeSummary(70, 0, 1)], subIssues: [] });
    let resolveFirst!: (e: Epic) => void;
    mockEpic
      .mockReturnValueOnce(new Promise<Epic>((res) => (resolveFirst = res)))
      .mockResolvedValueOnce(makeEpic(70, ["merged"]));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await expect.poll(() => document.querySelector(".epic-badge")).toBeTruthy();

    const badge = () => document.querySelector(".epic-badge") as HTMLButtonElement;
    await expect.poll(() => mockEpic.mock.calls.length).toBe(1); // default expand → fetch #1
    badge().click(); // collapse while the fetch is still in flight

    // The late settle must NOT re-seed the cache for the collapsed panel…
    resolveFirst(makeEpic(70, ["ready"]));
    await new Promise((r) => setTimeout(r, 50));

    // …so re-expanding refetches instead of serving the discarded stale record.
    badge().click();
    await expect.poll(() => mockEpic.mock.calls.length).toBe(2);
    await expect
      .element(page.getByText(m.epic_progress({ merged: 1, total: 1 })))
      .toBeInTheDocument();
  });
});

describe("IssuesPanel issue context menu (inject steer, Surface B)", () => {
  const issueSteer: Steer = {
    id: "st1",
    label: "Fix it",
    text: "/fix please",
    inSteerBar: false,
    onIssues: true,
  };
  beforeEach(() => {
    steers.list = [issueSteer];
  });
  afterEach(() => {
    steers.list = [];
  });

  async function renderWithIssue(extra: Record<string, unknown>) {
    mockListIssues.mockResolvedValue({
      slug: "o/r",
      webUrl: null,
      viewer: null,
      issues: [
        {
          number: 55,
          title: "Add widget",
          body: "the widget body",
          url: "https://gh/o/r/issues/55",
          labels: [],
          createdAt: 0,
          assignees: [],
          author: "bob",
        },
      ],
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, ...extra });
    await expect.poll(() => document.querySelector(".issue-row")).not.toBeNull();
  }

  // A mouse pointerdown pins lastPointerType away from "touch" so the contextmenu opens.
  function rightClickRow() {
    const row = document.querySelector<HTMLElement>(".issue-row")!;
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  }

  it("picking a steer calls oninject(issue, steer) once — opens the dialog pre-seeded, no spawn", async () => {
    const oninject = vi.fn();
    const onquick = vi.fn();
    const onnewtask = vi.fn();
    await renderWithIssue({ oninject, onquick, onnewtask });

    rightClickRow();
    await expect.poll(() => document.querySelector(".issue-menu")).not.toBeNull();
    await page
      .getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix it" }) })
      .click();

    // The page handler seeds composeIssue/composePrompt + showNew from exactly these args.
    expect(oninject).toHaveBeenCalledTimes(1);
    expect(oninject).toHaveBeenCalledWith(expect.objectContaining({ number: 55 }), issueSteer);
    // Inject != execute: neither the quick-launch (spawn) nor the +Task path fired.
    expect(onquick).not.toHaveBeenCalled();
    expect(onnewtask).not.toHaveBeenCalled();
  });

  it("omits steer items when oninject is not provided (Open + Details still shown)", async () => {
    await renderWithIssue({}); // no oninject
    rightClickRow();
    await expect.poll(() => document.querySelector(".issue-menu")).not.toBeNull();

    expect(page.getByRole("menuitem", { name: m.issuemenu_open() }).query()).not.toBeNull();
    expect(
      page.getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix it" }) }).query(),
    ).toBeNull();
  });
});
