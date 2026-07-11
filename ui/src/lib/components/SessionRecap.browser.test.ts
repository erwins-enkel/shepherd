import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import SessionRecap from "./SessionRecap.svelte";
import { recaps } from "$lib/recaps.svelte";
import type { Session, Recap } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-42",
    name: "live task",
    prompt: "do stuff",
    repoPath: "/repo/shepherd",
    baseBranch: "main",
    branch: "feat/y",
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
    updatedAt: 1000,
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

function recap(partial: Partial<Recap> & { sessionId: string }): Recap {
  return {
    state: "ready",
    headSha: "abc",
    verdict: "ready",
    headline: "Session recap headline",
    body: "Did **all** the work.",
    openItems: [],
    changedFiles: [],
    spawnSessionId: partial.sessionId,
    cwd: "/repo",
    model: null,
    spawnedAt: 0,
    generatedAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

beforeEach(() => {
  recaps.map = {};
});

afterEach(() => {
  recaps.map = {};
  document.body.innerHTML = "";
});

describe("SessionRecap VisualReview blocks", () => {
  it("blocks present → expand → VisualReview content visible (callout tone label)", async () => {
    recaps.map = {
      sr1: recap({
        sessionId: "sr1",
        blocks: [{ type: "callout", id: "c1", tone: "risk", markdown: "Pay attention to this." }],
      }),
    };
    render(SessionRecap, { session: session({ id: "sr1" }) });

    // header is visible; expand by clicking it
    const header = page.getByRole("button", { expanded: false });
    await header.click();

    // callout tone label should now be visible inside VisualReview
    await expect.element(page.getByText("Risk")).toBeInTheDocument();
  });

  it("no blocks → expand → flat markdown body renders", async () => {
    recaps.map = {
      sr2: recap({
        sessionId: "sr2",
        body: "Plain **body** text.",
      }),
    };
    render(SessionRecap, { session: session({ id: "sr2" }) });

    // expand
    const header = page.getByRole("button", { expanded: false });
    await header.click();

    // flat body rendered (marked renders **body** as <strong>body</strong>)
    await expect.element(page.getByText("body", { exact: false })).toBeInTheDocument();
  });
});

describe("SessionRecap inline mode", () => {
  it("inline: body visible without click, no collapse toggle (no aria-expanded)", async () => {
    recaps.map = {
      sr3: recap({
        sessionId: "sr3",
        blocks: [{ type: "callout", id: "c2", tone: "info", markdown: "Inline callout content." }],
      }),
    };
    render(SessionRecap, { session: session({ id: "sr3" }), inline: true });

    // VisualReview content visible immediately, no click needed
    await expect.element(page.getByText("Inline callout content.")).toBeInTheDocument();

    // no collapse toggle — no element with aria-expanded
    expect(document.querySelector("[aria-expanded]")).toBeNull();
  });

  it("default (non-inline): body hidden until header clicked", async () => {
    recaps.map = {
      sr4: recap({
        sessionId: "sr4",
        blocks: [{ type: "callout", id: "c3", tone: "info", markdown: "Default callout content." }],
      }),
    };
    render(SessionRecap, { session: session({ id: "sr4" }) });

    // body not visible before click
    expect(document.querySelector(".recap-body")).toBeNull();

    // click the toggle
    const header = page.getByRole("button", { expanded: false });
    await header.click();

    // now body is visible
    await expect.element(page.getByText("Default callout content.")).toBeInTheDocument();
  });
});
