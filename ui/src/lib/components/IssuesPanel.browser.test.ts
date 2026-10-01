import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
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

// List option by row key (issues-panel.ts: e:<n> epic, s:<n> single, c:<parent>:<n> child).
const option = (key: string) => document.getElementById(`issue-opt-${key}`);
// Select a list entry (a click on its option row) and wait for the reading detail.
async function selectRow(key: string) {
  await expect.poll(() => option(key)).not.toBeNull();
  option(key)!.click();
  await expect.poll(() => option(key)?.getAttribute("aria-selected")).toBe("true");
}
// An epic header's "merged/total" count.
const userKey = (key: string) => userEvent.keyboard(key.length === 1 ? key : `{${key}}`);
const epicCount = (n: number) => option(`e:${n}`)?.querySelector(".count")?.textContent?.trim();

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

  it("names lightweight mode instead of reporting a missing git host", async () => {
    // LocalForge reports a null slug too, so without the flag this lands on the
    // "no git host configured" branch — a GitHub problem the operator does not have.
    mockListIssues.mockResolvedValue({
      slug: null,
      webUrl: null,
      issues: [],
      viewer: null,
      lightweight: true,
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain(m.common_issues_lightweight());
    const list = document.querySelector(".issues-list")?.textContent;
    expect(list).not.toContain(m.issuespanel_no_host());
    expect(list).not.toContain(m.common_issues_load_failed());
  });

  it("offers an inline retry from the load-failed state that re-fetches in place", async () => {
    mockListIssues
      .mockResolvedValueOnce({
        slug: "owner/repo",
        webUrl: null,
        issues: [],
        viewer: null,
        error: "fetch_failed",
      })
      .mockResolvedValueOnce({
        slug: "owner/repo",
        webUrl: null,
        issues: [
          {
            number: 42,
            title: "Recovered issue",
            body: "",
            url: "https://example.com/issues/42",
            labels: [],
            createdAt: 0,
            assignees: [],
          },
        ],
        viewer: null,
      });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".issues-list .retry-link")?.textContent)
      .toBe(m.common_retry());
    (document.querySelector(".issues-list .retry-link") as HTMLButtonElement).click();

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain("Recovered issue");
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(
      m.common_issues_load_failed(),
    );
    expect(mockListIssues).toHaveBeenCalledTimes(2);
  });

  it("a retry that fails again keeps the failure banner instead of an eternal skeleton", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
      error: "fetch_failed",
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelector(".issues-list .retry-link")).toBeTruthy();
    (document.querySelector(".issues-list .retry-link") as HTMLButtonElement).click();

    await expect.poll(() => mockListIssues.mock.calls.length).toBe(2);
    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain(m.common_issues_load_failed());
    expect(document.querySelector(".issues-list")?.textContent).not.toContain(m.common_loading());
  });

  // The two gh transports draw on independent budgets, so "couldn't load" alone
  // doesn't say whether to wait for a reset or fix a login. Name what actually ran.
  it("names each gh transport that failed, in the order it ran", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
      error: "fetch_failed",
      attempts: [
        {
          transport: "rest",
          reason: "rate_limit",
          status: 403,
          detail: "gh: rate limit (HTTP 403)",
        },
        { transport: "cli", reason: "auth", status: 401, detail: "gh: Bad credentials (HTTP 401)" },
      ],
    });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain(m.issues_attempts_label());
    const lines = Array.from(document.querySelectorAll(".issues-list .attempt")).map(
      (el) => el.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
    expect(lines).toEqual([
      `${m.issues_transport_rest()} → ${m.issues_attempt_rate_limit()}`,
      `${m.issues_transport_cli()} → ${m.issues_attempt_auth()}`,
    ]);
  });

  it("drops the transport trail once a retry succeeds", async () => {
    // The trail explains one failed fetch; leaving it up over recovered data would
    // report a state that no longer exists.
    mockListIssues
      .mockResolvedValueOnce({
        slug: "owner/repo",
        webUrl: null,
        issues: [],
        viewer: null,
        error: "fetch_failed",
        attempts: [{ transport: "cli", reason: "network", detail: "ECONNREFUSED" }],
      })
      .mockResolvedValueOnce({
        slug: "owner/repo",
        webUrl: null,
        issues: [
          {
            number: 42,
            title: "Recovered issue",
            body: "",
            url: "https://example.com/issues/42",
            labels: [],
            createdAt: 0,
            assignees: [],
          },
        ],
        viewer: null,
      });
    mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issues-list .attempt").length).toBe(1);
    (document.querySelector(".issues-list .retry-link") as HTMLButtonElement).click();

    await expect
      .poll(() => document.querySelector(".issues-list")?.textContent)
      .toContain("Recovered issue");
    expect(document.querySelectorAll(".issues-list .attempt")).toHaveLength(0);
  });
});

