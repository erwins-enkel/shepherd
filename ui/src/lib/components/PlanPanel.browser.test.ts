import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import PlanPanel from "./PlanPanel.svelte";
import type { Session } from "$lib/types";

// Mock api so the panel's release/review calls never hit the network, keeping the
// rest of the module intact (the reviews store imports other api exports).
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    releasePlanGate: vi.fn(async () => {}),
    reviewPlan: vi.fn(async () => "skipped"),
  };
});

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
    planPhase: "planning",
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
    ...partial,
  };
}

afterEach(() => {
  // The overlay is portaled to <body>, outside the test container, so clean it up.
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
});

describe("PlanPanel portal", () => {
  // Regression guard: PlanPanel's fixed overlay must escape its mount subtree so
  // position:fixed resolves against the viewport, not UnitRow's transformed
  // `.slider`. The portal action re-parents it to <body>.
  it("portals the overlay to document.body, out of its own subtree", () => {
    render(PlanPanel, { props: { session: session({ id: "s1" }), onclose: vi.fn() } });

    const overlay = document.querySelector<HTMLElement>(".overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.parentElement).toBe(document.body);
  });
});
