import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import PlanPanel from "./PlanPanel.svelte";
import type { PlanGate, Session } from "$lib/types";
import { planGates } from "$lib/reviews.svelte";
import { reviewPlan } from "$lib/api";
import { m } from "$lib/paraglide/messages";
import { DOCS_URL } from "$lib/build-info";

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

function gate(id: string, partial: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: id,
    planHash: "hash",
    decision: "approved",
    summary: "plan approved",
    body: "",
    findings: [],
    round: 0,
    cap: 3,
    approved: true,
    plan: "# Execution plan",
    blocks: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

afterEach(() => {
  // The overlay is portaled to <body>, outside the test container, so clean it up.
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
  // Clean up any seeded plan gate entries.
  planGates.map = {};
  planGates.reviewing = {};
  planGates.reviewerEnv = {};
  vi.mocked(reviewPlan).mockReset();
  vi.mocked(reviewPlan).mockResolvedValue("skipped");
  vi.unstubAllGlobals();
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
      [id]: gate(id, {
        blocks: [{ type: "rich-text", id: "b1", markdown: "Step overview" }],
      }),
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
    await expect.element(page.getByText(m.planpanel_status_view())).toBeVisible();
  });
});

describe("PlanPanel release state", () => {
  it("keeps Go disabled for requested changes and explains approval is still required", async () => {
    const id = "s-changes";
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        summary: "tighten scope",
        findings: ["tighten scope"],
        round: 1,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_status_changes())).toBeVisible();
    expect(document.querySelector(".findings-head")?.textContent).toBe(m.planpanel_findings());
    await expect.element(page.getByRole("button", { name: m.planpanel_go() })).toBeDisabled();
    expect(
      document.querySelector<HTMLButtonElement>("button.go")?.getAttribute("aria-describedby"),
    ).toMatch(/^plan-status-/);
  });

  it("distinguishes a stalled requested-change plan at the review cap", async () => {
    const id = "s-cap";
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_status_changes_stalled())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_resume() }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_dismiss() }))
      .toBeVisible();
  });

  it("resumes a stalled plan through the quota endpoint and closes on resumed", async () => {
    const id = "s-resume";
    const onclose = vi.fn();
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, status: "resumed" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_resume() }).click();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${id}/quota/resume`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("dismisses a stalled plan through the quota endpoint and closes on dismissed", async () => {
    const id = "s-dismiss";
    const onclose = vi.fn();
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, status: "dismissed" }), { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_dismiss() }).click();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${id}/quota/dismiss`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the panel open when resume cannot reach the planning pane", async () => {
    const id = "s-unreachable";
    const onclose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ ok: true, status: "unreachable" }), { status: 202 });
      }),
    );
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_resume() }).click();
    await expect.element(page.getByText(m.planpanel_quota_unreachable())).toBeVisible();
    expect(onclose).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog", { name: m.planpanel_title() })).toBeVisible();
  });

  it("keeps unreachable feedback visible after the server resets the plan gate round", async () => {
    const id = "s-unreachable-reset";
    const onclose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        planGates.apply(
          id,
          gate(id, {
            decision: "changes_requested",
            round: 0,
            cap: 3,
            approved: false,
          }),
        );
        return new Response(JSON.stringify({ ok: true, status: "unreachable" }), { status: 202 });
      }),
    );
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_resume() }).click();
    await expect.element(page.getByText(m.planpanel_status_changes())).toBeVisible();
    await expect.element(page.getByText(m.planpanel_quota_unreachable())).toBeVisible();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("keeps the panel open when the quota endpoint reports not-stalled", async () => {
    const id = "s-not-stalled";
    const onclose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ ok: true, status: "not-stalled" }), { status: 202 });
      }),
    );
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_dismiss() }).click();
    await expect.element(page.getByText(m.planpanel_quota_not_stalled())).toBeVisible();
    expect(onclose).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog", { name: m.planpanel_title() })).toBeVisible();
  });

  it("keeps the panel open and shows failure copy when a quota action rejects", async () => {
    const id = "s-quota-error";
    const onclose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }),
    );
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose },
    });

    await page.getByRole("button", { name: m.planpanel_quota_resume() }).click();
    await expect.element(page.getByText(m.planpanel_quota_failed())).toBeVisible();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("does not render stalled action copy or quota actions while the planning agent is running", async () => {
    const id = "s-running";
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id, status: "running" }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_status_changes())).toBeVisible();
    await expect
      .element(page.getByText(m.planpanel_status_changes_stalled()))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_resume() }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_dismiss() }))
      .not.toBeInTheDocument();
  });

  it("does not render stalled quota actions while the plan reviewer is in flight", async () => {
    const id = "s-reviewing";
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 3,
        cap: 3,
        approved: false,
      }),
    };
    planGates.applyReviewing(id, true);

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_status_reviewing())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_resume() }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.planpanel_quota_dismiss() }))
      .not.toBeInTheDocument();
  });

  it("enables Go for an approved planning gate", async () => {
    const id = "s-approved";
    planGates.map = { [id]: gate(id) };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_status_ready())).toBeVisible();
    await expect.element(page.getByRole("button", { name: m.planpanel_go() })).not.toBeDisabled();
  });

  it("renders the review control inert for an approved gate and does not trigger a review", async () => {
    const id = "s-approved-inert";
    planGates.map = { [id]: gate(id) };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    // The approved reason is shown persistently beside the control.
    await expect.element(page.getByText(m.planpanel_review_already_approved())).toBeVisible();

    const reviewBtn = page.getByRole("button", {
      name: `${m.planpanel_review_now()} — ${m.planpanel_review_already_approved()}`,
    });
    await expect.element(reviewBtn).toHaveAttribute("aria-disabled", "true");

    // Clicking the inert control is a guarded no-op — no review is triggered. `force` bypasses
    // Playwright's actionability wait (it treats aria-disabled as not-enabled), so the click still
    // dispatches and we assert the component's own onclick guard swallows it.
    await reviewBtn.click({ force: true });
    expect(vi.mocked(reviewPlan)).not.toHaveBeenCalled();
  });

  it("starts a real review for an unchanged unapproved (changes-requested) plan", async () => {
    const id = "s-changes-review";
    vi.mocked(reviewPlan).mockResolvedValue("started");
    planGates.map = {
      [id]: gate(id, {
        decision: "changes_requested",
        round: 1,
        cap: 3,
        approved: false,
      }),
    };

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await page.getByRole("button", { name: m.planpanel_review_now() }).click();
    expect(vi.mocked(reviewPlan)).toHaveBeenCalledWith(id);
    // The in-flight indicator appears (the "started" bridge to the WS reviewing flag).
    await expect.element(page.getByText(m.planpanel_reviewing())).toBeVisible();
  });

  it("shows the reviewer CLI · model · effort on the in-flight button", async () => {
    const id = "s-reviewing-env";
    planGates.applyReviewing(id, true, { provider: "claude", model: "opus", effort: "high" });

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect
      .element(page.getByText(m.planpanel_reviewing_env({ env: "Claude Code · opus · High" })))
      .toBeVisible();
  });

  it("falls back to plain Reviewing… when the in-flight reviewer provider is null", async () => {
    const id = "s-reviewing-null-provider";
    // An adopted-orphan run can carry a null provider; the button must never surface "unavailable".
    planGates.applyReviewing(id, true, { provider: null, model: "opus", effort: "high" });

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_reviewing())).toBeVisible();
    expect(document.querySelector(".review")?.textContent).not.toContain("unavailable");
  });

  it("explains the required plan artifact in the planning/no-gate empty state", async () => {
    const id = "s-plan-unavailable-empty";

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await expect.element(page.getByText(m.planpanel_plan_unavailable())).toBeVisible();
  });

  it("shows persistent plan-unavailable feedback after review trigger returns that status", async () => {
    const id = "s-plan-unavailable-click";
    vi.mocked(reviewPlan).mockResolvedValue("plan-unavailable");

    render(PlanPanel, {
      props: { session: session({ id }), onclose: vi.fn() },
    });

    await page.getByRole("button", { name: m.planpanel_review_now() }).click();
    await expect.element(page.getByText(m.planpanel_review_plan_unavailable())).toBeVisible();

    await new Promise((resolve) => setTimeout(resolve, 6500));
    await expect.element(page.getByText(m.planpanel_review_plan_unavailable())).toBeVisible();
  });

  it("reports reviewer launch failure without claiming host saturation", async () => {
    const id = "s-review-error-spawn";
    vi.mocked(reviewPlan).mockResolvedValue("error-spawn");
    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });
    await page.getByRole("button", { name: m.planpanel_review_now() }).click();
    await expect.element(page.getByText(m.planpanel_review_failed_spawn())).toBeVisible();
    expect(m.planpanel_review_failed_spawn().toLowerCase()).not.toContain("busy");
  });

  it("names the review workspace when worktree creation fails", async () => {
    const id = "s-review-error-worktree";
    vi.mocked(reviewPlan).mockResolvedValue("error-worktree");
    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });
    await page.getByRole("button", { name: m.planpanel_review_now() }).click();
    await expect.element(page.getByText(m.planpanel_review_failed_worktree())).toBeVisible();
  });

  it("names the missing API key when the reviewer fails closed", async () => {
    const id = "s-review-error-auth";
    vi.mocked(reviewPlan).mockResolvedValue("error-auth");
    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });
    await page.getByRole("button", { name: m.planpanel_review_now() }).click();
    await expect.element(page.getByText(m.planpanel_review_failed_auth())).toBeVisible();
  });

  it("renders no status note when the chip is hidden", () => {
    const id = "s-none";
    render(PlanPanel, {
      props: { session: session({ id, planPhase: null }), onclose: vi.fn() },
    });

    expect(document.querySelector(".status-note")).toBeNull();
  });
});