describe("IssuesPanel list + reading detail (#2617)", () => {
  function plain(number: number, over: Partial<Issue> = {}): Issue {
    return {
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://example.com/issues/${number}`,
      labels: [],
      createdAt: 0,
      assignees: [],
      ...over,
    };
  }
  function seed(issues: Issue[], epics: EpicSummary[] = [], subIssues: number[] = []) {
    mockListIssues.mockResolvedValue({ slug: "owner/repo", webUrl: null, viewer: null, issues });
    mockGetEpics.mockResolvedValue({ epics, subIssues });
  }
  function summary(parentIssueNumber: number, source: EpicSummary["source"] = "native") {
    return {
      parentIssueNumber,
      parentTitle: `Epic ${parentIssueNumber}`,
      merged: 0,
      total: 1,
      status: "idle",
      source,
    } satisfies EpicSummary;
  }
  function childOf(number: number, title = `Child ${number}`): Epic["children"][number] {
    return {
      number,
      title,
      url: `https://example.com/issues/${number}`,
      order: 0,
      body: "Child **body**",
      blockedBy: [],
      state: "ready",
      sessionId: null,
      prNumber: null,
      issueClosed: false,
      claimed: false,
    };
  }

  it("lists singles on two lines and shows the repo overview until one is picked", async () => {
    seed([
      plain(42, {
        title: "Compact issue row",
        labels: ["enhancement", "feedback", "operator UX"],
        author: "octocat",
      }),
    ]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => option("s:42")).not.toBeNull();
    const row = option("s:42")!;
    expect(row.getAttribute("role")).toBe("option");
    expect(row.querySelector(".issue-title")?.textContent).toBe("Compact issue row");
    expect(row.querySelector(".meta")?.textContent).toContain("#42 · enhancement · ");
    const overview = document.querySelector<HTMLElement>(".detail-col .overview")!;
    expect(overview.querySelector("h2")?.textContent).toBe(m.repooverview_title({ repo: "repo" }));
    expect(overview.querySelector("[data-repo-run]")?.textContent).toContain(m.repooverview_hint());
    overview.querySelector<HTMLButtonElement>(".single")!.click();
    await expect.poll(() => option("s:42")?.getAttribute("aria-selected")).toBe("true");
  });

  it("a click selects the entry and the detail renders its Markdown description", async () => {
    seed([
      plain(42, {
        title: "Readable issue",
        body: "## Warum\n\nDas ist **wichtig**.",
        labels: ["enhancement", "feedback", "operator UX"],
        author: "octocat",
      }),
    ]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("s:42");

    const detail = () => document.querySelector<HTMLElement>(".issue-detail");
    await expect.poll(() => detail()?.querySelector(".md-body h2")?.textContent).toBe("Warum");
    expect(detail()!.querySelector(".md-body strong")?.textContent).toBe("wichtig");
    expect(detail()!.textContent).not.toContain("##");
    expect(detail()!.textContent).not.toContain("**");
    expect(detail()!.querySelector("h2.title")?.textContent).toBe("Readable issue");
    expect(detail()!.querySelector(".meta")?.textContent).toContain("octocat");
    expect(detail()!.querySelectorAll(".issue-label-chip:not(.issue-label-more)")).toHaveLength(2);
    expect(detail()!.querySelector(".gh-link")?.getAttribute("href")).toBe(
      "https://example.com/issues/42",
    );
    expect(detail()!.textContent).toContain(m.issuetask_state_not_started());
    expect(detail()!.textContent).toContain(m.issuetask_no_epic_hint());
  });

  it("a hovered row never looks selected: only the selection gets the left edge (#2638)", async () => {
    await page.viewport(1440, 900);
    seed([plain(1), plain(2)]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("s:1");
    await userEvent.hover(option("s:2")!);

    const selected = getComputedStyle(option("s:1")!);
    const hovered = getComputedStyle(option("s:2")!);
    await expect
      .poll(() => getComputedStyle(option("s:2")!).backgroundColor)
      .not.toBe("rgba(0, 0, 0, 0)");
    expect(option("s:2")!.classList.contains("selected")).toBe(false);
    expect(option("s:2")!.getAttribute("aria-selected")).toBe("false");
    expect(hovered.boxShadow).toBe("none");
    expect(selected.boxShadow).toContain("inset");
    expect(hovered.backgroundColor).not.toBe(selected.backgroundColor);
  });

  it("titles wrap to two lines before the ellipsis (#2638)", async () => {
    seed([plain(1, { title: "A long title ".repeat(20) })]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await expect.poll(() => option("s:1")).not.toBeNull();
    const title = getComputedStyle(option("s:1")!.querySelector(".issue-title")!);
    expect(title.webkitLineClamp).toBe("2");
    expect(title.whiteSpace).not.toBe("nowrap");
  });

  it("↑/↓ move the selection, → expands an epic and A starts a task", async () => {
    const onnewtask = vi.fn();
    seed([plain(1, { title: "Epic parent" }), plain(2), plain(3)], [summary(1)]);
    mockEpic.mockResolvedValue({
      repoPath: "/repo",
      parentIssueNumber: 1,
      parentTitle: "Epic 1",
      source: "native",
      children: [childOf(9)],
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber: 1, mode: "auto", status: "idle" },
    });
    render(IssuesPanel, { repoPath: "/repo", onnewtask });
    // The first epic auto-expands; collapse it so → has something to do.
    await expect.poll(() => option("c:1:9")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".epic-toggle")!.click();
    await expect.poll(() => option("c:1:9")).toBeNull();

    document.querySelector<HTMLElement>(".issue-options")!.focus();
    await userKey("ArrowDown");
    expect(option("e:1")?.getAttribute("aria-selected")).toBe("true");
    await userKey("ArrowRight");
    await expect.poll(() => option("c:1:9")).not.toBeNull();
    await userKey("ArrowDown");
    expect(option("c:1:9")?.getAttribute("aria-selected")).toBe("true");
    await userKey("ArrowDown");
    await userKey("ArrowDown");
    expect(option("s:3")?.getAttribute("aria-selected")).toBe("true");
    await userKey("ArrowUp");
    expect(option("s:2")?.getAttribute("aria-selected")).toBe("true");
    await userKey("a");
    expect(onnewtask).toHaveBeenCalledWith(expect.objectContaining({ number: 2 }), {});
    expect(document.querySelector(".shortcuts")?.textContent).toBe(m.issuespanel_shortcuts());
  });

  it("the task box starts a task with the changed run settings and keeps quick steers", async () => {
    const onnewtask = vi.fn();
    const onquick = vi.fn();
    const previousSteers = steers.list;
    steers.list = [{ id: "qa", label: "QA", text: "Run QA", inSteerBar: false, onIssues: true }];
    try {
      seed([plain(42)]);
      render(IssuesPanel, { repoPath: "/repo", onnewtask, onquick });
      await selectRow("s:42");

      const box = () => document.querySelector<HTMLElement>(".task-box")!;
      await expect.poll(() => document.querySelector(".task-box")).not.toBeNull();
      box().querySelector<HTMLButtonElement>(".task-btn")!.click();
      expect(onnewtask).toHaveBeenLastCalledWith(expect.objectContaining({ number: 42 }), {});

      const [, modelSelect] = box().querySelectorAll<HTMLSelectElement>("select");
      modelSelect.value = "sonnet";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await expect.poll(() => modelSelect.value).toBe("sonnet");
      box().querySelector<HTMLButtonElement>(".task-btn")!.click();
      expect(onnewtask).toHaveBeenLastCalledWith(
        expect.objectContaining({ number: 42 }),
        expect.objectContaining({ agentProvider: "claude", model: "sonnet" }),
      );

      box().querySelector<HTMLButtonElement>(".quick-btn")!.click();
      expect(onquick).toHaveBeenCalledWith(
        expect.objectContaining({ number: 42 }),
        expect.objectContaining({ id: "qa" }),
      );
    } finally {
      steers.list = previousSteers;
    }
  });

  it("lists a sub-issue only under its epic, never among the singles", async () => {
    seed(
      [plain(1, { title: "Epic parent" }), plain(9, { title: "Sub issue" }), plain(3)],
      [summary(1)],
      [9],
    );
    mockEpic.mockResolvedValue({
      repoPath: "/repo",
      parentIssueNumber: 1,
      parentTitle: "Epic 1",
      source: "native",
      children: [childOf(9, "Sub issue")],
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber: 1, mode: "auto", status: "idle" },
    });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => option("c:1:9")).not.toBeNull();
    expect(option("s:9")).toBeNull();
    expect(document.querySelectorAll(".single-row")).toHaveLength(1);
    expect(document.body.textContent?.match(/Sub issue/g)).toHaveLength(1);
    expect(document.querySelector(".section-heading")?.textContent).toBe(
      m.issuespanel_singles_heading(),
    );

    // A child entry reads its own description (rendered).
    await selectRow("c:1:9");
    await expect
      .poll(() => document.querySelector(".issue-detail .md-body strong")?.textContent)
      .toBe("body");
    expect(document.querySelector(".issue-detail .epic-tag")?.textContent).toBe(
      m.issuedetail_back_to_epic({ parent: 1 }),
    );
    expect(document.querySelector(".task-box")).toBeNull();
  });

  it("an epic shows its controls in the run area and moves Import + Diagnose into ⋯", async () => {
    seed([plain(5, { title: "Markdown epic", body: "- [ ] #6" })], [summary(5, "markdown")]);
    mockEpic.mockResolvedValue({
      repoPath: "/repo",
      parentIssueNumber: 5,
      parentTitle: "Markdown epic",
      source: "markdown",
      children: [childOf(6)],
      warnings: [],
      run: { repoPath: "/repo", parentIssueNumber: 5, mode: "auto", status: "idle" },
    });
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("e:5");

    const detail = () => document.querySelector<HTMLElement>(".issue-detail")!;
    await expect.poll(() => document.querySelector(".issue-detail .epic")).not.toBeNull();
    // The run area (#2620) sits between the head and the children and holds every control.
    const region = detail().querySelector<HTMLElement>("[data-epic-run]")!;
    const text = region.textContent ?? "";
    for (const label of [m.epic_start(), m.epic_mode_auto(), m.epic_provider_label()]) {
      expect(text).toContain(label);
    }
    expect(region.compareDocumentPosition(detail().querySelector(".epic")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(document.querySelector(".task-box")).toBeNull();
    // Import + Diagnose live in the ⋯ menu, not in EpicPanel's head.
    const epicHead = detail().querySelector(".epic-head")!;
    expect(epicHead.textContent).not.toContain(m.epic_import());
    expect(epicHead.textContent).not.toContain(m.epic_diag_open());
    detail().querySelector<HTMLButtonElement>(".more-btn")!.click();
    await expect.poll(() => document.querySelector(".detail-menu")).not.toBeNull();
    const items = [...document.querySelectorAll(".detail-menu [role=menuitem]")].map((el) =>
      el.textContent?.trim(),
    );
    expect(items).toEqual([m.epic_import(), m.epic_diag_open()]);
  });

  // The issue's acceptance scenario (#2620): maxAuto = 1, epic B (#20) leads and waits for the
  // slot, epic A's (#10) child #11 holds it.
  it("roles: 'leads' on B, 'winding down' on A, the slot line, and the holding child", async () => {
    seed(
      [plain(10, { title: "Epic A" }), plain(20, { title: "Epic B" })],
      [summary(10), summary(20)],
    );
    mockEpic.mockImplementation((repoPath: string, parentIssueNumber: number) =>
      Promise.resolve({
        repoPath,
        parentIssueNumber,
        parentTitle: `Epic ${parentIssueNumber}`,
        source: "native",
        children:
          parentIssueNumber === 10
            ? [{ ...childOf(11, "Child of A"), state: "running" as const }]
            : [childOf(21, "First of B")],
        warnings: [],
        run: {
          repoPath,
          parentIssueNumber,
          mode: "auto",
          status: parentIssueNumber === 20 ? "running" : "idle",
        },
      }),
    );
    const onopenautomation = vi.fn();
    render(IssuesPanel, {
      repoPath: "/repo",
      onnewtask: noop,
      onopenautomation,
      drain: {
        repoPath: "/repo",
        enabled: true,
        paused: false,
        reason: "cap",
        detail: null,
        queued: 1,
        inFlight: 1,
        max: 1,
        epicParent: 20,
        runSummary: {
          leadingEpic: 20,
          windingDown: [{ epic: 10, inFlight: [11] }],
          slots: {
            used: 1,
            max: 1,
            holders: [{ sessionId: "s11", desig: "TASK-11", issueNumber: 11, epicParent: 10 }],
          },
          next: [21],
          after: [],
        },
      },
    });

    await expect.poll(() => option("e:20")?.textContent).toContain(m.epic_role_leading());
    expect(option("e:10")?.textContent).toContain(m.epic_role_winding());
    await expect.element(page.getByText(m.issuespanel_epics_one_leads())).toBeInTheDocument();
    await page.getByRole("button", { name: m.issuespanel_slots_change(), exact: true }).click();
    expect(onopenautomation).toHaveBeenCalled();
    // Nothing selected yet: the repo overview names the leading epic (#2622).
    await expect
      .poll(() => document.querySelector("[data-repo-run] .run-state")?.textContent)
      .toContain(m.repooverview_leading({ epic: 20, state: m.epic_run_state_waiting_slot() }));

    // A (#10) is expanded by default (topmost epic): its running child holds the slot.
    await expect
      .poll(() => option("c:10:11")?.textContent)
      .toContain(m.epic_slot_held({ index: 1, max: 1 }));

    await selectRow("e:20");
    await expect
      .poll(() => document.querySelector("[data-epic-run]")?.textContent)
      .toContain(m.epic_run_state_waiting_slot());
    const region = document.querySelector("[data-epic-run]")!.textContent ?? "";
    expect(region).toContain("Child of A");
    expect(region).toContain("#21 First of B");
  });

  it("roles: an epic in the queue (#2624) reads 'queued' with its place", async () => {
    seed(
      [
        plain(20, { title: "Epic B" }),
        plain(30, { title: "Epic C" }),
        plain(40, { title: "Epic D" }),
      ],
      [summary(20), summary(30), summary(40)],
    );
    mockEpic.mockImplementation((repoPath: string, parentIssueNumber: number) =>
      Promise.resolve({
        repoPath,
        parentIssueNumber,
        parentTitle: `Epic ${parentIssueNumber}`,
        source: "native",
        children: [childOf(parentIssueNumber + 1)],
        warnings: [],
        run: { repoPath, parentIssueNumber, mode: "auto", status: "idle" },
      }),
    );
    render(IssuesPanel, {
      repoPath: "/repo",
      onnewtask: noop,
      drain: {
        repoPath: "/repo",
        enabled: true,
        paused: false,
        reason: null,
        detail: null,
        queued: 0,
        inFlight: 0,
        max: 1,
        epicParent: 20,
        runSummary: {
          leadingEpic: 20,
          windingDown: [],
          slots: { used: 0, max: 1, holders: [] },
          next: [],
          after: [],
          queued: [40, 30],
        },
      },
    });

    await expect.poll(() => option("e:20")?.textContent).toContain(m.epic_role_leading());
    expect(option("e:40")?.textContent).toContain(m.epic_role_queued({ position: 1 }));
    expect(option("e:30")?.textContent).toContain(m.epic_role_queued({ position: 2 }));
  });

  it("a click on the flow graph (#2621) opens the epic in the list and selects the child", async () => {
    seed(
      [plain(10, { title: "Epic A" }), plain(20, { title: "Epic B" })],
      [summary(10), summary(20)],
    );
    mockEpic.mockImplementation((repoPath: string, parentIssueNumber: number) =>
      Promise.resolve({
        repoPath,
        parentIssueNumber,
        parentTitle: `Epic ${parentIssueNumber}`,
        source: "native",
        children:
          parentIssueNumber === 10
            ? [childOf(11)]
            : [childOf(21, "First of B"), { ...childOf(22, "Second of B"), blockedBy: [21] }],
        warnings: [],
        run: { repoPath, parentIssueNumber, mode: "auto", status: "idle" },
      }),
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // A (#10) is the default-expanded epic; B's children aren't listed until B opens.
    await expect.poll(() => option("c:10:11")).not.toBeNull();
    await selectRow("e:20");
    expect(option("c:20:22")).toBeNull();

    const flow = page.getByRole("region", { name: m.epicflow_title() });
    await flow.getByRole("button", { name: /#22/ }).click();

    await expect.poll(() => option("c:20:22")?.getAttribute("aria-selected")).toBe("true");
    await expect
      .poll(() => document.querySelector(".issue-detail .epic-tag")?.textContent)
      .toBe(m.issuedetail_back_to_epic({ parent: 20 }));
    expect(document.querySelector(".issue-detail")?.textContent).toContain("Second of B");
  });

  it("a not-started child shows its standing in the epic, jumps back and starts anyway (#2622)", async () => {
    const onnewtask = vi.fn();
    seed([plain(20, { title: "Epic B" })], [summary(20)]);
    mockEpic.mockImplementation((repoPath: string, parentIssueNumber: number) =>
      Promise.resolve({
        repoPath,
        parentIssueNumber,
        parentTitle: `Epic ${parentIssueNumber}`,
        source: "native",
        children: [childOf(21, "First of B"), { ...childOf(22, "Second of B"), blockedBy: [21] }],
        warnings: [],
        run: { repoPath, parentIssueNumber, mode: "auto", status: "idle" },
      }),
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask });

    await selectRow("c:20:22");
    const region = () => document.querySelector<HTMLElement>(".issue-detail [data-child-run]");
    await expect
      .poll(() => region()?.textContent)
      .toContain(m.childrun_waiting_on({ deps: "#21" }));
    expect(region()!.textContent).toContain(m.childrun_step_needs());
    await expect
      .poll(() => document.querySelector(".issue-detail .md-body strong")?.textContent)
      .toBe("body");

    await page.getByRole("button", { name: m.childrun_start_anyway() }).click();
    expect(onnewtask).toHaveBeenCalledWith(
      expect.objectContaining({ number: 22, title: "Second of B", blockedBy: [21] }),
    );

    await page
      .getByRole("button", { name: m.issuedetail_back_to_epic_aria({ parent: 20 }) })
      .click();
    await expect.poll(() => option("e:20")?.getAttribute("aria-selected")).toBe("true");
    await expect.poll(() => document.querySelector("[data-epic-run]")).not.toBeNull();
  });

  it("mobile: the detail opens as a second level and Back returns to the list", async () => {
    seed([plain(42, { body: "**hi**" })]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, mobile: true });

    await expect.poll(() => option("s:42")).not.toBeNull();
    expect(document.querySelector(".detail-col")).toBeNull();
    await selectRow("s:42");
    await expect.poll(() => document.querySelector(".detail-col.overlay")).not.toBeNull();
    await expect.element(page.getByText("hi", { exact: true })).toBeInTheDocument();
    document.querySelector<HTMLButtonElement>(".back-btn")!.click();
    await expect.poll(() => document.querySelector(".detail-col")).toBeNull();
    expect(option("s:42")?.getAttribute("aria-selected")).toBe("false");
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

  it("renders the epic header's merged/total with one progress segment per child", async () => {
    seed([issue(10, "Parent issue")], [epic(10, 1, 3, "native")]);
    mockEpic.mockResolvedValue(liveEpic(10, ["merged", "running", "running"], "native"));
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => epicCount(10)).toBe("1/3");
    const segs = option("e:10")!.querySelectorAll(".seg");
    expect([...segs].map((el) => el.className.match(/seg-(\w+)/)?.[1])).toEqual([
      "done",
      "running",
      "running",
    ]);
  });

  it("falls back to the summary count for an epic whose record isn't loaded", async () => {
    seed(
      [issue(20, "First epic"), issue(21, "Second epic")],
      [epic(20, 0, 1, "markdown"), epic(21, 2, 4, "markdown")],
    );
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Only the first epic auto-expands (and fetches); the second shows its summary.
    await expect.poll(() => epicCount(21)).toBe("2/4");
    expect(option("e:21")!.querySelectorAll(".seg-done")).toHaveLength(2);
  });

  it("prefers the live epic's authoritative count over a stale markdown summary", async () => {
    // The list summary is markdown-first and goes stale after an epic is restructured
    // (e.g. "0/6"); the live/native record is authoritative ("3/6").
    seed([issue(60, "Epic parent")], [epic(60, 0, 6, "markdown")]); // stale summary → 0/6
    render(IssuesPanel, {
      repoPath: "/repo",
      onnewtask: noop,
      epics: {
        "/repo#60": liveEpic(60, ["merged", "merged", "merged", "running", "running", "running"]),
      },
    });

    await expect.poll(() => epicCount(60)).toBe("3/6");
  });

  it("offers the task box only for a single issue, never for an epic", async () => {
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
      seed([issue(30, "Epic parent"), issue(31, "Plain issue")], [epic(30, 1, 2, "markdown")]);
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, onquick: noop });

      await selectRow("e:30");
      await expect.poll(() => document.querySelector(".issue-detail")).not.toBeNull();
      expect(document.querySelector(".task-box")).toBeNull();
      expect(document.querySelector(".quick-btn")).toBeNull();

      await selectRow("s:31");
      await expect.poll(() => document.querySelector(".task-box")).not.toBeNull();
      const quick = document.querySelector<HTMLButtonElement>(".quick-btn")!;
      expect(quick.getAttribute("aria-label")).toBe(
        m.issuespanel_action_aria({ label: steer.label }),
      );
      expect(quick.getAttribute("title")).toBe(steer.text);
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
    await selectRow("s:70");

    const expectedText = m.issuerow_blocked_on({ deps: "#1642" });
    await expect.element(page.getByText(expectedText)).toBeInTheDocument();
    const chip = document.querySelector(".blocked-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent?.trim()).toBe(expectedText);
  });

  it("renders no blocked chip when the issue has no blockers", async () => {
    seed([issue(71, "Unblocked issue")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("s:71");

    await expect.poll(() => document.querySelector(".issue-detail")).toBeTruthy();
    expect(document.querySelector(".blocked-chip")).toBeNull();
  });

  it("does not render the standalone blocked chip on an epic-parent row", async () => {
    seed([issue(72, "Epic parent", [1642])], [epic(72, 1, 3, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("e:72");

    await expect.poll(() => document.querySelector(".issue-detail")).toBeTruthy();
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
    await selectRow("e:80");

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
    await selectRow("e:82");

    await expect.poll(() => document.querySelector(".others-pill")).toBeTruthy();
    expect(document.querySelector(".others-pill")!.textContent).toContain(
      m.issuerow_epic_authored_pill({ who: "scoop" }),
    );
  });

  it("renders no pill when the epic isn't flagged for others", async () => {
    seed([issue(81, "My own epic")], [epic(81, 0, 3, "markdown")]);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await selectRow("e:81");

    await expect.poll(() => document.querySelector(".issue-detail")).toBeTruthy();
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
    await expect.poll(() => document.querySelector(".epic-toggle")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
      .toBe("true");

    // The one-shot getEpic fetch fired for the target.
    expect(mockEpic).toHaveBeenCalledWith("/repo", 327);
  });

  // Cheap regression guard for the open-epic group container (#1808): the wrapper
  // only reads as one bounded unit while `epic-open` is on it. This asserts the hook
  // exists and tracks the toggle — it does NOT prove the visual result, which rests
  // on the design tokens and review.
  it("marks the epic row expanded only while the epic is expanded", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(327), issue(400)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(327)], subIssues: [] });
    mockEpic.mockResolvedValue(epic(327));

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, expandEpic: 327 });

    const row = () => option("e:327");
    await expect.poll(() => row()).toBeTruthy();

    // Expanded (auto-expand targeted it) — and the jump selected the epic, too.
    await expect.poll(() => row()?.classList.contains("expanded")).toBe(true);
    expect(row()?.getAttribute("aria-selected")).toBe("true");

    // Collapsed via the chevron: the row stays an (unexpanded) epic row.
    (document.querySelector(".epic-toggle") as HTMLButtonElement).click();
    await expect.poll(() => row()?.classList.contains("expanded")).toBe(false);
    expect(row()?.classList.contains("epic-row")).toBe(true);
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
    await expect.poll(() => document.querySelector(".epic-toggle")).toBeTruthy();
    await expect
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
      .toBe("true");

    // User clicks the badge to collapse it.
    (document.querySelector(".epic-toggle") as HTMLButtonElement).click();

    // It collapses and STAYS collapsed — the effect must not re-expand it.
    await expect
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
      .toBe("false");
    // Give the effect a chance to (incorrectly) re-fire; assert it stayed collapsed.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector(".epic-toggle")?.getAttribute("aria-expanded")).toBe("false");
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

    await expect.poll(() => document.querySelectorAll(".epic-toggle").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-toggle")];
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
    expect(document.querySelector(".epic-toggle")).toBeNull();
    expect(mockEpic).not.toHaveBeenCalled();

    resolveIssues({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(2), issue(1)],
      viewer: null,
    });

    await expect.poll(() => document.querySelectorAll(".epic-toggle").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-toggle")];
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

    await expect.poll(() => document.querySelectorAll(".epic-toggle").length).toBe(2);
    const badges = [...document.querySelectorAll(".epic-toggle")];
    await expect.poll(() => badges[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(badges[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(mockEpic).toHaveBeenCalledTimes(1);
    expect(mockEpic).toHaveBeenCalledWith("/repo", 2);
  });

  it("clicking an epic row selects it; only the chevron toggles expansion", async () => {
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
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
      .toBe("true");
    await selectRow("e:327");
    expect(document.querySelector(".epic-toggle")?.getAttribute("aria-expanded")).toBe("true");
    (document.querySelector(".epic-toggle") as HTMLButtonElement).click();
    await expect
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
      .toBe("false");
    // The selection (and its detail) survives the collapse.
    expect(option("e:327")?.getAttribute("aria-selected")).toBe("true");
    await expect.poll(() => document.querySelector(".issue-detail .epic")).not.toBeNull();
  });

  it("selecting a collapsed epic fetches its record for the detail", async () => {
    mockIssues.mockResolvedValue({
      slug: "acme/repo",
      webUrl: null,
      issues: [issue(1), issue(2)],
      viewer: null,
    });
    mockEpics.mockResolvedValue({ epics: [summary(1), summary(2)], subIssues: [] });

    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });
    await expect.poll(() => mockEpic.mock.calls.length).toBe(1); // default-expanded #1
    await selectRow("e:2");
    await expect.poll(() => mockEpic.mock.calls.length).toBe(2);
    expect(mockEpic).toHaveBeenLastCalledWith("/repo", 2);
    expect(option("e:2")?.classList.contains("expanded")).toBe(false);
    await expect.poll(() => document.querySelector(".issue-detail .epic")).not.toBeNull();
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
      expect(scrollCalls[0].firstRowId).toBe("issue-opt-e:327");
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

  // Assignee pill (#1694): shown per row only when the mine & unassigned filter isn't
  // hiding others' issues. `.assigned-pill` is distinct from EpicOthersPill's `.others-pill`;
  // `.framed` = "assigned to X" (viewer known), `.neutral` = plain listing (viewer unknown).
  const assignedPills = () => document.querySelectorAll(".assigned-pill");
  const framedPills = () => document.querySelectorAll(".assigned-pill.framed");
  const neutralPills = () => document.querySelectorAll(".assigned-pill.neutral");
  const pillText = (els: NodeListOf<Element>) => [...els].map((el) => el.textContent ?? "");

  it("shows no assignee pill while the mine & unassigned filter is active", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);
    // Filter on + viewer known → every visible issue is mine-or-unassigned, so the pill
    // would be redundant and is suppressed.
    expect(assignedPills().length).toBe(0);
  });

  it("reveals a framed 'assigned to X' pill for others' issues when the filter is toggled off", async () => {
    seedMixed("octocat");
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(2);

    openPopover();
    await expect.poll(() => checkboxByLabel(m.issues_filter_mine_label())).toBeTruthy();
    checkboxByLabel(m.issues_filter_mine_label())!.click();

    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    // The someone-else issue's detail is pilled; the viewer's own (octocat) shows none.
    await selectRow("s:3");
    await expect.poll(() => framedPills().length).toBe(1);
    expect(neutralPills().length).toBe(0);
    expect(pillText(framedPills())[0]).toContain("someone-else");
    await selectRow("s:2");
    await expect.poll(() => assignedPills().length).toBe(0);
  });

  it("lists assignees in neutral mode (no 'assigned to' framing) when the viewer is unknown", async () => {
    seedMixed(null);
    render(IssuesPanel, { repoPath: "/repo", onnewtask: noop });

    // Fail open on the FILTER (all 3 show), but the pill can't claim "others" without a
    // known viewer — it falls back to a neutral listing, preserving assignee visibility.
    await expect.poll(() => document.querySelectorAll(".issue-title").length).toBe(3);
    const texts: string[] = [];
    for (const key of ["s:2", "s:3"]) {
      await selectRow(key);
      await expect.poll(() => neutralPills().length).toBe(1);
      expect(framedPills().length).toBe(0);
      texts.push(...pillText(neutralPills()));
    }
    expect(texts.some((t) => t.includes("octocat"))).toBe(true);
    expect(texts.some((t) => t.includes("someone-else"))).toBe(true);
    // No "assigned to" framing in neutral mode.
    const framedCopy = m.issuerow_assigned_pill({ who: "someone-else" });
    expect(texts.every((t) => !t.includes(framedCopy))).toBe(true);
  });

  it("suppresses the assigned pill on a flagged epic (keeps EpicOthersPill, no task box)", async () => {
    const previousSteers = steers.list;
    steers.list = [{ id: "s1", label: "Go", text: "do it", inSteerBar: false, onIssues: true }];
    try {
      mockListIssues.mockResolvedValue({
        slug: "owner/repo",
        webUrl: null,
        viewer: "octocat",
        issues: [withAssignees(50, "Epic parent", ["someone-else"])],
      });
      mockGetEpics.mockResolvedValue({
        epics: [
          {
            parentIssueNumber: 50,
            parentTitle: "Epic parent",
            merged: 0,
            total: 3,
            status: "idle",
            source: "markdown",
            inFlight: 0,
            inFlightBy: [],
            assignedOthers: ["someone-else"],
            authoredByOther: null,
          },
        ],
        subIssues: [],
      });
      render(IssuesPanel, { repoPath: "/repo", onnewtask: noop, onquick: noop });

      // Filter ON (default) — the flagged epic stays visible via the #1616 exemption.
      await selectRow("e:50");
      await expect.poll(() => document.querySelector(".others-pill")).toBeTruthy();
      // No plain-issue pill on the epic — no double-pill — and no task box / quick launch.
      expect(document.querySelector(".assigned-pill")).toBeNull();
      expect(document.querySelector(".quick-btn")).toBeNull();
    } finally {
      steers.list = previousSteers;
    }
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

describe("IssuesPanel sub-issues live only in their epic (#2617)", () => {
  // The Issues tab ignores the shared "hide sub-issues" preference (PromptSources keeps it):
  // run with it OFF to prove the exclusion is unconditional here.
  beforeEach(() => {
    issuesFilter.set(true);
    issuesFilter.setActive(false);
    issuesFilter.setSubIssues(false);
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

  it("never lists a plain sub-issue as a single and keeps a mid-level epic as a group", async () => {
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
    await expect.poll(() => document.querySelector(".epic-toggle")).toBeTruthy();

    const issueTitles = () =>
      [...document.querySelectorAll(".issue-title")].map((el) => el.textContent?.trim());

    // Plain sub-issue (10) is hidden; mid-level epic (20) and ordinary (30) are visible
    await expect.poll(() => issueTitles()).not.toContain("Plain sub-issue");
    expect(issueTitles()).toContain("Mid-level epic");
    expect(issueTitles()).toContain("Ordinary issue");
    expect(option("e:20")).not.toBeNull();

    // …and the Filters popover no longer offers the (here meaningless) toggle.
    document.querySelector<HTMLButtonElement>(".filter-bar button")!.click();
    await expect
      .poll(() => document.querySelector("[popover] input[type=checkbox]"))
      .not.toBeNull();
    expect(document.querySelector("[popover]")?.textContent).not.toContain(
      m.issues_filter_subissues_label(),
    );
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

    // Header count + the selected epic's panel, both from the fetched Epic.
    await expect.poll(() => epicCount(50)).toBe("1/3");
    await expect
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
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

    // Header + panel both show the new counts…
    await expect.poll(() => epicCount(50)).toBe("2/3");
    await expect
      .element(page.getByText(m.epic_progress({ merged: 2, total: 3 })))
      .toBeInTheDocument();
    // …the expanded fetched-cache epic was re-pulled…
    expect(mockEpic).toHaveBeenCalledTimes(2);
    expect(mockEpic).toHaveBeenLastCalledWith("/repo", 50);
    // …and operator state survived: expansion + filter text intact (no hard reset).
    expect(document.querySelector(".epic-toggle")?.getAttribute("aria-expanded")).toBe("true");
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
      .poll(() => document.querySelector(".epic-toggle")?.getAttribute("aria-expanded"))
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
    expect(document.querySelector(".epic-toggle")?.getAttribute("aria-expanded")).toBe("true");
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
    await expect.poll(() => document.querySelector(".epic-toggle")).toBeTruthy();

    const badge = () => document.querySelector(".epic-toggle") as HTMLButtonElement;
    await expect.poll(() => mockEpic.mock.calls.length).toBe(1); // default expand → fetch #1
    badge().click(); // collapse while the fetch is still in flight

    // The late settle must NOT re-seed the cache for the collapsed panel…
    resolveFirst(makeEpic(70, ["ready"]));
    await new Promise((r) => setTimeout(r, 50));

    // …so re-expanding refetches instead of serving the discarded stale record.
    badge().click();
    await expect.poll(() => mockEpic.mock.calls.length).toBe(2);
    await expect.poll(() => epicCount(70)).toBe("1/1");
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
