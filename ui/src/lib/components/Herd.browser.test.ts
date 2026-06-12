import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import Herd from "./Herd.svelte";
import { reviews, planGates } from "$lib/reviews.svelte";
import type { Session, GitState, Epic, EpicChild } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...partial,
  };
}

const openPr: GitState = {
  kind: "github",
  state: "open",
  number: 42,
  url: "https://github.com/acme/shepherd/pull/42",
  title: "feat: ready thing",
  mergeable: true,
  checks: "success",
  deployConfigured: false,
};

const base = {
  selectedId: null,
  nowMs: 0,
  onselect: () => {},
  onnew: () => {},
  activity: {},
};

describe("Herd merging group", () => {
  it("renders a Merging group for in-train sessions", async () => {
    const merging = session({
      id: "m1",
      readyToMerge: true,
      mergingSince: Date.now(),
      mergingTrainId: "t",
    });
    render(Herd, {
      ...base,
      sessions: [merging],
      git: {
        m1: {
          kind: "github",
          state: "open",
          checks: "success",
          deployConfigured: false,
        } as GitState,
      },
    });
    await expect.element(page.getByText(/Merging \(1\)/i)).toBeInTheDocument();
  });

  it("orders the section heads ready → merging → merged top→bottom", async () => {
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "rdy", readyToMerge: true }),
        session({
          id: "mrg",
          readyToMerge: true,
          mergingSince: Date.now(),
          mergingTrainId: "t",
        }),
        session({ id: "mgd" }),
      ],
      git: {
        rdy: openPr,
        mrg: { kind: "github", state: "open", checks: "success", deployConfigured: false },
        mgd: { kind: "github", state: "merged", checks: "success", deployConfigured: false },
      },
    });
    // all three heads present
    await expect.element(page.getByText(/Ready to merge \(1\)/i)).toBeInTheDocument();
    await expect.element(page.getByText(/Merging \(1\)/i)).toBeInTheDocument();
    await expect.element(page.getByText(/Merged \(1\)/i)).toBeInTheDocument();
    // compare document positions: ready before merging before merged
    const ready = document.querySelector(".ready-head")!;
    const merging = document.querySelector(".merging-head")!;
    const merged = document.querySelector(".merged-head")!;
    expect(ready.compareDocumentPosition(merging) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(merging.compareDocumentPosition(merged) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Herd merge-train link", () => {
  it("shows the Merge train link when a ready-to-merge session has an open PR", async () => {
    render(Herd, {
      ...base,
      sessions: [session({ id: "a", readyToMerge: true })],
      git: { a: openPr },
      onmergetrain: () => {},
    });
    await expect.element(page.getByRole("button", { name: "Merge train" })).toBeInTheDocument();
  });

  it("fires onmergetrain when the link is clicked", async () => {
    const onmergetrain = vi.fn();
    render(Herd, {
      ...base,
      sessions: [session({ id: "a", readyToMerge: true })],
      git: { a: openPr },
      onmergetrain,
    });
    await page.getByRole("button", { name: "Merge train" }).click();
    expect(onmergetrain).toHaveBeenCalledOnce();
  });

  it("hides the link when no ready-to-merge session has an open PR", async () => {
    render(Herd, {
      ...base,
      // ready-to-merge but no PR in git → nothing to run
      sessions: [session({ id: "a", readyToMerge: true })],
      git: {},
      onmergetrain: () => {},
    });
    await expect.element(page.getByRole("button", { name: "Merge train" })).not.toBeInTheDocument();
  });

  it("hides the link when onmergetrain is not provided", async () => {
    render(Herd, {
      ...base,
      sessions: [session({ id: "a", readyToMerge: true })],
      git: { a: openPr },
    });
    await expect.element(page.getByRole("button", { name: "Merge train" })).not.toBeInTheDocument();
  });
});

