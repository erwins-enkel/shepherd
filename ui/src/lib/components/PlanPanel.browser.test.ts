import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PlanPanel from "./PlanPanel.svelte";
import type { Session } from "$lib/types";
import { planGates } from "$lib/reviews.svelte";

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
    mergeTrainPrs: null,
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
    haltReason: null,
    haltedAt: null,
    ...partial,
  };
}

afterEach(() => {
  // The overlay is portaled to <body>, outside the test container, so clean it up.
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
  // Clean up any seeded plan gate entries.
  planGates.map = {};
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

describe("PlanPanel read-only during execution", () => {
  it("shows plan content but no Go or Review buttons when planPhase is executing", async () => {
    const id = "s-executing";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "xyz",
        decision: "approved",
        summary: "plan approved",
        body: "",
        findings: [],
        round: 1,
        cap: 3,
        approved: true,
        plan: "# Execution plan",
        blocks: [{ type: "rich-text", id: "b1", markdown: "Step overview" }],
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, {
      props: { session: session({ id, planPhase: "executing" }), onclose: vi.fn() },
    });

    // Plan content renders (the blocks caption is visible).
    await expect
      .element(page.getByText("Proposed — not yet built · the plan text below is authoritative"))
      .toBeVisible();

    // Actions block is absent — no Go, no Review.
    expect(document.querySelector(".actions")).toBeNull();
  });
});

describe("PlanPanel visual blocks", () => {
  it("augments: shows caption + VisualReview blocks above plan markdown when blocks present", async () => {
    const id = "s-blocks";
    // Seed the plan gate with blocks AND plan text before render.
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "abc",
        decision: "approved",
        summary: "looks good",
        body: "",
        findings: [],
        round: 1,
        cap: 3,
        approved: true,
        plan: "# Real plan markdown",
        blocks: [
          { type: "rich-text", id: "b1", markdown: "Approach overview text" },
          {
            type: "question-form",
            id: "b2",
            questions: [
              {
                id: "q1",
                prompt: "Which database engine?",
                kind: "single",
                options: ["pg", "sqlite"],
              },
            ],
          },
        ],
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    // Caption must be visible.
    await expect
      .element(page.getByText("Proposed — not yet built · the plan text below is authoritative"))
      .toBeVisible();

    // QuestionFormBlock renders the prompt synchronously.
    await expect.element(page.getByText("Which database engine?")).toBeVisible();

    // The plan markdown renders asynchronously via marked+DOMPurify.
    await expect.element(page.getByText("Real plan markdown")).toBeVisible();
  });

  it("markdown only: no caption when gate has no blocks", async () => {
    const id = "s-no-blocks";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "def",
        decision: "approved",
        summary: "ok",
        body: "",
        findings: [],
        round: 1,
        cap: 3,
        approved: true,
        plan: "# Plan without blocks",
        blocks: [],
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    // Plan markdown renders.
    await expect.element(page.getByText("Plan without blocks")).toBeVisible();

    // Caption must NOT be present.
    expect(document.querySelector(".plan-blocks-caption")).toBeNull();
  });
});