describe("PlanPanel environment heading", () => {
  it("shows plan and review coding environments in the heading", async () => {
    const id = "s-env";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "env",
        decision: "approved",
        summary: "ok",
        body: "",
        findings: [],
        round: 0,
        cap: 3,
        approved: true,
        plan: "# Env plan",
        reviewerProvider: "claude",
        reviewerModel: "opus",
        reviewerEffort: "high",
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, {
      props: {
        session: session({
          id,
          agentProvider: "codex",
          model: "gpt-5.5",
          effort: "medium",
        }),
        onclose: vi.fn(),
      },
    });

    const envText = document.querySelector(".envline")?.textContent ?? "";
    expect(envText).toContain("Plan");
    expect(envText).toContain("Review");
    await expect.element(page.getByText("Codex · gpt-5.5 · Medium")).toBeVisible();
    await expect.element(page.getByText("Claude Code · opus · High")).toBeVisible();
  });

  it("shows partial reviewer metadata when provider is unavailable", async () => {
    const id = "s-env-missing";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "env-missing",
        decision: "approved",
        summary: "ok",
        body: "",
        findings: [],
        round: 0,
        cap: 3,
        approved: true,
        plan: "# Env plan",
        reviewerProvider: null,
        reviewerModel: "opus",
        reviewerEffort: null,
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });

    const envText = document.querySelector(".envline")?.textContent ?? "";
    expect(envText).toContain("Review");
    await expect.element(page.getByText("unavailable · opus")).toBeVisible();
  });

  it("opens a persistent details popover with the settings path and docs link", async () => {
    const id = "s-env-pop";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "env-pop",
        decision: "approved",
        summary: "ok",
        body: "",
        findings: [],
        round: 0,
        cap: 3,
        approved: true,
        plan: "# Env plan",
        reviewerProvider: "claude",
        reviewerModel: null,
        reviewerEffort: null,
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });

    await page.getByLabelText("Where to change plan and review coding environments").click();
    await expect.element(page.getByText("Coding environment")).toBeVisible();
    await expect
      .element(page.getByText(/Settings -> CLIs -> Planner \(plan reviewer\)/))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open configuration docs" }))
      .toHaveAttribute("href", `${DOCS_URL}reference/configuration/`);
  });

  it("closes the details popover with Escape while focus is inside it", async () => {
    const id = "s-env-pop-escape";
    planGates.map = {
      [id]: {
        sessionId: id,
        planHash: "env-pop-escape",
        decision: "approved",
        summary: "ok",
        body: "",
        findings: [],
        round: 0,
        cap: 3,
        approved: true,
        plan: "# Env plan",
        reviewerProvider: "claude",
        reviewerModel: null,
        reviewerEffort: null,
        updatedAt: Date.now(),
      },
    };

    render(PlanPanel, { props: { session: session({ id }), onclose: vi.fn() } });

    await page.getByLabelText("Where to change plan and review coding environments").click();
    const docsLink = document.querySelector<HTMLAnchorElement>(".env-pop a");
    docsLink?.focus();
    expect(document.activeElement).toBe(docsLink);
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByText("Coding environment")).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog", { name: m.planpanel_title() })).toBeVisible();
  });
});

describe("PlanPanel visual blocks", () => {
  it("augments: shows caption + VisualReview blocks above plan markdown when blocks present", async () => {
    const id = "s-blocks";
    // Seed the plan gate with blocks AND plan text before render.
    planGates.map = {
      [id]: gate(id, {
        summary: "looks good",
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
      }),
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
      [id]: gate(id, { summary: "ok", plan: "# Plan without blocks" }),
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