describe("Herd Ready filter", () => {
  // reviews/planGates are module singletons — clear any state set per test so it
  // doesn't bleed into the next one.
  afterEach(() => {
    reviews.setReviewing("rev", false);
    planGates.applyReviewing("pg", false);
    reviews.setReviewing("rm", false);
    reviews.setReviewing("only", false);
  });

  it("hides a critic-reviewing session under Ready but keeps a plain idle one", async () => {
    reviews.setReviewing("rev", true);
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "rev", name: "reviewing one" }),
        session({ id: "idle", name: "idle one" }),
      ],
      git: {},
    });
    // both visible under All (default)
    await expect.element(page.getByText("reviewing one")).toBeInTheDocument();
    await expect.element(page.getByText("idle one")).toBeInTheDocument();
    await page.getByRole("button", { name: "▤ Ready" }).click();
    await expect.element(page.getByText("idle one")).toBeInTheDocument();
    await expect.element(page.getByText("reviewing one")).not.toBeInTheDocument();
  });

  it("hides a plan-gate-reviewing session under Ready", async () => {
    planGates.applyReviewing("pg", true);
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "pg", name: "plan gate one" }),
        session({ id: "idle", name: "idle one" }),
      ],
      git: {},
    });
    await page.getByRole("button", { name: "▤ Ready" }).click();
    await expect.element(page.getByText("idle one")).toBeInTheDocument();
    await expect.element(page.getByText("plan gate one")).not.toBeInTheDocument();
  });

  it("hides a readyToMerge + in-review session under Ready", async () => {
    reviews.setReviewing("rm", true);
    render(Herd, {
      ...base,
      sessions: [session({ id: "rm", name: "ready merging", readyToMerge: true })],
      git: { rm: openPr },
    });
    await page.getByRole("button", { name: "▤ Ready" }).click();
    await expect.element(page.getByText("ready merging")).not.toBeInTheDocument();
  });

  it("drops the Merge train link when the only ready+open-PR session is in review", async () => {
    reviews.setReviewing("only", true);
    render(Herd, {
      ...base,
      sessions: [session({ id: "only", name: "only one", readyToMerge: true })],
      git: { only: openPr },
      onmergetrain: () => {},
    });
    await expect.element(page.getByRole("button", { name: "Merge train" })).not.toBeInTheDocument();
  });

  it("keeps a plain idle non-review session visible under Ready", async () => {
    render(Herd, {
      ...base,
      sessions: [session({ id: "plain", name: "plain idle" })],
      git: {},
    });
    await page.getByRole("button", { name: "▤ Ready" }).click();
    await expect.element(page.getByText("plain idle")).toBeInTheDocument();
  });
});

describe("Herd status filter (TopBar tallies)", () => {
  it("short-circuits the local Ready filter: running sessions stay visible", async () => {
    // statusFilter=running + local filter flipped to Ready would yield an empty
    // list if the ready branch still ran (it drops running sessions) — the
    // status filter must short-circuit it entirely.
    const onstatusfilter = vi.fn();
    render(Herd, {
      ...base,
      sessions: [session({ id: "r", name: "busy one", status: "running" })],
      git: {},
      statusFilter: "running" as const,
      onstatusfilter,
    });
    await page.getByRole("button", { name: "▤ Ready" }).click();
    // the click also asks the parent to clear the status filter (one filter at a time)
    expect(onstatusfilter).toHaveBeenCalledWith(null);
    // prop is still set (parent not wired in this render) → short-circuit keeps the row
    await expect.element(page.getByText("busy one")).toBeInTheDocument();
  });

  it("shows the active status as a chip; clicking it clears the filter", async () => {
    const onstatusfilter = vi.fn();
    render(Herd, {
      ...base,
      sessions: [session({ id: "r", name: "busy one", status: "running" })],
      git: {},
      statusFilter: "running" as const,
      onstatusfilter,
    });
    // accessible name = aria-label (status + clear action), not the visible "Busy ✕"
    const chip = page.getByRole("button", { name: "Busy filter active; show all sessions" });
    await expect.element(chip).toBeInTheDocument();
    await expect.element(chip).toHaveAttribute("aria-pressed", "true");
    await chip.click();
    expect(onstatusfilter).toHaveBeenCalledWith(null);
  });

  it("empty status result shows the status-named note, not the EmptyHerd nudge", async () => {
    // page-level filtering means an empty status result arrives as sessions=[] —
    // it must outrank the first-run EmptyHerd branch.
    render(Herd, {
      ...base,
      sessions: [],
      git: {},
      statusFilter: "idle" as const,
      onstatusfilter: () => {},
    });
    await expect.element(page.getByText("No Idle sessions right now.")).toBeInTheDocument();
    await expect.element(page.getByText("Mission control, no units")).not.toBeInTheDocument();
  });

  it("combined repo + status empty names both filters", async () => {
    render(Herd, {
      ...base,
      sessions: [],
      git: {},
      filteredRepo: "shepherd",
      statusFilter: "blocked" as const,
      onstatusfilter: () => {},
    });
    await expect.element(page.getByText("No Blocked sessions for shepherd.")).toBeInTheDocument();
  });
});

