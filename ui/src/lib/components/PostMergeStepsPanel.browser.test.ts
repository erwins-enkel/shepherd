import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { PostMergeSteps, OwedFocusSnapshot } from "$lib/types";
import { m } from "$lib/paraglide/messages";

// Mock api so the store's tick/dismiss never hit the network; capture calls.
const setManualStepDone = vi.fn(
  async (sessionId: string, stepId: string, done: boolean): Promise<PostMergeSteps> => ({
    ...record({ sessionId }),
    steps: [
      { id: "ms1", text: "Set FLAG=1", postMerge: false, doneAt: done ? 1 : null },
      { id: "ms2", text: "rotate secret", postMerge: true, doneAt: null },
    ],
  }),
);
const dismissManualSteps = vi.fn(async (sessionId: string): Promise<PostMergeSteps> => ({
  ...record({ sessionId }),
  clearedAt: Date.now(),
}));
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getOutstandingManualSteps: vi.fn(async () => []),
    setManualStepDone: (...a: [string, string, boolean]) => setManualStepDone(...a),
    dismissManualSteps: (...a: [string]) => dismissManualSteps(...a),
  };
});

const { postMergeSteps } = await import("$lib/post-merge-steps.svelte");
const { projectIcons } = await import("$lib/projectIcons.svelte");
const PostMergeStepsPanel = (await import("./PostMergeStepsPanel.svelte")).default;

function record(p: Partial<PostMergeSteps> & { sessionId: string }): PostMergeSteps {
  return {
    desig: "TASK-09",
    repoPath: "/repo/shepherd",
    prNumber: 12,
    prTitle: "Add the flag",
    steps: [
      { id: "ms1", text: "Set FLAG=1", postMerge: false, doneAt: null },
      { id: "ms2", text: "rotate secret", postMerge: true, doneAt: null },
    ],
    trackingIssueUrl: null,
    trackingIssueNumber: null,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    clearedAt: null,
    ...p,
  };
}

function snapshot(p: Partial<OwedFocusSnapshot> & { sessionId: string }): OwedFocusSnapshot {
  return {
    desig: "TASK-09",
    repoPath: "/repo/shepherd",
    prNumber: 12,
    steps: [
      { id: "ms1", text: "Set FLAG=1", postMerge: false },
      { id: "ms2", text: "rotate secret", postMerge: true },
    ],
    merged: true,
    ...p,
  };
}

