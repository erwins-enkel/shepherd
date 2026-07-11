import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import Herd from "./Herd.svelte";
import { railOrder } from "./herd-keynav";
import { isReworkRunning } from "./rework-running";
import { reviews, planGates } from "$lib/reviews.svelte";
import { postMergeSteps } from "$lib/post-merge-steps.svelte";
import type { Session, GitState, Epic, EpicChild, PostMergeSteps, ReviewVerdict } from "$lib/types";

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
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
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

function changesReview(sessionId: string): ReviewVerdict {
  return {
    sessionId,
    headSha: "abc",
    decision: "changes_requested",
    summary: "changes",
    body: "body",
    findings: ["fix it"],
    addressRound: 1,
    addressCap: 3,
    finalRoundPending: false,
    finalRoundTimeoutMs: 0,
    updatedAt: 0,
  };
}

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
    await page.getByRole("button", { name: "Ready", exact: true }).click();
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
    await page.getByRole("button", { name: "Ready", exact: true }).click();
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
    await page.getByRole("button", { name: "Ready", exact: true }).click();
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
    await page.getByRole("button", { name: "Ready", exact: true }).click();
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
    await page.getByRole("button", { name: "Ready", exact: true }).click();
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
    await page.getByRole("button", { name: "Done", exact: true }).click();
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

describe("Herd owed lens respects the repo filter (#owed)", () => {
  const owedRecord = (sessionId: string, desig: string, repoPath: string): PostMergeSteps => ({
    sessionId,
    desig,
    repoPath,
    prNumber: 1,
    prTitle: "t",
    steps: [{ id: "ms1", text: "do it", postMerge: false, doneAt: null }],
    trackingIssueUrl: null,
    trackingIssueNumber: null,
    createdAt: 0,
    updatedAt: 0,
    clearedAt: null,
  });

  afterEach(() => {
    postMergeSteps.records = [];
  });

  it("scopes the panel list AND the lens-strip badge count to repoFilter (real Herd→panel wiring)", async () => {
    postMergeSteps.records = [
      owedRecord("s1", "TASK-IN", "/repo/shepherd"),
      owedRecord("s2", "TASK-OUT", "/repo/other"),
      owedRecord("s3", "TASK-IN2", "/repo/shepherd"),
    ];
    const screen = await render(Herd, {
      ...base,
      sessions: [],
      git: {},
      filter: "owed" as const,
      repoFilter: new Set(["/repo/shepherd"]),
    });
    // panel list: only the active repo's records render
    await expect.element(page.getByText("TASK-IN", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("TASK-IN2", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("TASK-OUT", { exact: true })).not.toBeInTheDocument();
    // badge count reflects the filtered set (2 of the 3 records), proving Herd's owedCount is scoped
    await expect
      .poll(() => screen.container.querySelector(".owed-badge")?.textContent?.trim())
      .toBe("2");
  });

  it("unfiltered (empty repoFilter) lists every record and the badge shows the total", async () => {
    postMergeSteps.records = [
      owedRecord("s1", "TASK-IN", "/repo/shepherd"),
      owedRecord("s2", "TASK-OUT", "/repo/other"),
    ];
    const screen = await render(Herd, {
      ...base,
      sessions: [],
      git: {},
      filter: "owed" as const,
      repoFilter: new Set<string>(),
    });
    await expect.element(page.getByText("TASK-IN")).toBeInTheDocument();
    await expect.element(page.getByText("TASK-OUT")).toBeInTheDocument();
    await expect
      .poll(() => screen.container.querySelector(".owed-badge")?.textContent?.trim())
      .toBe("2");
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

  it("reports the rendered epic group order after experiment grouping removes raw earlier epics", async () => {
    const onrenderedepicgroups = vi.fn();
    const renderedEpics = {
      "/repo/a#100": epic([epicChild(11), epicChild(12)]),
      "/repo/a#200": {
        ...epic([epicChild(21)]),
        parentIssueNumber: 200,
        parentTitle: "Later epic",
        run: { repoPath: "/repo/a", parentIssueNumber: 200, mode: "auto", status: "running" },
      } satisfies Epic,
    };
    render(Herd, {
      ...base,
      sessions: [
        session({
          id: "a1",
          name: "experiment original",
          issueNumber: 11,
          experimentId: "exp",
          experimentRole: "variant",
          createdAt: 1,
        }),
        session({
          id: "a2",
          name: "experiment variant",
          issueNumber: 12,
          experimentId: "exp",
          experimentRole: "variant",
          createdAt: 2,
        }),
        session({ id: "b1", name: "rendered epic child", issueNumber: 21 }),
      ],
      git: {},
      epics: renderedEpics,
      activeEpicKeys: new Set(["/repo/a#100", "/repo/a#200"]),
      onrenderedepicgroups,
    });

    await expect.element(page.getByText("Later epic")).toBeInTheDocument();
    await expect.poll(() => onrenderedepicgroups.mock.calls.at(-1)?.[0]).toEqual(["/repo/a#200"]);
    expect(document.body.textContent).not.toContain("Big epic");
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
    await expect
      .element(page.getByRole("button", { name: "Decommission all" }))
      .toBeInTheDocument();
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

describe("Herd rework-running group", () => {
  afterEach(() => {
    reviews.setReviewing("review", false);
    reviews.drop("rework");
  });

  it("renders in the same order as railOrder, including working-while-blocked REWORK", async () => {
    const sessions = [
      session({ id: "wait", name: "waiting reviewer", status: "idle" }),
      session({ id: "rework", name: "rework active", status: "blocked" }),
      session({ id: "review", name: "review active", status: "running" }),
      session({ id: "ci", name: "ci active", status: "running" }),
      session({ id: "active", name: "plain active", status: "running" }),
    ];
    const git = {
      wait: {
        kind: "github",
        state: "open",
        checks: "success",
        deployConfigured: false,
        handoff: "reviewer",
        handoffWho: "scoop",
      },
      ci: {
        kind: "github",
        state: "open",
        checks: "pending",
        deployConfigured: false,
      },
      rework: {
        kind: "github",
        state: "open",
        checks: "failure",
        deployConfigured: false,
      },
    } satisfies Record<string, GitState>;
    const workingBlocked = { rework: true };
    reviews.setReviewing("review", true);
    reviews.apply({ id: "rework", review: changesReview("rework") });

    render(Herd, {
      ...base,
      sessions,
      git,
      workingBlocked,
    });

    await expect.element(page.getByText(/Rework running \(1\)/i)).toBeInTheDocument();
    const rendered = [...document.querySelectorAll<HTMLElement>("[data-unit-id]")].map(
      (el) => el.dataset.unitId,
    );
    const ordered = railOrder(
      sessions,
      git,
      (id) => reviews.isReviewing(id) || planGates.isReviewing(id),
      (s) =>
        isReworkRunning(
          s,
          { planGate: planGates.map[s.id], review: reviews.map[s.id] },
          workingBlocked,
          Date.now(),
        ),
      0,
      "all",
      workingBlocked,
    );

    expect(rendered).toEqual(ordered);
    expect(rendered).toEqual(["active", "ci", "review", "rework", "wait"]);
  });
});