describe("Herd epic grouping", () => {
  const epicChild = (number: number): EpicChild => ({
    number,
    title: `child ${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy: [],
    state: "running",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  });

  const epic = (children: EpicChild[]): Epic => ({
    repoPath: "/repo/a",
    parentIssueNumber: 100,
    parentTitle: "Big epic",
    source: "native",
    children,
    warnings: [],
    run: { repoPath: "/repo/a", parentIssueNumber: 100, mode: "auto", status: "running" },
  });

  const epics = { "/repo/a#100": epic([epicChild(11), epicChild(12)]) };
  const activeEpicKeys = new Set(["/repo/a#100"]);

  it("renders an epic group header with its children, and non-epic sessions stay in lifecycle sections", async () => {
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "g1", name: "grouped one", issueNumber: 11 }),
        session({ id: "g2", name: "grouped two", issueNumber: 12 }),
        session({ id: "n1", name: "plain non-epic", issueNumber: 999 }),
      ],
      git: {},
      epics,
      activeEpicKeys,
    });
    // group header present
    await expect.element(page.getByText("Big epic")).toBeInTheDocument();
    // children render under the group rail
    const rail = document.querySelector(".epic-children")!;
    expect(rail.textContent).toContain("grouped one");
    expect(rail.textContent).toContain("grouped two");
    // the non-epic session renders, but NOT inside the group rail
    await expect.element(page.getByText("plain non-epic")).toBeInTheDocument();
    expect(rail.textContent).not.toContain("plain non-epic");
  });

  it("collapse hides children but keeps the header + cue chips; toggle fires with the group key", async () => {
    const oncollapsetoggle = vi.fn();
    render(Herd, {
      ...base,
      // an open+failed-CI child gives the group a cue chip
      sessions: [session({ id: "g1", name: "grouped one", issueNumber: 11 })],
      git: {
        g1: {
          kind: "github",
          state: "open",
          checks: "failure",
          deployConfigured: false,
        } as GitState,
      },
      epics,
      activeEpicKeys,
      collapsedKeys: new Set(["/repo/a#100"]),
      oncollapsetoggle,
    });
    // header still rendered
    await expect.element(page.getByText("Big epic")).toBeInTheDocument();
    // cue chip (ci-failed) survives collapse
    expect(document.querySelector(".cue-ci")).not.toBeNull();
    // children hidden
    expect(document.querySelector(".epic-children")).toBeNull();
    await expect.element(page.getByText("grouped one")).not.toBeInTheDocument();
    // toggling the header calls back with the group key
    const toggle = document.querySelector(".epic-toggle") as HTMLButtonElement;
    toggle.click();
    expect(oncollapsetoggle).toHaveBeenCalledWith("/repo/a#100");
  });

  it("keeps the merge-train action when the only ready PR session is an epic child", async () => {
    render(Herd, {
      ...base,
      // ready-to-merge + open PR, but it's an epic child → grouped, not in rest
      sessions: [session({ id: "g1", name: "grouped ready", issueNumber: 11, readyToMerge: true })],
      git: { g1: openPr },
      epics,
      activeEpicKeys,
      onmergetrain: () => {},
    });
    await expect.element(page.getByRole("button", { name: "Merge train" })).toBeInTheDocument();
    // the ready head renders for the action, annotated with the grouped count
    await expect.element(page.getByText("1 in epics above")).toBeInTheDocument();
  });

  it("keeps clear-merged when the only merged row is an epic child", async () => {
    render(Herd, {
      ...base,
      sessions: [session({ id: "g1", name: "grouped merged", issueNumber: 11 })],
      git: {
        g1: {
          kind: "github",
          state: "merged",
          checks: "success",
          deployConfigured: false,
        } as GitState,
      },
      epics,
      activeEpicKeys,
      onclearmerged: () => {},
    });
    await expect.element(page.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    await expect.element(page.getByText("1 in epics above")).toBeInTheDocument();
  });

  it("shows a split count when ready rows are both local and grouped", async () => {
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "g1", name: "grouped ready", issueNumber: 11, readyToMerge: true }),
        session({ id: "n1", name: "loose ready", issueNumber: 999, readyToMerge: true }),
      ],
      git: { g1: openPr, n1: openPr },
      epics,
      activeEpicKeys,
      onmergetrain: () => {},
    });
    // local count fragment + the grouped annotation both present
    await expect.element(page.getByText("Ready to merge (1)")).toBeInTheDocument();
    await expect.element(page.getByText("1 in epics above")).toBeInTheDocument();
  });
});