describe("PostMergeStepsPanel", () => {
  beforeEach(() => {
    postMergeSteps.records = [];
    postMergeSteps.loaded = false;
    postMergeSteps.settled = false;
    projectIcons.map = {};
    setManualStepDone.mockClear();
    dismissManualSteps.mockClear();
  });

  it("live card shows the repo marker: basename + project emoji when set", async () => {
    projectIcons.map = { "/repo/shepherd": "🐑" };
    postMergeSteps.records = [record({ sessionId: "s1", repoPath: "/repo/shepherd" })];
    const screen = await render(PostMergeStepsPanel);
    await expect.element(page.getByText("shepherd")).toBeInTheDocument();
    const icon = screen.container.querySelector(".ow-repo-icon");
    expect(icon).not.toBeNull();
    expect(icon?.textContent).toBe("🐑");
  });

  it("live card with no project emoji renders name-only — no ▣, no icon slot", async () => {
    // projectIcons.map is empty (reset in beforeEach) → iconFor returns null.
    postMergeSteps.records = [record({ sessionId: "s1", repoPath: "/repo/web-app" })];
    const screen = await render(PostMergeStepsPanel);
    await expect.element(page.getByText("web-app")).toBeInTheDocument();
    expect(screen.container.querySelector(".ow-repo-icon")).toBeNull();
    expect(screen.container.textContent).not.toContain("▣");
  });

  it("shows the empty state when nothing is owed", async () => {
    render(PostMergeStepsPanel);
    await expect.element(page.getByText(m.owed_empty())).toBeInTheDocument();
  });

  it("renders each owed record's steps with the POST-MERGE badge + count", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    await expect.element(page.getByText("Set FLAG=1")).toBeInTheDocument();
    await expect.element(page.getByText("rotate secret")).toBeInTheDocument();
    await expect.element(page.getByText("TASK-09")).toBeInTheDocument();
    // POST-MERGE badge appears for the postMerge step (exact: the panel title also contains "Post-merge")
    await expect
      .element(page.getByText(m.owed_post_merge_badge(), { exact: true }))
      .toBeInTheDocument();
    // count "0 of 2 done"
    await expect
      .element(page.getByText(m.owed_steps_count({ done: 0, total: 2 })))
      .toBeInTheDocument();
  });

  it("repo filter scopes the card list to the active repo path", async () => {
    postMergeSteps.records = [
      record({ sessionId: "s1", desig: "TASK-IN", repoPath: "/repo/shepherd" }),
      record({ sessionId: "s2", desig: "TASK-OUT", repoPath: "/repo/other" }),
    ];
    render(PostMergeStepsPanel, { repoFilter: new Set(["/repo/shepherd"]) });
    await expect.element(page.getByText("TASK-IN")).toBeInTheDocument();
    await expect.element(page.getByText("TASK-OUT")).not.toBeInTheDocument();
  });

  it("repo filter with no matching records shows the repo-scoped empty copy, not the generic one", async () => {
    postMergeSteps.records = [record({ sessionId: "s2", repoPath: "/repo/other" })];
    render(PostMergeStepsPanel, {
      repoFilter: new Set(["/repo/shepherd"]),
      filteredRepo: "shepherd",
    });
    await expect
      .element(page.getByText(m.owed_repo_filter_empty({ repo: "shepherd" })))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.owed_empty())).not.toBeInTheDocument();
  });

  it("no repo filter (empty) lists every record and uses the generic empty copy", async () => {
    render(PostMergeStepsPanel, { repoFilter: new Set<string>() });
    await expect.element(page.getByText(m.owed_empty())).toBeInTheDocument();
  });

  it("renders the tracking-issue link when present", async () => {
    postMergeSteps.records = [
      record({ sessionId: "s1", trackingIssueUrl: "https://example.test/issues/9" }),
    ];
    render(PostMergeStepsPanel);
    const link = page.getByText(m.owed_tracking_issue());
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "https://example.test/issues/9");
  });

  it("ticking a step calls the api with done=true", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    const boxes = page.getByRole("checkbox");
    await boxes.first().click();
    expect(setManualStepDone).toHaveBeenCalledWith("s1", "ms1", true);
  });

  it("dismiss is arm-then-confirm: first click arms, second confirms (no modal)", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    render(PostMergeStepsPanel);
    const btn = page.getByText(m.owed_dismiss(), { exact: true });
    await btn.click();
    // armed → label switches to the confirm copy; api not called yet
    expect(dismissManualSteps).not.toHaveBeenCalled();
    await expect.element(page.getByText(m.owed_dismiss_confirm())).toBeInTheDocument();
    await page.getByText(m.owed_dismiss_confirm()).click();
    expect(dismissManualSteps).toHaveBeenCalledWith("s1");
  });
});

