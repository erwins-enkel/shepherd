import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import UnitRow from "./UnitRow.svelte";
import type { Session } from "$lib/types";

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

describe("UnitRow merging badge", () => {
  it("shows MERGING for a merging session, not READY", async () => {
    const now = Date.now();
    render(UnitRow, {
      session: session({
        id: "a",
        readyToMerge: true,
        mergingSince: now - 1000,
        mergingTrainId: "t",
      }),
      selected: false,
      nowMs: now,
      onselect: () => {},
    });
    await expect.element(page.getByText("MERGING")).toBeInTheDocument();
    await expect.element(page.getByText("READY")).not.toBeInTheDocument();
  });

  it("shows READY for a ready-to-merge session that is not merging", async () => {
    render(UnitRow, {
      session: session({ id: "b", readyToMerge: true }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText("READY")).toBeInTheDocument();
    await expect.element(page.getByText("MERGING")).not.toBeInTheDocument();
  });
});
