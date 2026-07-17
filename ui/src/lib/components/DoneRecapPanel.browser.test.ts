import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import DoneRecapPanel from "./DoneRecapPanel.svelte";
import { recaps } from "$lib/recaps.svelte";
import { m } from "$lib/paraglide/messages";
import type { Session, Recap, SessionUsage } from "$lib/types";

// Deferred-resolution mock for the status bar's usage fetch: each call parks its resolver
// under the session id so tests control response ORDER (the stale-response test resolves
// the first session's request last). Unresolved requests are harmless elsewhere — the pane
// just shows its placeholder.
const { usageResolvers } = vi.hoisted(() => ({
  usageResolvers: new Map<string, (u: SessionUsage) => void>(),
}));
vi.mock(import("$lib/api"), async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    getSessionUsage: vi.fn(
      (id: string) => new Promise<SessionUsage>((resolve) => usageResolvers.set(id, resolve)),
    ),
  };
});

function usageDto(total: number): SessionUsage {
  return {
    available: true,
    source: "snapshot",
    total,
    input: total,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messageCount: 1,
    byModel: null,
  };
}

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
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 1000,
    archivedAt: Date.now() - 60_000,
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
    headline: "Shipped the feature",
    body: "Did **all** the work.",
    diffState: null,
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

  it("renders the header issue as a forge link when issueUrl is present", async () => {
    recaps.map = { s1l: recap({ sessionId: "s1l" }) };
    render(DoneRecapPanel, {
      session: session({
        id: "s1l",
        issueNumber: 855,
        issueUrl: "https://github.com/o/r/issues/855",
      }),
    });
    const link = page.getByRole("link", { name: "Issue #855" });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "https://github.com/o/r/issues/855");
    await expect.element(link).toHaveAttribute("target", "_blank");
  });

  it("omits the changed-files section when the list is empty", async () => {
    recaps.map = { s2: recap({ sessionId: "s2", changedFiles: [], diffState: "none" }) };
    render(DoneRecapPanel, { session: session({ id: "s2" }) });
    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    expect(page.getByText("Changed files").elements().length, "no changed-files heading").toBe(0);
    await expect
      .element(page.getByText("No files were changed in this session, so there is no code diff."))
      .toBeInTheDocument();
  });

  it("does not infer no changes from an older recap with unknown diff metadata", async () => {
    recaps.map = { legacy: recap({ sessionId: "legacy", changedFiles: [], diffState: null }) };
    render(DoneRecapPanel, { session: session({ id: "legacy" }) });
    expect(
      page.getByText("No files were changed in this session, so there is no code diff.").query(),
    ).toBeNull();
  });

  it("has no regenerate/retry button (worktree is gone)", async () => {
    recaps.map = { s3: recap({ sessionId: "s3" }) };
    render(DoneRecapPanel, { session: session({ id: "s3" }) });
    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    expect(document.querySelectorAll("button").length, "panel renders no buttons").toBe(0);
  });
});

describe("DoneRecapPanel VisualReview blocks", () => {
  it("renders VisualReview when blocks present (callout label + file-tree segment visible)", async () => {
    recaps.map = {
      b1: recap({
        sessionId: "b1",
        blocks: [
          { type: "rich-text", id: "r1", markdown: "Summary text." },
          {
            type: "file-tree",
            id: "ft1",
            // single-segment path so getByText finds it directly as one node
            entries: [{ path: "index.ts", change: "added" }],
          },
          { type: "callout", id: "c1", tone: "risk", markdown: "Watch out!" },
        ],
        changedFiles: ["index.ts"],
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "b1" }) });
    // callout tone label visible
    await expect.element(page.getByText("Risk")).toBeInTheDocument();
    // file-tree leaf segment visible
    await expect.element(page.getByText("index.ts")).toBeInTheDocument();
  });

  it("file-tree block supersedes standalone changed-files list", async () => {
    recaps.map = {
      b2: recap({
        sessionId: "b2",
        blocks: [
          {
            type: "file-tree",
            id: "ft2",
            // use a single-segment path so getByText finds it directly
            entries: [{ path: "widget.ts", change: "modified" }],
          },
        ],
        changedFiles: ["widget.ts"],
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "b2" }) });
    // wait for the VisualReview file-tree content to appear
    await expect.element(page.getByText("widget.ts")).toBeInTheDocument();
    // standalone "Changed files" heading must NOT appear
    expect(
      page.getByText("Changed files").elements().length,
      "no standalone changed-files heading when file-tree block present",
    ).toBe(0);
  });

  it("no blocks → flat body still renders", async () => {
    recaps.map = {
      b3: recap({
        sessionId: "b3",
        body: "Plain **body** text.",
        changedFiles: ["src/c.ts"],
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "b3" }) });
    // headline still renders
    await expect.element(page.getByText("Shipped the feature")).toBeInTheDocument();
    // changed-files section still shows
    await expect.element(page.getByText("Changed files")).toBeInTheDocument();
    await expect.element(page.getByText("src/c.ts")).toBeInTheDocument();
  });
});

