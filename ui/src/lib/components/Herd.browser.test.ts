import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import Herd from "./Herd.svelte";
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