describe("PostMergeStepsPanel — focus (#1275)", () => {
  beforeEach(() => {
    postMergeSteps.records = [];
    postMergeSteps.loaded = false;
    postMergeSteps.settled = false;
    projectIcons.map = {};
  });

  it("frozen fallback card shows the repo marker (basename from the snapshot's repoPath)", async () => {
    // merged + cleared → frozen card (no live record). The repo reference must render here too.
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    const screen = await render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: true, repoPath: "/repo/shepherd" }),
      focusNonce: 1,
      focusHandledNonce: 0,
    });
    await expect.element(page.getByText(m.owed_frozen_cleared_note())).toBeInTheDocument();
    const frozen = screen.container.querySelector(".ow-card--frozen");
    expect(frozen).not.toBeNull();
    expect(frozen?.querySelector(".ow-repo")?.textContent).toContain("shepherd");
  });

  it("live record + loaded: highlights the live card, no frozen fallback", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    const onfocusresolved = vi.fn();
    const screen = await render(PostMergeStepsPanel, {
      focusSessionId: "s1",
      focusSnapshot: snapshot({ sessionId: "s1" }),
      focusNonce: 1,
      focusHandledNonce: 0,
      onfocusresolved,
    });
    await expect.poll(() => onfocusresolved.mock.calls.length).toBe(1);
    expect(onfocusresolved).toHaveBeenCalledWith(1);
    expect(screen.container.querySelector(".ow-card--frozen")).toBeNull();
    await expect
      .poll(() =>
        screen.container.querySelector('[data-session-id="s1"]')?.classList.contains("focus"),
      )
      .toBe(true);
  });

  it("merged + live record NOT yet settled: waits (no frozen 'no longer owed' flash), then resolves once loaded", async () => {
    const onfocusresolved = vi.fn();
    const screen = await render(PostMergeStepsPanel, {
      focusSessionId: "s1",
      focusSnapshot: snapshot({ sessionId: "s1", merged: true }),
      focusNonce: 1,
      focusHandledNonce: 0,
      onfocusresolved,
    });
    // Load still in flight (loaded:false, settled:false, records empty) — must NOT render a
    // frozen "no longer owed" card, and must NOT resolve yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.container.querySelector(".ow-card--frozen")).toBeNull();
    expect(onfocusresolved).not.toHaveBeenCalled();

    // Late load resolves with the live record.
    postMergeSteps.records = [record({ sessionId: "s1" })];
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;

    await expect.poll(() => onfocusresolved.mock.calls.length).toBe(1);
    expect(onfocusresolved).toHaveBeenCalledWith(1);
    expect(screen.container.querySelector(".ow-card--frozen")).toBeNull();
  });

  it("merged + cleared (settled, loaded, no live record): frozen card with the cleared note", async () => {
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: true }),
      focusNonce: 1,
      focusHandledNonce: 0,
    });
    await expect.element(page.getByText(m.owed_frozen_cleared_note())).toBeInTheDocument();
    await expect.element(page.getByText(m.owed_frozen_unknown_note())).not.toBeInTheDocument();
  });

  it("merged + load failed (settled, NOT loaded, no live record): frozen card with the unknown note", async () => {
    postMergeSteps.loaded = false;
    postMergeSteps.settled = true;
    render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: true }),
      focusNonce: 1,
      focusHandledNonce: 0,
    });
    await expect.element(page.getByText(m.owed_frozen_unknown_note())).toBeInTheDocument();
    await expect.element(page.getByText(m.owed_frozen_cleared_note())).not.toBeInTheDocument();
  });

  it("pre-merge (snapshot.merged=false): frozen card with the pre-merge note regardless of load state", async () => {
    render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: false }),
      focusNonce: 1,
      focusHandledNonce: 0,
    });
    await expect.element(page.getByText(m.owed_frozen_pre_merge_note())).toBeInTheDocument();
  });

  it("empty-state precedence: a pinned frozen card replaces .ow-empty, never hides behind it", async () => {
    render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: false }),
      focusNonce: 1,
      focusHandledNonce: 0,
    });
    await expect.element(page.getByText(m.owed_frozen_pre_merge_note())).toBeInTheDocument();
    await expect.element(page.getByText(m.owed_empty())).not.toBeInTheDocument();
  });

  it("remount guard: a lens toggle back with the same (already-handled) nonce shows no phantom frozen card", async () => {
    const onfocusresolved = vi.fn();
    const first = await render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: false }),
      focusNonce: 1,
      focusHandledNonce: 0,
      onfocusresolved,
    });
    await expect.poll(() => onfocusresolved.mock.calls.length).toBe(1);
    await first.unmount();

    // Simulated remount (owner's page kept handledNonce === nonce across the panel's own unmount).
    const second = await render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: false }),
      focusNonce: 1,
      focusHandledNonce: 1,
      onfocusresolved,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(second.container.querySelector(".ow-card--frozen")).toBeNull();
  });

  it("nonce guard: a records refresh with an already-handled nonce does not re-resolve or re-highlight", async () => {
    postMergeSteps.records = [record({ sessionId: "s1" })];
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    const onfocusresolved = vi.fn();
    render(PostMergeStepsPanel, {
      focusSessionId: "s1",
      focusSnapshot: snapshot({ sessionId: "s1" }),
      focusNonce: 1,
      focusHandledNonce: 1, // already handled — this focus was resolved by an earlier click
      onfocusresolved,
    });
    // A WS-driven records refresh (new array identity, same content) must not re-trigger resolution.
    postMergeSteps.records = [record({ sessionId: "s1" })];
    await new Promise((r) => setTimeout(r, 50));
    expect(onfocusresolved).not.toHaveBeenCalled();
  });

  it("focus with a repo filter active: a chip-click focus on a session in the filtered repo still resolves to its live card (invariant survives filtering)", async () => {
    // In practice onShowOwed fires from a herd row that is already repo-filtered, so the focused
    // session's repo always matches the active filter. A decoy record in another repo proves the
    // list IS filtered while the focus still resolves to the live card in the filtered repo.
    postMergeSteps.records = [
      record({ sessionId: "s1", desig: "TASK-77", repoPath: "/repo/shepherd" }),
      record({ sessionId: "s2", desig: "TASK-OUT", repoPath: "/repo/other" }),
    ];
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    const onfocusresolved = vi.fn();
    const screen = await render(PostMergeStepsPanel, {
      repoFilter: new Set(["/repo/shepherd"]),
      focusSessionId: "s1",
      focusSnapshot: snapshot({ sessionId: "s1" }),
      focusNonce: 1,
      focusHandledNonce: 0,
      onfocusresolved,
    });
    // The #1275 "live record always wins / never a dead end" invariant survives filtering:
    // focus resolves to the live card (not a frozen fallback), and it renders + flashes.
    await expect.poll(() => onfocusresolved.mock.calls.length).toBe(1);
    expect(onfocusresolved).toHaveBeenCalledWith(1);
    expect(screen.container.querySelector(".ow-card--frozen")).toBeNull();
    await expect
      .poll(() =>
        screen.container.querySelector('[data-session-id="s1"]')?.classList.contains("focus"),
      )
      .toBe(true);
    await expect.element(page.getByText("TASK-77")).toBeInTheDocument();
    // the decoy from the other repo stays filtered out of the list
    await expect.element(page.getByText("TASK-OUT")).not.toBeInTheDocument();
  });

  it("live record wins: a pinned frozen card is suppressed once a live record for the same session arrives (even after its nonce is handled)", async () => {
    // Pin a frozen "cleared" card (merged, settled, loaded, no live record yet).
    postMergeSteps.loaded = true;
    postMergeSteps.settled = true;
    const onfocusresolved = vi.fn();
    const screen = await render(PostMergeStepsPanel, {
      focusSnapshot: snapshot({ sessionId: "s1", merged: true }),
      focusNonce: 1,
      focusHandledNonce: 0,
      onfocusresolved,
    });
    await expect.element(page.getByText(m.owed_frozen_cleared_note())).toBeInTheDocument();
    await expect.poll(() => onfocusresolved.mock.calls.length).toBe(1);

    // The page marks the nonce handled (as it does on resolution), THEN a WS refresh adds the
    // now-live record for the same session (e.g. its PR merged during this window). `settled` is
    // sticky, so the effect returns early at the nonce guard — the render-time guard must still
    // suppress the frozen card so it can't co-render with (and contradict) the live card.
    await screen.rerender({
      focusSnapshot: snapshot({ sessionId: "s1", merged: true }),
      focusNonce: 1,
      focusHandledNonce: 1,
      onfocusresolved,
    });
    postMergeSteps.records = [record({ sessionId: "s1" })];

    await expect.element(page.getByText(m.owed_frozen_cleared_note())).not.toBeInTheDocument();
    expect(screen.container.querySelector(".ow-card--frozen")).toBeNull();
    // the live interactive card for the session is the one that renders
    expect(screen.container.querySelector('[data-session-id="s1"]')).not.toBeNull();
    // the effect did not re-resolve (nonce already handled)
    expect(onfocusresolved.mock.calls.length).toBe(1);
  });
});
