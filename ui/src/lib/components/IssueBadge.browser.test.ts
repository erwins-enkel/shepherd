import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const { default: IssueBadge } = await import("./IssueBadge.svelte");
const { issueRef } = await import("$lib/issue-ref.svelte");

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

beforeEach(() => {
  issueRef.set(true);
});

afterEach(() => {
  document.body.innerHTML = "";
  issueRef.set(true);
});

describe("IssueBadge", () => {
  it("names the issue a session was spawned for", async () => {
    render(IssueBadge, { session: session({ id: "a", issueNumber: 2244 }) });
    await expect.element(page.getByText("#2244", { exact: true })).toBeVisible();
  });

  it("renders nothing for a session launched without an issue", () => {
    render(IssueBadge, { session: session({ id: "b", issueNumber: null }) });
    expect(document.querySelector(".issue-badge")).toBeNull();
  });

  it("names the issue to assistive tech and on hover", () => {
    render(IssueBadge, { session: session({ id: "c", issueNumber: 7 }) });
    const el = document.querySelector(".issue-badge") as HTMLElement;
    expect(el.getAttribute("aria-label")).toBe(m.issuebadge_label({ number: 7 }));
    expect(el.title).toBe(m.issuebadge_title({ number: 7 }));
  });

  // The whole point of the setting: an operator who finds the chip noisy turns it off
  // and every card drops it, without the number becoming unrecoverable elsewhere.
  it("disappears while the per-device preference is off", () => {
    issueRef.set(false);
    render(IssueBadge, { session: session({ id: "d", issueNumber: 2244 }) });
    expect(document.querySelector(".issue-badge")).toBeNull();
  });

  // No statusTip: it would raise the chip above the card's .unit-hit overlay and eat the
  // click, making a read-only identifier a dead zone in the middle of the chip row.
  it("renders no popover overlay", async () => {
    render(IssueBadge, { session: session({ id: "e", issueNumber: 12 }) });
    const el = document.querySelector(".issue-badge") as HTMLElement;
    await el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    expect(document.querySelector(".status-tip")).toBeNull();
  });
});
