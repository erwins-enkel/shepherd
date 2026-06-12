import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import Herd from "./Herd.svelte";
import { reviews, planGates } from "$lib/reviews.svelte";
import type { Session, GitState } from "$lib/types";

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