describe("DoneRecapPanel generating state", () => {
  it("shows the generating line", async () => {
    recaps.map = { g1: recap({ sessionId: "g1", state: "generating" }) };
    render(DoneRecapPanel, { session: session({ id: "g1" }) });
    await expect.element(page.getByText("Generating recap…")).toBeInTheDocument();
  });
});

describe("DoneRecapPanel bring-back button", () => {
  it("renders Bring back button only when onbringback is provided", async () => {
    recaps.map = { bb1: recap({ sessionId: "bb1" }) };

    // without onbringback: no button at all
    const { rerender } = await render(DoneRecapPanel, { session: session({ id: "bb1" }) });
    expect(
      page.getByRole("button", { name: m.donerecap_bringback() }).query(),
      "no button without onbringback",
    ).toBeNull();

    // with onbringback: button appears
    await rerender({ session: session({ id: "bb1" }), onbringback: vi.fn() });
    await expect
      .element(page.getByRole("button", { name: m.donerecap_bringback() }))
      .toBeInTheDocument();
  });

  it("first click arms (no callback yet), second click fires onbringback once", async () => {
    recaps.map = { bb2: recap({ sessionId: "bb2" }) };
    const onbringback = vi.fn();
    render(DoneRecapPanel, { session: session({ id: "bb2" }), onbringback });

    const btn = page.getByRole("button", { name: m.donerecap_bringback() });
    await btn.click();

    // armed: callback NOT yet fired, label switches to confirm
    expect(onbringback).not.toHaveBeenCalled();
    const confirmBtn = page.getByRole("button", { name: m.donerecap_bringback_confirm() });
    await expect.element(confirmBtn).toBeInTheDocument();

    // second click fires it exactly once with the session id
    await confirmBtn.click();
    expect(onbringback).toHaveBeenCalledTimes(1);
    expect(onbringback).toHaveBeenCalledWith("bb2");
  });

  it("auto-disarms after the arm window without firing the callback", async () => {
    vi.useFakeTimers();
    try {
      recaps.map = { bb3: recap({ sessionId: "bb3" }) };
      const onbringback = vi.fn();
      render(DoneRecapPanel, { session: session({ id: "bb3" }), onbringback });

      const btn = page.getByRole("button", { name: m.donerecap_bringback() });
      await btn.click();
      await expect
        .element(page.getByRole("button", { name: m.donerecap_bringback_confirm() }))
        .toBeInTheDocument();

      // advance past the ~3s arm window → disarms back to idle label, no fire
      vi.advanceTimersByTime(3500);
      await expect
        .element(page.getByRole("button", { name: m.donerecap_bringback() }))
        .toBeInTheDocument();
      expect(onbringback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DoneRecapPanel fail-closed", () => {
  it("technical failure shows actionable copy and closed redacted details", async () => {
    recaps.map = {
      ft: recap({
        sessionId: "ft",
        state: "failed",
        headline: "",
        body: "",
        failure: {
          code: "timed-out",
          provider: "codex",
          model: "gpt-5.6-luna",
          detail: "fatal: not a git repository",
        },
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "ft" }) });

    await expect.element(page.getByText("Recap generation timed out.")).toBeInTheDocument();
    await expect
      .element(page.getByText("Check the recap provider and model before relaunching the session."))
      .toBeInTheDocument();
    const details = document.querySelector("details");
    expect(details?.open).toBe(false);
    await page.getByText("Technical details").click();
    await expect.element(page.getByText("gpt-5.6-luna")).toBeInTheDocument();
    await expect.element(page.getByText("fatal: not a git repository")).toBeInTheDocument();
  });

  it("legacy empty recap explains that no files changed and no diff existed", async () => {
    recaps.map = { empty: recap({ sessionId: "empty", state: "empty" }) };
    render(DoneRecapPanel, { session: session({ id: "empty" }) });
    await expect
      .element(
        page.getByText(
          "No recap was created because this session had no file changes. Older Shepherd versions skipped these sessions because there was no diff.",
        ),
      )
      .toBeInTheDocument();
  });

  it("failed recap → names the failure (never a blank success card)", async () => {
    recaps.map = { f1: recap({ sessionId: "f1", state: "failed", headline: "", body: "" }) };
    render(DoneRecapPanel, { session: session({ id: "f1" }) });
    await expect.element(page.getByText("Recap generation failed.")).toBeInTheDocument();
    expect(page.getByText("Shipped the feature").elements().length, "no headline").toBe(0);
  });

  it("failed recap with diagnostics → shows the persisted reason", async () => {
    recaps.map = {
      f2: recap({
        sessionId: "f2",
        state: "failed",
        headline: "Recap skipped: session metadata mismatch",
        body: "The session row points at branch `a`, but the archived worktree was on `b`.",
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "f2" }) });
    await expect.element(page.getByText("Recap generation failed.")).toBeInTheDocument();
    await expect
      .element(page.getByText("Recap skipped: session metadata mismatch"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "The session row points at branch `a`, but the archived worktree was on `b`.",
        ),
      )
      .toBeInTheDocument();
  });

  it("failed recap with a coded skip → renders localized headline + body (evidence w/ PR number)", async () => {
    recaps.map = {
      f3: recap({
        sessionId: "f3",
        state: "failed",
        headline: "", // coded skips leave headline/body empty; the UI derives them per-locale
        body: "",
        skip: {
          code: "ancestry-check-failed",
          params: { evidenceKind: "merged_pr", evidencePr: 12, baseRef: "origin/main" },
        },
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "f3" }) });
    await expect
      .element(page.getByText("Recap skipped: ancestry check failed"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Shepherd found landed-work evidence (merged PR #12), but could not verify whether HEAD is already contained in `origin/main`.",
        ),
      )
      .toBeInTheDocument();
  });

  it("failed recap with a coded skip → merged_pr without a PR number renders 'merged PR' (no #undefined)", async () => {
    recaps.map = {
      f4: recap({
        sessionId: "f4",
        state: "failed",
        headline: "",
        body: "",
        skip: { code: "base-refresh-failed", params: { evidenceKind: "merged_pr" } },
      }),
    };
    render(DoneRecapPanel, { session: session({ id: "f4" }) });
    await expect
      .element(
        page.getByText(
          "Shepherd found landed-work evidence (merged PR), but refreshing the base ref failed, so the empty diff could not be trusted.",
        ),
      )
      .toBeInTheDocument();
  });

  it("missing recap row on a recent session → explains that no reason was recorded", async () => {
    // no entry in recaps.map; finished after recaps shipped → explicit legacy-unknown cause
    render(DoneRecapPanel, { session: session({ id: "missing" }) });
    await expect
      .element(
        page.getByText("No recap record exists for this session; the reason was not recorded."),
      )
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

describe("DoneRecapPanel completion source", () => {
  it("names an operator decommission and marks legacy completion as unknown", async () => {
    recaps.map = { source: recap({ sessionId: "source" }) };
    const { rerender } = await render(DoneRecapPanel, {
      session: session({ id: "source", archiveReason: "operator" }),
    });
    await expect.element(page.getByText("Decommissioned by operator")).toBeInTheDocument();

    await rerender({ session: session({ id: "source", archiveReason: null }) });
    await expect.element(page.getByText("Completion source unknown")).toBeInTheDocument();
  });
});

describe("DoneRecapPanel status bar", () => {
  beforeEach(() => usageResolvers.clear());

  it("pins the status bar while an overflowing body scrolls (constrained height)", async () => {
    recaps.map = {
      pin: recap({
        sessionId: "pin",
        changedFiles: Array.from({ length: 80 }, (_, i) => `src/deep/path/file-${i}.ts`),
      }),
    };
    const { container } = await render(DoneRecapPanel, {
      session: session({ id: "pin", status: "archived", model: "opus" }),
    });
    // Constrain the mount like the Done lens does (flex column of fixed height).
    const mount = container as HTMLElement;
    mount.style.display = "flex";
    mount.style.flexDirection = "column";
    mount.style.height = "300px";
    await expect.element(page.getByText("src/deep/path/file-0.ts")).toBeInTheDocument();

    const panel = mount.querySelector(".done-recap") as HTMLElement;
    const body = mount.querySelector(".dr-body") as HTMLElement;
    const bar = mount.querySelector(".ssb") as HTMLElement;
    expect(bar, "status bar renders").not.toBeNull();
    // The body overflows and owns the scrolling; the panel itself does not scroll.
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(panel.scrollHeight).toBe(panel.clientHeight);
    // The pinned bar sits fully inside the visible panel box.
    const panelRect = panel.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    expect(barRect.bottom).toBeLessThanOrEqual(panelRect.bottom + 1);
    expect(barRect.top).toBeGreaterThanOrEqual(panelRect.top);
    // Scrolling the body must not move the pinned bar.
    body.scrollTop = body.scrollHeight;
    expect(bar.getBoundingClientRect().bottom).toBeCloseTo(barRect.bottom, 0);
  });

  it("drops a stale usage response after switching sessions (A resolves last)", async () => {
    recaps.map = { ua: recap({ sessionId: "ua" }), ub: recap({ sessionId: "ub" }) };
    const { container, rerender } = await render(DoneRecapPanel, {
      session: session({ id: "ua", status: "archived" }),
    });
    // A's request is in flight (unresolved) → placeholder shows.
    expect((container as HTMLElement).querySelector(".ssb-unavailable")).not.toBeNull();

    await rerender({ session: session({ id: "ub", status: "archived" }) });
    usageResolvers.get("ub")!(usageDto(500));
    await expect.element(page.getByText("500 tok")).toBeInTheDocument();

    // A's response arrives LAST — the dead run's alive-guard must drop it.
    usageResolvers.get("ua")!(usageDto(999_999));
    await new Promise((r) => setTimeout(r, 20));
    await expect.element(page.getByText("500 tok")).toBeInTheDocument();
    expect((container as HTMLElement).textContent).not.toContain("1M tok");
  });
});
