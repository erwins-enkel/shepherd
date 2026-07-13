import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PlanGateBadge from "./PlanGateBadge.svelte";
import type { PlanGate, Session } from "$lib/types";
import { planGates } from "$lib/reviews.svelte";
import { m } from "$lib/paraglide/messages";
import { toasts } from "$lib/toasts.svelte";

const api = vi.hoisted(() => ({
  replySession: vi.fn(async () => {}),
  reviewPlan: vi.fn(async (): Promise<import("$lib/api").PlanReviewTrigger> => "skipped"),
  releasePlanGate: vi.fn(async () => true),
}));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    replySession: api.replySession,
    reviewPlan: api.reviewPlan,
    releasePlanGate: api.releasePlanGate,
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
    planGateEnabled: true,
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
    decision: "changes_requested",
    summary: "tighten scope",
    body: "Review body",
    findings: ["Replace vague availability prose.", "Add the same-head regression test."],
    round: 3,
    cap: 3,
    approved: false,
    plan: "# Execution plan",
    blocks: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

afterEach(() => {
  document.querySelectorAll(".pg-menu, .overlay").forEach((el) => el.remove());
  planGates.map = {};
  toasts.items = [];
  api.replySession.mockClear();
  api.reviewPlan.mockClear();
  api.reviewPlan.mockResolvedValue("skipped");
});

describe("PlanGateBadge stalled menu", () => {
  it("opens a stalled-plan action menu instead of the plan dialog", async () => {
    const id = "s-cap";
    planGates.map = { [id]: gate(id) };

    render(PlanGateBadge, { props: { session: session({ id }) } });

    await page.getByRole("button", { name: m.plangate_changes({ round: 3, cap: 3 }) }).click();

    await expect.element(page.getByRole("menu", { name: m.plangate_menu_label() })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: m.plangate_menu_send_changes() }))
      .toBeVisible();
    await expect.element(page.getByText(m.plangate_menu_why_body())).toBeVisible();
    expect(document.querySelector(".overlay")).toBeNull();
  });

  it("sends the stored review findings to the planning agent", async () => {
    const id = "s-send";
    planGates.map = { [id]: gate(id) };

    render(PlanGateBadge, { props: { session: session({ id }) } });

    await page.getByRole("button", { name: m.plangate_changes({ round: 3, cap: 3 }) }).click();
    await page.getByRole("menuitem", { name: m.plangate_menu_send_changes() }).click();
    expect(api.replySession).not.toHaveBeenCalled();

    const draft = page.getByRole("textbox", { name: m.plangate_menu_editor_label() });
    await expect.element(draft).toBeVisible();
    await expect.element(draft).toHaveValue(expect.stringContaining("1. Replace vague"));
    await draft.fill("Operator note: keep this narrow.\n\n1. Replace vague availability prose.");
    await page.getByRole("button", { name: m.plangate_menu_editor_send() }).click();

    await vi.waitFor(() => expect(api.replySession).toHaveBeenCalledTimes(1));
    expect(api.replySession).toHaveBeenCalledWith(
      id,
      "Operator note: keep this narrow.\n\n1. Replace vague availability prose.",
    );
    expect(toasts.items.some((t) => t.text === m.plangate_repair_sent())).toBe(true);
  });

  it("toasts when a re-review can't start (skipped)", async () => {
    const id = "s-review";
    planGates.map = { [id]: gate(id) };

    render(PlanGateBadge, { props: { session: session({ id }) } });

    await page.getByRole("button", { name: m.plangate_changes({ round: 3, cap: 3 }) }).click();
    await page.getByRole("menuitem", { name: m.plangate_menu_rereview() }).click();

    await vi.waitFor(() => expect(api.reviewPlan).toHaveBeenCalledWith(id));
    expect(toasts.items.some((t) => t.text === m.plangate_review_skipped_stalled())).toBe(true);
  });

  it("starts a real re-review from the stalled menu (force bypasses the dedupe)", async () => {
    const id = "s-review-started";
    api.reviewPlan.mockResolvedValue("started");
    planGates.map = { [id]: gate(id) };

    render(PlanGateBadge, { props: { session: session({ id }) } });

    await page.getByRole("button", { name: m.plangate_changes({ round: 3, cap: 3 }) }).click();
    await page.getByRole("menuitem", { name: m.plangate_menu_rereview() }).click();

    await vi.waitFor(() => expect(api.reviewPlan).toHaveBeenCalledWith(id));
    expect(toasts.items.some((t) => t.text === m.plangate_review_started())).toBe(true);
  });

  it("on an error-* outcome: raises the failure toast and keeps the menu open to retry", async () => {
    const id = "s-review-error";
    api.reviewPlan.mockResolvedValue("error-spawn");
    planGates.map = { [id]: gate(id) };

    render(PlanGateBadge, { props: { session: session({ id }) } });

    await page.getByRole("button", { name: m.plangate_changes({ round: 3, cap: 3 }) }).click();
    await page.getByRole("menuitem", { name: m.plangate_menu_rereview() }).click();

    await vi.waitFor(() => expect(api.reviewPlan).toHaveBeenCalledWith(id));
    expect(toasts.items.some((t) => t.text === m.gitrail_review_plan_failed())).toBe(true);
    // the menu must NOT close on error — the operator can retry in place
    await expect.element(page.getByRole("menu", { name: m.plangate_menu_label() })).toBeVisible();
  });
});
