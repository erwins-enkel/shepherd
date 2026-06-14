import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import DoneRecapPanel from "./DoneRecapPanel.svelte";
import { recaps } from "$lib/recaps.svelte";
import type { Session, Recap } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-09",
    name: "finished task",
    prompt: "do the thing",
    repoPath: "/repo/shepherd",
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
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 1000,
    archivedAt: Date.now() - 60_000,
    ...partial,
  };
}

function recap(partial: Partial<Recap> & { sessionId: string }): Recap {
  return {
    state: "ready",
    headSha: "abc",
    verdict: "ready",
    headline: "Shipped the feature",
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

describe("DoneRecapPanel ready state", () => {
  it("renders verdict chip + headline + changed files + issue text", async () => {
    recaps.map = {
      s1: recap({
        sessionId: "s1",
        verdict: "ready",
        headline: "Shipped the feature",
        changedFiles: ["src/a.ts", "src/b.ts"],
        openItems: ["follow up on X"],
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "s1", issueNumber: 123 }) });

    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    // verdict chip (Ready)
    await expect.element(page.getByText("Ready")).toBeInTheDocument();
    // changed files section + entries
    await expect.element(page.getByText("Changed files")).toBeInTheDocument();
    await expect.element(page.getByText("src/a.ts")).toBeInTheDocument();
    await expect.element(page.getByText("src/b.ts")).toBeInTheDocument();
    // open items
    await expect.element(page.getByText("follow up on X")).toBeInTheDocument();
    // issue rendered as text (no fabricated PR URL/link)
    await expect.element(page.getByText("Issue #123")).toBeInTheDocument();
    expect(document.querySelector("a"), "no fabricated PR link in header").toBeNull();
  });

  it("omits the changed-files section when the list is empty", async () => {
    recaps.map = { s2: recap({ sessionId: "s2", changedFiles: [] }) };
    render(DoneRecapPanel, { session: session({ id: "s2" }) });
    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    expect(page.getByText("Changed files").elements().length, "no changed-files heading").toBe(0);
  });

  it("has no regenerate/retry button (worktree is gone)", async () => {
    recaps.map = { s3: recap({ sessionId: "s3" }) };
    render(DoneRecapPanel, { session: session({ id: "s3" }) });
    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    expect(document.querySelectorAll("button").length, "panel renders no buttons").toBe(0);
  });
});

describe("DoneRecapPanel generating state", () => {
  it("shows the generating line", async () => {
    recaps.map = { g1: recap({ sessionId: "g1", state: "generating" }) };
    render(DoneRecapPanel, { session: session({ id: "g1" }) });
    await expect.element(page.getByText("Generating recap…")).toBeInTheDocument();
  });
});

describe("DoneRecapPanel fail-closed", () => {
  it("failed recap → names the failure (never a blank success card)", async () => {
    recaps.map = { f1: recap({ sessionId: "f1", state: "failed" }) };
    render(DoneRecapPanel, { session: session({ id: "f1" }) });
    await expect.element(page.getByText("Recap generation failed.")).toBeInTheDocument();
    expect(page.getByText("Shipped the feature").elements().length, "no headline").toBe(0);
  });

  it("missing recap row on a recent session → generic unavailable", async () => {
    // no entry in recaps.map; finished after recaps shipped → generic message
    render(DoneRecapPanel, { session: session({ id: "missing" }) });
    await expect
      .element(page.getByText("No recap available for this session."))
      .toBeInTheDocument();
  });

  it("missing recap row on a pre-feature session → explains it predates recaps", async () => {
    // finished before durable recaps shipped (epoch 1781423073000) → reason-named message
    render(DoneRecapPanel, { session: session({ id: "old", archivedAt: 1_700_000_000_000 }) });
    await expect
      .element(
        page.getByText(
          "This session finished before session recaps were available, so none was recorded.",
        ),
      )
      .toBeInTheDocument();
  });
});
