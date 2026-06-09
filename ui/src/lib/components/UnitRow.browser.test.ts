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

describe("UnitRow preview badge", () => {
  // The badge text bubbles into the row button's accessible name too, so match the
  // badge precisely by its title attribute rather than the ambiguous role+name.
  it("renders the Preview badge only when a preview port is bound", async () => {
    render(UnitRow, {
      session: session({ id: "p1" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8001,
    });
    await expect.element(page.getByTitle("Preview")).toBeInTheDocument();
  });

  it("omits the Preview badge when no preview port is bound", async () => {
    render(UnitRow, {
      session: session({ id: "p2" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: null,
    });
    await expect.element(page.getByTitle("Preview")).not.toBeInTheDocument();
  });

  it("clicking the badge calls onpreview with the session id (not onselect twice)", async () => {
    let previewed: string | null = null;
    let selects = 0;
    render(UnitRow, {
      session: session({ id: "p3" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => selects++,
      previewPort: 8002,
      onpreview: (id: string) => (previewed = id),
    });
    await page.getByTitle("Preview").click();
    expect(previewed).toBe("p3");
    // the badge stops propagation, so the row's own select doesn't also fire
    expect(selects).toBe(0);
  });
});
