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
    mergeTrainPrs: null,
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
    egressApplied: false,
    egressDegraded: false,
    research: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
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

describe("Herd Research filter", () => {
  it("clicking Research chip shows only research sessions and hides non-research ones", async () => {
    render(Herd, {
      ...base,
      sessions: [
        session({ id: "rs", name: "research one", research: true }),
        session({ id: "nr", name: "plain one", research: false }),
      ],
      git: {},
    });
    // both visible under All (default)
    await expect.element(page.getByText("research one")).toBeInTheDocument();
    await expect.element(page.getByText("plain one")).toBeInTheDocument();
    await page.getByRole("button", { name: "⬡ Research" }).click();
    await expect.element(page.getByText("research one")).toBeInTheDocument();
    await expect.element(page.getByText("plain one")).not.toBeInTheDocument();
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

describe("Herd Done filter", () => {
  it("clicking DONE clears any status filter (one filter at a time)", async () => {
    const onstatusfilter = vi.fn();
    render(Herd, {
      ...base,
      sessions: [session({ id: "live", name: "live one" })],
      git: {},
      onstatusfilter,
    });
    await page.getByRole("button", { name: "✓ Done" }).click();
    expect(onstatusfilter).toHaveBeenCalledWith(null);
  });

  it("done mode lists the doneList rows (not the live sessions) and fires ondoneselect", async () => {
    const ondoneselect = vi.fn();
    render(Herd, {
      ...base,
      // live session must NOT appear under the done lens
      sessions: [session({ id: "live", name: "live one" })],
      git: {},
      filter: "done" as const,
      doneList: [
        session({ id: "d1", desig: "TASK-77", name: "archived one", repoPath: "/repo/shepherd" }),
      ],
      ondoneselect,
    });
    await expect.element(page.getByText("TASK-77")).toBeInTheDocument();
    // repo basename rendered
    await expect.element(page.getByText("shepherd")).toBeInTheDocument();
    // live session hidden in done mode
    expect(page.getByText("live one").elements().length, "live row hidden under done").toBe(0);
    await page.getByText("TASK-77").click();
    expect(ondoneselect).toHaveBeenCalledWith("d1");
  });

  it("empty done list shows the done empty-state note", async () => {
    render(Herd, {
      ...base,
      sessions: [],
      git: {},
      filter: "done" as const,
      doneList: [],
    });
    await expect.element(page.getByText("No finished sessions yet.")).toBeInTheDocument();
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

describe("Herd epic-child preview badge", () => {
  // Regression guard: epic-child rows must pass withPreview=true so a live preview
  // port surfaces the Preview badge. If HerdEpicGroups were to pass withPreview=false
  // the badge would silently disappear for grouped sessions.
  afterEach(() => {
    // no module-singleton state to clean up for this test
  });

  it("renders the Preview badge for an epic-grouped child session with a live preview port", async () => {
    const epicChild = (number: number): import("$lib/types").EpicChild => ({
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
    const epic = (children: import("$lib/types").EpicChild[]): import("$lib/types").Epic => ({
      repoPath: "/repo/a",
      parentIssueNumber: 100,
      parentTitle: "Big epic",
      source: "native",
      children,
      warnings: [],
      run: { repoPath: "/repo/a", parentIssueNumber: 100, mode: "auto", status: "running" },
    });
    const epics = { "/repo/a#100": epic([epicChild(11)]) };
    const activeEpicKeys = new Set(["/repo/a#100"]);

    render(Herd, {
      ...base,
      sessions: [session({ id: "eg1", name: "epic grouped session", issueNumber: 11 })],
      git: {},
      epics,
      activeEpicKeys,
      // live preview port on the epic-grouped session
      preview: { eg1: 5173 },
      previewServe: { eg1: "ok" as const },
      onpreview: vi.fn(),
    });

    // The .preview-badge span renders "Preview" when previewPort is non-null.
    // This fails if HerdEpicGroups passes withPreview=false to HerdGroup.
    await expect.element(page.getByText("Preview")).toBeInTheDocument();
    // Confirm it's inside the epic-children rail (not some other badge)
    const rail = document.querySelector(".epic-children")!;
    expect(rail).not.toBeNull();
    expect(rail.textContent).toContain("Preview");
  });
});

describe("Herd reviewer-running preview badge", () => {
  // reviews is a module singleton — clear after each test
  afterEach(() => {
    reviews.setReviewing("rv", false);
  });

  it("renders the Preview badge for a critic-reviewing session that has a live preview port", async () => {
    // A session in the reviewer-running bucket (inReview=true) with a live preview
    // port. The reviewerRunning partition has withPreview=true — if it were false the
    // previewPort would be coerced to null and the badge would not render, breaking
    // the preview UX for sessions under critic review.
    reviews.setReviewing("rv", true);
    render(Herd, {
      ...base,
      sessions: [session({ id: "rv", name: "critic session", status: "idle" })],
      git: { rv: openPr },
      preview: { rv: 5173 },
      previewServe: { rv: "ok" as const },
      onpreview: vi.fn(),
    });
    // The .preview-badge span renders the text "Preview" when previewPort is non-null
    await expect.element(page.getByText("Preview")).toBeInTheDocument();
  });
});
