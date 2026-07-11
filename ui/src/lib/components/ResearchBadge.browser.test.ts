import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";

const { default: ResearchBadge } = await import("./ResearchBadge.svelte");

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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ResearchBadge", () => {
  it("renders the badge with label text when session.research is true", async () => {
    render(ResearchBadge, { session: session({ id: "r1", research: true }) });
    const badge = document.querySelector(".research-badge");
    expect(badge, "research-badge rendered").not.toBeNull();
    await expect.element(page.getByText(/Research/i)).toBeInTheDocument();
  });

  it("renders nothing when session.research is false", async () => {
    render(ResearchBadge, { session: session({ id: "r2", research: false }) });
    const badge = document.querySelector(".research-badge");
    expect(badge, "no research-badge when research is false").toBeNull();
  });
});
