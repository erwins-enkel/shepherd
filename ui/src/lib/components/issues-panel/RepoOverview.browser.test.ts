import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import RepoOverview from "./RepoOverview.svelte";
import type { DrainStatus, Epic, EpicSummary, Issue } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const B = 20;
const A = 10;

function summaryOf(n: number, merged: number, total: number): EpicSummary {
  return {
    parentIssueNumber: n,
    parentTitle: `Epic ${n}`,
    merged,
    total,
    status: "idle",
    source: "native",
  };
}

function issue(n: number): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "",
    url: "u",
    labels: [],
    createdAt: 0,
    assignees: [],
  };
}

// B (#20) leads with #21 next, A (#10) winds down with #11 in flight.
function drain(): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 1,
    inFlight: 1,
    max: 2,
    epicParent: B,
    runSummary: {
      leadingEpic: B,
      windingDown: [{ epic: A, inFlight: [11] }],
      slots: {
        used: 1,
        max: 2,
        holders: [{ sessionId: "s11", desig: "TASK-11", issueNumber: 11, epicParent: A }],
      },
      next: [21],
      after: [],
    },
  };
}

function leading(): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: B,
    parentTitle: "Epic 20",
    source: "native",
    children: [
      {
        number: 21,
        title: "First of B",
        url: "u",
        order: 0,
        body: "",
        blockedBy: [],
        state: "ready",
        sessionId: null,
        prNumber: null,
        issueClosed: false,
        claimed: false,
      },
    ],
    warnings: [],
    run: { repoPath: "/repo", parentIssueNumber: B, mode: "auto", status: "running" },
  };
}

const titleFor = (n: number) => (n === 21 ? "First of B" : null);
// The #2638 sections, empty: a repo with no running work, no labels and no open issues.
const quiet = {
  repoPath: "/repo",
  running: [],
  labels: [],
  labelColors: {},
  stale: { stale: 0, total: 0, oldest: null },
  oldestFirst: false,
  onfilterlabel: vi.fn(),
  ontoggleoldest: vi.fn(),
};
const root = () => document.querySelector<HTMLElement>(".overview")!;
const run = () => root().querySelector<HTMLElement>("[data-repo-run]")!;

describe("RepoOverview (#2622)", () => {
  it("names the repo, the leading epic's state and steps, winding epics and the slot hint", async () => {
    const onopenautomation = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2)],
      ...quiet,
      drain: drain(),
      leadingRecord: leading(),
      titleFor,
      onselect: vi.fn(),
      onopenautomation,
    });
    expect(root().querySelector("h2")?.textContent).toBe(
      m.repooverview_title({ repo: "shepherd" }),
    );
    expect(run().querySelector(".run-state")?.textContent).toContain(
      m.repooverview_leading({ epic: B, state: m.epic_run_state_running() }),
    );
    expect(run().textContent).toContain("#21 First of B");
    expect(run().textContent).toContain(m.repooverview_winding({ epic: A, inflight: "#11" }));
    expect(run().textContent).toContain(m.repooverview_hint());
    [...run().querySelectorAll("button")]
      .find((b) => b.textContent?.includes(m.repooverview_change_slots()))!
      .click();
    expect(onopenautomation).toHaveBeenCalledOnce();
  });

  it("lists epics with role and progress (leading first) and selects on click", async () => {
    const onselect = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2), summaryOf(30, 2, 2)],
      ...quiet,
      drain: drain(),
      titleFor,
      onselect,
    });
    const cards = [...root().querySelectorAll<HTMLButtonElement>(".card")];
    expect(cards.map((c) => c.querySelector(".num")?.textContent)).toEqual(["#20", "#10", "#30"]);
    expect(cards[0].textContent).toContain(m.epic_role_leading());
    expect(cards[1].textContent).toContain(m.epic_role_winding());
    expect(cards[1].textContent).toContain(m.repooverview_progress({ merged: 1, total: 3 }));
    cards[2].click();
    expect(onselect).toHaveBeenCalledWith("e:30");
  });

  it("without a leading epic says so, lists no issues and offers the next steps (#2638)", async () => {
    const ondraftepic = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [],
      ...quiet,
      titleFor,
      onselect: vi.fn(),
      ondraftepic,
    });
    expect(run().querySelector(".run-state")?.textContent).toContain(m.repooverview_none_leading());
    // The list beside it already lists the issues — no second list here.
    expect(root().textContent).not.toContain(m.issuespanel_singles_heading());
    expect(root().querySelector(".facts")).toBeNull();
    expect(root().textContent).toContain(m.repooverview_next_single_title());
    [...root().querySelectorAll("button")]
      .find((b) => b.textContent === m.repooverview_draft_epic())!
      .click();
    expect(ondraftepic).toHaveBeenCalledOnce();
  });

  it("names running issues — also ones the list hides — and opens their session (#2638)", async () => {
    const onopensession = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [],
      ...quiet,
      running: [
        { issue: issue(160), sessionId: "s160", desig: "TASK-160", hidden: true },
        { issue: issue(7), sessionId: null, desig: null, hidden: false },
      ],
      titleFor,
      onselect: vi.fn(),
      onopensession,
    });
    const rows = [...root().querySelectorAll<HTMLElement>(".run-row")];
    expect(root().textContent).toContain(m.repooverview_running({ count: 2 }));
    expect(rows[0].textContent).toContain("#160 Issue 160");
    expect(rows[0].textContent).toContain(`TASK-160 · ${m.repooverview_running_hidden()}`);
    expect(rows[1].textContent).toContain(m.repooverview_running_label_only());
    expect(rows[1].querySelector("button")).toBeNull();
    rows[0].querySelector("button")!.click();
    expect(onopensession).toHaveBeenCalledWith("s160");
  });

  it("labels filter the list; the stale share names the oldest and sorts oldest first (#2638)", async () => {
    const onfilterlabel = vi.fn();
    const ontoggleoldest = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [],
      ...quiet,
      labels: [
        { label: "bug", count: 3 },
        { label: "docs", count: 1 },
      ],
      labelColors: { bug: "#d73a4a" },
      stale: { stale: 2, total: 3, oldest: { issue: issue(3), days: 152 } },
      oldestFirst: true,
      onfilterlabel,
      ontoggleoldest,
      titleFor,
      onselect: vi.fn(),
    });
    const labels = [...root().querySelectorAll<HTMLButtonElement>(".label-row")];
    expect(labels.map((l) => l.textContent?.replace(/\s+/g, ""))).toEqual(["bug3", "docs1"]);
    expect(labels[0].classList.contains("hued")).toBe(true);
    labels[1].click();
    expect(onfilterlabel).toHaveBeenCalledWith("docs");

    expect(root().textContent).toContain(
      m.repooverview_stale_count({ stale: 2, total: 3, days: 90 }),
    );
    expect(root().textContent).toContain(
      m.repooverview_oldest({ number: 3, title: "Issue 3", days: 152 }),
    );
    const oldest = root().querySelector<HTMLButtonElement>(".oldest")!;
    expect(oldest.getAttribute("aria-pressed")).toBe("true");
    oldest.click();
    expect(ontoggleoldest).toHaveBeenCalledOnce();
  });
});
