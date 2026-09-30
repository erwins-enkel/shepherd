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
const root = () => document.querySelector<HTMLElement>(".overview")!;
const run = () => root().querySelector<HTMLElement>("[data-repo-run]")!;

describe("RepoOverview (#2622)", () => {
  it("names the repo, the leading epic's state and steps, winding epics and the slot hint", async () => {
    const onopenautomation = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2)],
      singles: [],
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
      singles: [],
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

  it("without a leading epic says so and caps the single issues", async () => {
    const onselect = vi.fn();
    render(RepoOverview, {
      repoName: "shepherd",
      epics: [],
      singles: [1, 2, 3, 4, 5, 6, 7].map(issue),
      titleFor,
      onselect,
    });
    expect(run().querySelector(".run-state")?.textContent).toContain(m.repooverview_none_leading());
    expect(root().querySelectorAll(".single")).toHaveLength(5);
    expect(root().textContent).toContain(m.repooverview_more({ count: 2 }));
    root().querySelector<HTMLButtonElement>(".single")!.click();
    expect(onselect).toHaveBeenCalledWith("s:1");
  });
});
