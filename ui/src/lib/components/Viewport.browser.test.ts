import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";

// Mock startPreview so it resolves to "ok" without a backend. All other
// named exports from $lib/api are preserved (getSessionUsage etc. are used
// by subcomponents; they can fail silently under test — existing tests pass
// without mocking them).
// The fn is declared BEFORE vi.mock so vitest's hoisting can close over it.
const startPreviewFn = vi.fn(async () => ({ ok: true as const, command: "npm run dev" }));
const stopPreviewFn = vi.fn(async () => ({ killed: 1 }) as { killed: number } | { notBound: true });
// Rename resolves without a backend so the commit path (renaming → false) runs and
// the popover-reveal commit test can observe the post-rename remount.
const renameSessionFn = vi.fn(async (_id: string, name: string) => ({
  session: session({ id: "renamed", name }),
  branchRenamed: true,
  prRetargeted: false,
}));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    startPreview: startPreviewFn,
    stopPreview: stopPreviewFn,
    renameSession: renameSessionFn,
  };
});

// Component must be imported AFTER the mock is registered.
const { default: Viewport } = await import("./Viewport.svelte");
// Dynamic import AFTER the $lib/api mock: reviews.svelte imports $lib/api, so a static
// (hoisted) import would pull the real module in before the mock registers and break it.
const { reviews, planGates, repoConfig } = await import("$lib/reviews.svelte");
// Dynamic import for same reason: recaps.svelte imports $lib/api via getRecaps.
const { recaps } = await import("$lib/recaps.svelte");
import { toasts } from "$lib/toasts.svelte";
import { m } from "$lib/paraglide/messages";
import type {
  Session,
  BuildQueue,
  Recap,
  PlanGate,
  ReviewVerdict,
  SessionActivity,
} from "$lib/types";

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

function planGate(partial: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: "s1",
    planHash: "h",
    decision: "changes_requested",
    summary: "needs changes",
    body: "body",
    findings: ["tighten scope"],
    round: 1,
    cap: 5,
    approved: false,
    plan: "plan",
    updatedAt: 0,
    ...partial,
  };
}

function reviewVerdict(partial: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "abc",
    decision: "changes_requested",
    summary: "needs changes",
    body: "body",
    findings: ["fix it"],
    addressRound: 1,
    addressCap: 5,
    finalRoundPending: false,
    finalRoundTimeoutMs: 60_000,
    updatedAt: 0,
    ...partial,
  };
}

function activity(summary: string | null): SessionActivity {
  return {
    lastActivityTs: summary ? 1_000 : 0,
    summary,
    recentTs: [],
    recentErrTs: [],
  };
}

// A bubbling touch event with the minimal `touches` shim longPress reads
// (e.touches.length and e.touches[0].clientX/clientY on start/move; nothing off
// touchend). Dispatches touch* only — no synthetic click — so onTitleTap never
// runs from it. Hoisted to module scope: both the page-swipe describe and the
// task-info-reveal describe use it.
function fakeTouch(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", {
    value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
    configurable: true,
  });
  return e;
}

// The Preview tab is driven by a server-fed `previewPort` (single source of truth
// for tab+pane) plus a monotonic `openPreviewTick`/`lastPreviewTick` guard so a
// row's badge click opens the tab without an iframe-load round-trip. The effect
// choreography (open on tick bump, auto-fallback to the terminal when the port
// vanishes, and NOT re-yanking the user on a later null→port flip with no bump)
// is regression-prone, so exercise it through the real component.
describe("Viewport preview tab", () => {
  // view tabs carry role="tab" (tablist a11y), so query them by that role
  const previewTab = () => page.getByRole("tab", { name: "Preview" });

  it("opens the Preview tab + renders the iframe on a badge-click tick bump", async () => {
    const { rerender } = await render(Viewport, {
      session: session({ id: "v1" }),
      previewPort: 8001,
      openPreviewTick: 0,
    });
    // bound port → the tab exists, but nothing opens it until the tick bumps
    await expect.element(previewTab()).toBeInTheDocument();
    await expect.element(previewTab()).not.toHaveClass(/active/);

    // simulate the row's Preview-badge click: a monotonic tick bump
    await rerender({
      session: session({ id: "v1" }),
      previewPort: 8001,
      openPreviewTick: 1,
    });

    await expect.element(previewTab()).toHaveClass(/active/);
    // the pane mounts a cross-origin iframe at the assigned port (URL built from
    // the live origin → host varies in CI, but the :port/ suffix is load-bearing)
    const frame = page.getByTitle("Preview", { exact: true }).element() as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toMatch(/:8001\/$/);
  });

  it("falls back to the terminal tab when the preview port goes null while open", async () => {
    const { rerender } = await render(Viewport, {
      session: session({ id: "v2" }),
      previewPort: 8002,
      openPreviewTick: 1,
    });
    await expect.element(previewTab()).toHaveClass(/active/);

    // dev server stopped / session archived → server drops the port
    await rerender({
      session: session({ id: "v2" }),
      previewPort: null,
      openPreviewTick: 1,
    });

    // the Preview tab itself disappears (gated on hasPreview) and the terminal
    // tab is active again — no stranded dead iframe. exact: the header's redraw
    // toggle ("…terminal text…") would otherwise also match by substring.
    await expect.element(previewTab()).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("tab", { name: "Terminal", exact: true }))
      .toHaveClass(/active/);
  });

  it("does not re-open Preview on a later null→port flip without a fresh tick bump", async () => {
    // open via the initial tick, then the operator navigates away to another tab
    const { rerender } = await render(Viewport, {
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 1,
    });
    await expect.element(previewTab()).toHaveClass(/active/);

    // exact: the open DiffPanel also exposes a "Refresh diff" button whose
    // accessible name otherwise matches; we want the tab button itself.
    const diffTab = page.getByRole("tab", { name: "Diff", exact: true });
    await diffTab.click();
    await expect.element(diffTab).toHaveClass(/active/);

    // port vanishes then returns — same tick (no new badge click). The
    // lastPreviewTick guard must NOT yank the user back to Preview.
    await rerender({
      session: session({ id: "v3" }),
      previewPort: null,
      openPreviewTick: 1,
    });
    await rerender({
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 1,
    });

    // the tab is available again, but the operator stays on Diff
    await expect.element(previewTab()).toBeInTheDocument();
    await expect.element(previewTab()).not.toHaveClass(/active/);
    await expect.element(diffTab).toHaveClass(/active/);

    // and a genuine new badge click (tick bump) still opens it
    await rerender({
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 2,
    });
    await expect.element(previewTab()).toHaveClass(/active/);
  });
});

describe("Viewport task detail tooltip", () => {
  it("shows launch metadata and updates live plan-gate state", async () => {
    const launchMetadata = {
      sourceKind: "user" as const,
      prompt: "build the task tooltip",
      issue: { number: 42, title: "Hover details", url: "https://example.test/42" },
      attachments: [
        {
          submittedName: "mockup.png",
          launchedName: "mockup.png",
          dropped: false,
          storedName: "uuid.png",
        },
        {
          submittedName: "lost-notes.md",
          launchedName: null,
          dropped: true,
          storedName: null,
        },
      ],
      branch: { baseBranch: "main", workBranch: "shepherd/task-tooltip", sharedCheckout: false },
      uiState: {
        researchChecked: false,
        planGateChecked: true,
        autopilotChecked: true,
      },
      submittedChoices: {
        planGateOverride: true,
        autopilotOverride: true,
        sandboxProfile: "autonomous" as const,
        model: "opus",
        effort: "high",
      },
      resolvedLaunch: {
        research: false,
        epicAuthoring: false,
        planGateOptIn: true,
        autopilotOptIn: true,
        storedModel: "opus",
        effort: "high",
        sandboxApplied: "autonomous" as const,
        sandboxDegraded: false,
        egressApplied: true,
        egressDegraded: false,
      },
      agent: { provider: "claude" as const, model: "opus", effort: "high" },
    };
    const initial = session({
      id: "tooltip",
      prompt: "fallback prompt",
      branch: "shepherd/task-tooltip",
      model: "opus",
      effort: "high",
      planGateEnabled: true,
      planPhase: "planning",
      autopilotEnabled: true,
      sandboxApplied: "autonomous",
      egressApplied: true,
      launchMetadata,
    });

    const { rerender } = await render(Viewport, {
      session: initial,
      previewPort: null,
      openPreviewTick: 0,
    });

    await page.getByText("TASK-01").hover();
    const tooltip = page.getByRole("tooltip");
    await expect.element(tooltip).toBeVisible();
    expect(tooltip.element().textContent).toContain("build the task tooltip");
    expect(tooltip.element().textContent).toContain("#42: Hover details");
    expect(tooltip.element().textContent).toContain("mockup.png");
    expect(tooltip.element().textContent).toContain("lost-notes.md");
    expect(tooltip.element().textContent).toContain("Plan gate current");
    expect(tooltip.element().textContent).toContain("Planning");
    expect(tooltip.element().textContent).toContain("Autonomous");
    expect(tooltip.element().textContent).toContain("Egress allowlist");

    await rerender({
      session: session({
        ...initial,
        planPhase: "executing",
      }),
      previewPort: null,
      openPreviewTick: 0,
    });

    await page.getByText("TASK-01").hover();
    expect(page.getByRole("tooltip").element().textContent).toContain("Released");
  });
});

describe("Viewport rename affordances", () => {
  // Several tests below fold/unfold the compact header; headerCollapsed persists
  // to localStorage on every toggleFold, so a prior test's fold would leak into
  // the next mount and invert its "true"→"false" assertions. Reset so every test
  // starts unfolded (mirrors the reset in the swipe-scoping describe block below).
  beforeEach(() => localStorage.removeItem("shepherd-vp-header-collapsed"));

  const headerNameSlug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  it("renders a renamed session name once and double-click opens rename", async () => {
    const { container } = await render(Viewport, {
      session: session({
        id: "rename-head",
        name: "visible session title",
        branch: "shepherd/visible-session-title",
      }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const header = container.querySelector<HTMLElement>(".vp-head:not(.mobile)");
    expect(header, "normal desktop header").not.toBeNull();
    const title = header!.querySelector<HTMLElement>(".vp-name");
    expect(title, "normal desktop header title").not.toBeNull();
    expect(title!.textContent).toBe("visible session title");
    expect(header!.querySelector(".vp-name + .sep")).toBeNull();

    const visibleIdentityNodes = Array.from(
      header!.querySelectorAll<HTMLElement>(".vp-name, .branch"),
    );
    expect(
      visibleIdentityNodes.filter(
        (node) => headerNameSlug(node.textContent ?? "") === "visible-session-title",
      ),
    ).toHaveLength(1);
    expect(header!.querySelector<HTMLElement>(".branch")?.textContent).not.toBe(
      "visible-session-title",
    );

    title!.click();
    title!.click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    expect((input.element() as HTMLInputElement).value).toBe("visible session title");
  });

  it("keeps a distinct normal desktop branch label visible", async () => {
    const { container } = await render(Viewport, {
      session: session({
        id: "rename-branch",
        name: "visible session title",
        branch: "feature/actual-work",
      }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const header = container.querySelector<HTMLElement>(".vp-head:not(.mobile)");
    expect(header, "normal desktop header").not.toBeNull();
    expect(header!.querySelector<HTMLElement>(".vp-name")?.textContent).toBe(
      "visible session title",
    );
    expect(header!.querySelector<HTMLElement>(".vp-name + .sep")).not.toBeNull();
    expect(header!.querySelector<HTMLElement>(".branch")?.textContent).toBe("feature/actual-work");
  });

  it("desktop single-tap on the title toggles the git rail instantly", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "toggle-head", name: "toggle title" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const header = container.querySelector<HTMLElement>(".vp-head:not(.mobile)");
    expect(header, "normal desktop header").not.toBeNull();
    // rail closed at rest on desktop
    expect(container.querySelector(".vp-git-strip")).toBeNull();

    header!.querySelector<HTMLElement>(".vp-name")!.click();
    await expect.poll(() => container.querySelector(".vp-git-strip")).not.toBeNull();
  });

  it("double-tap renames and restores the rail to its pre-rename state", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "toggle-rename", name: "toggle rename title" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const header = container.querySelector<HTMLElement>(".vp-head:not(.mobile)");
    const title = header!.querySelector<HTMLElement>(".vp-name");
    // two taps inside the double-tap window: tap 1 opens the rail, tap 2 undoes
    // that and opens rename → the rail returns to closed, no lingering toggle
    title!.click();
    title!.click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    expect(container.querySelector(".vp-git-strip")).toBeNull();
  });

  it("touch-desktop single tap folds the header instantly", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "touch-fold", name: "touch fold title" }),
      touch: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    const fold = container.querySelector<HTMLElement>(".vp-fold");
    expect(fold, "header fold button").not.toBeNull();
    expect(fold!.getAttribute("aria-expanded")).toBe("true");

    const title = container.querySelector<HTMLElement>(".vp-name");
    expect(title, "touch-desktop title").not.toBeNull();
    title!.click();

    await expect.poll(() => fold!.getAttribute("aria-expanded")).toBe("false");
  });

  it("touch-desktop double-tap renames and restores the fold", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "touch-fold-rename", name: "touch fold rename title" }),
      touch: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    const fold = container.querySelector<HTMLElement>(".vp-fold");
    expect(fold, "header fold button").not.toBeNull();

    const title = container.querySelector<HTMLElement>(".vp-name");
    // two taps inside the double-tap window: tap 1 folds the header, tap 2 undoes
    // that and opens rename → the fold returns to unfolded, no lingering toggle
    title!.click();
    title!.click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    // .vp-actions (which contains .vp-fold) is display:none while compact+renaming,
    // so assert the attribute value, not element visibility.
    expect(fold!.getAttribute("aria-expanded")).toBe("true");
  });

  it("touch-desktop double-tap restores the pre-fold tab, not just term", async () => {
    // Both double-tap tests above start (and stay) on the default "term" tab,
    // so `tab = preFoldTab` is a no-op there — the restore itself is never
    // asserted. Switch to a non-terminal tab first so the undo path is
    // actually exercised: toggleFold() forces tab="term" on fold, so a naive
    // "call toggleFold() twice" undo would leave the tab on "term" instead of
    // restoring it.
    const { container } = await render(Viewport, {
      session: session({ id: "touch-fold-tab-restore", name: "touch tab restore title" }),
      touch: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    const activityTab = page.getByRole("tab", { name: "Activity", exact: true });
    await activityTab.click();
    await expect.element(activityTab).toHaveClass(/active/);

    const title = container.querySelector<HTMLElement>(".vp-name");
    expect(title, "touch-desktop title").not.toBeNull();
    // two taps inside the double-tap window: tap 1 folds the header (forcing
    // tab back to "term" internally), tap 2 undoes the fold — which must
    // restore the pre-tap tab (Activity), not leave it on "term" — and opens
    // rename.
    title!.click();
    title!.click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    await expect.element(activityTab).toHaveClass(/active/);
  });

  it("clicking the relocated git-toggle chip toggles the rail with aria-expanded", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "toggle-chip", name: "chip title" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const header = container.querySelector<HTMLElement>(".vp-head:not(.mobile)");
    const toggle = header!.querySelector<HTMLElement>(".git-toggle");
    expect(toggle, "git-toggle chip").not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".vp-git-strip")).toBeNull();

    toggle!.click();
    await expect.poll(() => container.querySelector(".vp-git-strip")).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  });

  it("phone single tap folds the header", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "phone-fold", name: "phone fold title" }),
      mobile: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    const fold = container.querySelector<HTMLElement>(".vp-fold");
    expect(fold, "header fold button").not.toBeNull();
    expect(fold!.getAttribute("aria-expanded")).toBe("true");

    const trigger = container.querySelector<HTMLElement>(".vp-head.mobile .ctx-trigger");
    expect(trigger, "mobile ctx-trigger").not.toBeNull();
    trigger!.click();

    await expect.poll(() => fold!.getAttribute("aria-expanded")).toBe("false");
  });

  it("mobile double-tap on the title still renames (folds then undoes, not a rail toggle)", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "toggle-mobile", name: "mobile title" }),
      mobile: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    const trigger = container.querySelector<HTMLElement>(".vp-head.mobile .ctx-trigger");
    expect(trigger, "mobile ctx-trigger").not.toBeNull();
    trigger!.click();
    trigger!.click();

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
  });

  it("opens rename only for matching targeted requests", async () => {
    const { rerender } = await render(Viewport, {
      session: session({ id: "rename-target", name: "target title" }),
      previewPort: null,
      openPreviewTick: 0,
      renameRequest: { id: "other", tick: 1 },
    });

    await expect
      .element(page.getByRole("textbox", { name: m.viewport_rename_aria() }))
      .not.toBeInTheDocument();

    await rerender({
      session: session({ id: "rename-target", name: "target title" }),
      previewPort: null,
      openPreviewTick: 0,
      renameRequest: { id: "rename-target", tick: 2 },
    });

    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    expect((input.element() as HTMLInputElement).value).toBe("target title");
  });
});

// ── Start-preview re-entrancy guard ──────────────────────────────────────────
// Regression: the original code used $state<Set<string>> which Svelte 5 does
// NOT proxy, so .add()/.delete() never triggered reactivity and the disabled
// guard never engaged in the DOM. The fix collapses to a single SvelteMap whose
// .has() is reactive. This test asserts the guard actually disables the button.
describe("Viewport preview start — re-entrancy guard", () => {
  it("disables the Start button after a successful start (isPreviewStartPending)", async () => {
    startPreviewFn.mockImplementation(
      () =>
        new Promise((resolve) =>
          // Resolve after a short delay so the pending flag is live while we check.
          setTimeout(() => resolve({ ok: true, command: "npm run dev" }), 50),
        ),
    );

    render(Viewport, {
      session: session({ id: "rg1", status: "idle" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const startBtn = page.getByRole("button", { name: /Start dev server/i });
    await expect.element(startBtn).toBeInTheDocument();
    expect((startBtn.element() as HTMLButtonElement).disabled).toBe(false);

    // Click — startPreview is in flight but hasn't resolved yet.
    await startBtn.click();

    // The button must be disabled immediately after the click (flag set on {ok}).
    // Wait for the mock to resolve (flag is set in setPreviewPending after {ok}).
    await vi.waitFor(() =>
      expect(
        (startBtn.element() as HTMLButtonElement).disabled,
        "Start button disabled while pending",
      ).toBe(true),
    );
  });
});

// ── Stop-preview confirmation resolves per-session, not per-focused-unit ──────
// Regression: the success/timeout resolution must key off the authoritative
// per-session preview map (the whole store.preview record), NOT the single focused
// `previewPort`. Otherwise stopping unit A then navigating to unit B before the
// sweep clears A's port strands A's pending entry — its 15s timer then fires a FALSE
// "couldn't stop" warning on an actually-successful stop. The fix captures A's name
// at stop time and resolves it when A's entry clears in `previewMap`, whatever unit
// is currently focused.
describe("Viewport preview stop — per-session pending resolution", () => {
  it("confirms a stop after navigating to another unit, with the right name and no false warning", async () => {
    stopPreviewFn.mockResolvedValue({ killed: 1 });
    const infoSpy = vi.spyOn(toasts, "info");

    const base = {
      previewHost: null,
      openPreviewTick: 1, // open the Preview tab so the pane (+ Stop button) mounts
    };

    // Render unit A ("task one") with a live preview, tab open.
    const { rerender } = await render(Viewport, {
      session: session({ id: "A", name: "task one", status: "idle" }),
      previewPort: 8001,
      previewMap: { A: 8001 },
      ...base,
    });

    // Two-step arm: first click arms ("Confirm stop?"), second confirms. Use a
    // direct DOM .click() (not a pointer click): the cramped test viewport overlaps
    // the footer button with sibling chrome, so a coordinate click lands on the
    // wrong element — a layout artifact of the tiny harness, not a real-app bug
    // (the preview pane is full-size in situ). We're exercising resolution logic.
    const stopBtn = page.getByRole("button", { name: /stop dev server/i });
    await expect.element(stopBtn).toBeInTheDocument();
    (stopBtn.element() as HTMLButtonElement).click();
    const confirmBtn = page.getByRole("button", { name: /confirm stop/i });
    await expect.element(confirmBtn).toBeInTheDocument();
    (confirmBtn.element() as HTMLButtonElement).click();

    // killed > 0 → a neutral "stopping" toast, and the stop is now pending for A.
    await vi.waitFor(() =>
      expect(infoSpy.mock.calls.some(([text]) => /stopping/i.test(String(text)))).toBe(true),
    );
    infoSpy.mockClear();

    // Operator navigates to unit B ("task two") BEFORE the sweep clears A's port.
    // Then the sweep clears A's port: previewMap drops A. (B remains bound.)
    await rerender({
      session: session({ id: "B", name: "task two", status: "idle" }),
      previewPort: 8002,
      previewMap: { B: 8002 },
      ...base,
    });

    // Success toast fires for A — naming "task one" (captured at stop time), NOT the
    // now-focused "task two" — and NO assertive warning toast is raised.
    await vi.waitFor(() =>
      expect(infoSpy.mock.calls.some(([text]) => /task one/.test(String(text)))).toBe(true),
    );
    expect(infoSpy.mock.calls.some(([text]) => /task two/.test(String(text)))).toBe(false);
    expect(
      infoSpy.mock.calls.some(([, opts]) => (opts as { alert?: boolean } | undefined)?.alert),
      "no assertive warning toast on a successful stop",
    ).toBe(false);

    infoSpy.mockRestore();
  });
});

// In the Viewport header the autopilot badge (NEEDS YOU / DELIVERED) can co-exist on
// screen with the GitRail's in-flight REVIEWING indicator. Precedence mirrors the cards:
// REVIEWING wins, so the header badge is suppressed while a critic review is in flight.
describe("Viewport autopilot badge vs in-flight review", () => {
  beforeEach(() => {
    reviews.reviewing = {};
  });

  // Target the badge by its role="img" + aria-label, NOT getByText: the keynav hint
  // ("g needs you") substring-matches the label and would mask the real badge.
  const badge = () =>
    page.getByRole("img", { name: m.session_autopilot_paused_label(), exact: true });

  it("shows NEEDS YOU when no review is in flight", async () => {
    render(Viewport, {
      session: session({ id: "vr-ctl", autopilotPaused: true }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.element(badge()).toBeInTheDocument();
  });

  it("suppresses NEEDS YOU while a critic review is in flight (REVIEWING wins)", async () => {
    reviews.setReviewing("vr-rev", true);
    render(Viewport, {
      session: session({ id: "vr-rev", autopilotPaused: true }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.element(badge()).not.toBeInTheDocument();
  });
});

describe("Viewport review banner — reflow guarantee (no prompt overlap)", () => {
  function clearReviewState() {
    reviews.map = {};
    reviews.reviewing = {};
    reviews.activity = {};
    planGates.map = {};
    planGates.reviewing = {};
    planGates.activity = {};
  }
  beforeEach(clearReviewState);
  afterEach(clearReviewState);

  // The literal reported bug: in a short terminal the tall banner overlaid the CLI prompt.
  // The banner caps its height (max-height: min(50%, 100% - 4rem)) so it leaves ≥ 4rem for
  // the terminal; .term-mount (= 100% - --review-banner-h, floored at 4rem) then reflows fully
  // ABOVE it — keeping its 4rem floor and never extending under the banner. Rendered at a short
  // terminal height where the banner's natural (uncapped) height would otherwise force the
  // reserve under its floor and overlap the prompt.
  it("caps the in-flight banner so .term-mount keeps its 4rem floor and never overlaps it", async () => {
    const id = "vr-overlap";
    planGates.applyReviewing(id, true);
    planGates.setActivity(id, "read .shepherd-plan.md");

    render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      activity: activity("read .shepherd-plan.md"),
      previewPort: null,
      openPreviewTick: 0,
    });
    const banner = () => document.querySelector<HTMLElement>(".review-banner");
    await vi.waitFor(() => expect(banner()).not.toBeNull());
    // Force a SHORT terminal (well above .vp-body's 4rem floor) so the cap has to engage.
    // Resize the Viewport's mount div (its height:100% root fills it); read it off the DOM
    // because render()'s typed result varies by version.
    const host = document.querySelector<HTMLElement>(".viewport")!.parentElement as HTMLElement;
    host.style.height = "320px";

    const mount = document.querySelector<HTMLElement>(".term-mount")!;
    expect(mount, ".term-mount should render").not.toBeNull();
    const vpBody = document.querySelector<HTMLElement>(".vp-body")!;
    const fourRem = 4 * parseFloat(getComputedStyle(document.documentElement).fontSize);

    await vi.waitFor(() => {
      const vpH = vpBody.getBoundingClientRect().height;
      const b = banner()!.getBoundingClientRect();
      const m = mount.getBoundingClientRect();
      // Reflow guarantee: the banner leaves at least a 4rem terminal (banner ≤ vp-body - 4rem).
      expect(b.height).toBeLessThanOrEqual(vpH - fourRem + 0.5);
      // → .term-mount keeps its 4rem floor …
      expect(m.height).toBeGreaterThanOrEqual(fourRem - 0.5);
      // … and never extends under the banner (the prompt is never overlaid).
      expect(m.bottom).toBeLessThanOrEqual(b.top + 0.5);
    });
  });
});

describe("Viewport active REWORK terminal strip", () => {
  function clearReviewState() {
    reviews.map = {};
    reviews.reviewing = {};
    reviews.activity = {};
    planGates.map = {};
    planGates.reviewing = {};
  }

  beforeEach(clearReviewState);
  afterEach(clearReviewState);

  function bannerHeight(container: HTMLElement): number {
    const body = container.querySelector<HTMLElement>(".vp-body");
    expect(body, ".vp-body should render").not.toBeNull();
    return parseFloat(body!.style.getPropertyValue("--review-banner-h"));
  }

  it("shows active plan-gate rework with round/cap, cog, activity summary, and reserved terminal height", async () => {
    const id = "rw-plan-active";
    planGates.map = { [id]: planGate({ sessionId: id, round: 1, cap: 5 }) };

    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      activity: activity("edited .shepherd-plan.md"),
      previewPort: null,
      openPreviewTick: 0,
    });

    await expect
      .element(page.getByText("REWORK · 1/5 · edited .shepherd-plan.md"))
      .toBeInTheDocument();
    expect(
      container.querySelector(".review-banner .rb-cog"),
      "rotating cog renders",
    ).not.toBeNull();
    await vi.waitFor(() =>
      expect(
        bannerHeight(container),
        "--review-banner-h reserves the strip height",
      ).toBeGreaterThan(0),
    );
  });

  it("hides parked plan-gate rework", async () => {
    const id = "rw-plan-parked";
    planGates.map = { [id]: planGate({ sessionId: id, round: 1, cap: 5 }) };

    const { container } = await render(Viewport, {
      session: session({ id, status: "blocked", planPhase: "planning" }),
      activity: activity("edited .shepherd-plan.md"),
      previewPort: null,
      openPreviewTick: 0,
    });

    expect(container.querySelector(".review-banner"), "no bottom strip while parked").toBeNull();
  });

  it("shows active PR-critic rework with source-file activity summary", async () => {
    const id = "rw-critic-active";
    reviews.map = {
      [id]: reviewVerdict({ sessionId: id, addressRound: 1, addressCap: 5 }),
    };

    render(Viewport, {
      session: session({ id, status: "running", planPhase: "executing" }),
      activity: activity("edited Viewport.svelte"),
      previewPort: null,
      openPreviewTick: 0,
    });

    await expect
      .element(page.getByText("REWORK · 1/5 · edited Viewport.svelte"))
      .toBeInTheDocument();
  });

  it("hides parked PR-critic rework", async () => {
    const id = "rw-critic-parked";
    reviews.map = {
      [id]: reviewVerdict({ sessionId: id, addressRound: 1, addressCap: 5 }),
    };

    const { container } = await render(Viewport, {
      session: session({ id, status: "done", planPhase: "executing" }),
      activity: activity("edited Viewport.svelte"),
      previewPort: null,
      openPreviewTick: 0,
    });

    expect(container.querySelector(".review-banner"), "no bottom strip while parked").toBeNull();
  });

  it("shows phase-specific fallback text when activity has no summary", async () => {
    const id = "rw-plan-fallback";
    planGates.map = { [id]: planGate({ sessionId: id, round: 2, cap: 5 }) };

    render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      activity: activity(null),
      previewPort: null,
      openPreviewTick: 0,
    });

    await expect.element(page.getByText("REWORK · 2/5 · revising the plan")).toBeInTheDocument();
  });

  it("does not stack active rework under an in-flight review", async () => {
    const id = "rw-review-wins";
    planGates.map = { [id]: planGate({ sessionId: id, round: 1, cap: 5 }) };
    planGates.applyReviewing(id, true);

    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      activity: activity("edited .shepherd-plan.md"),
      previewPort: null,
      openPreviewTick: 0,
    });

    await expect.element(page.getByText(m.reviewbanner_calm())).toBeInTheDocument();
    expect(container.querySelector(".review-banner")?.textContent).not.toContain("REWORK ·");
    expect(container.querySelectorAll(".review-banner")).toHaveLength(1);
  });

  it("suppresses CI while active rework owns the shared strip", async () => {
    const id = "rw-ci-suppressed";
    reviews.map = {
      [id]: reviewVerdict({ sessionId: id, addressRound: 1, addressCap: 5 }),
    };

    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "executing" }),
      activity: activity("edited Viewport.svelte"),
      git: {
        kind: "github",
        state: "open",
        number: 12,
        url: "https://example.test/pr/12",
        checks: "pending",
        deployConfigured: false,
        runningChecks: ["verify / test"],
      },
      previewPort: null,
      openPreviewTick: 0,
    });

    await expect
      .element(page.getByText("REWORK · 1/5 · edited Viewport.svelte"))
      .toBeInTheDocument();
    expect(container.querySelectorAll(".review-banner")).toHaveLength(1);
    expect(container.querySelector(".ci-banner"), "CI strip is suppressed").toBeNull();
    await vi.waitFor(() => expect(bannerHeight(container)).toBeGreaterThan(0));
  });
});

// ── Mobile page-swipe is scoped to the terminal/panel body (allow-list) ───────
// Regression: the horizontal "switch task side-by-side" swipe used to arm for ANY
// touch outside a small deny-set, so a drag starting on the top chrome (header/tabs,
// the PR/automations/autopilot git strip, the build-queue panel) hijacked the
// gesture and the buttons there were unreachable. The fix arms the swipe ONLY when
// the touch starts inside `.vp-body` (tagged data-swipe-page); all chrome is excluded
// by omission. The handler reads e.touches[0].clientX/clientY on start/move and
// nothing off touchend, so we dispatch bubbling Events with a `touches` shim.
describe("Viewport mobile page-swipe scoping", () => {
  // The structural-invariant test below assumes the header is expanded so
  // `.vp-git-strip` / `.bqp` render; clear the persisted collapse flag so a prior
  // test can't leave it set ("1").
  beforeEach(() => localStorage.removeItem("shepherd-vp-header-collapsed"));

  // The swipe listeners live on the `.viewport` root and read e.target via closest();
  // the module-scope `fakeTouch` carries our chosen target up to that root listener.

  // A leftward drag with a large dx clears the axis slop and the commit threshold
  // (Math.min(120, width*0.33)), committing to "next" → onnavigate(switchOrder[1]).
  function leftwardDrag(el: Element) {
    el.dispatchEvent(fakeTouch("touchstart", 300, 100));
    el.dispatchEvent(fakeTouch("touchmove", 0, 100));
    el.dispatchEvent(fakeTouch("touchend", 0, 100));
  }

  const oneStepQueue = (sessionId: string): BuildQueue => ({
    sessionId,
    approved: false,
    steps: [{ id: "s1", title: "step one", status: "pending", position: 0 }],
  });

  function renderMobile(onnavigate: (id: string) => void) {
    return render(Viewport, {
      session: session({ id: "v1" }),
      mobile: true,
      switchOrder: ["v1", "v2"],
      onnavigate,
      buildQueue: oneStepQueue("v1"),
      previewPort: null,
      openPreviewTick: 0,
    });
  }

  it("pages to the next agent on a leftward drag inside the terminal body", async () => {
    const onnavigate = vi.fn();
    const { container } = await renderMobile(onnavigate);

    const body = container.querySelector(".vp-body");
    expect(body, ".vp-body should render").not.toBeNull();
    // drag on the terminal mount (a child of .vp-body), as a real touch would land
    const mount = body!.querySelector(".term-mount") ?? body!;
    leftwardDrag(mount);

    expect(onnavigate).toHaveBeenCalledTimes(1);
    expect(onnavigate).toHaveBeenCalledWith("v2");
  });

  it("does NOT page when the same drag starts on the header chrome (.vp-head)", async () => {
    const onnavigate = vi.fn();
    const { container } = await renderMobile(onnavigate);

    const head = container.querySelector(".vp-head");
    expect(head, ".vp-head should render").not.toBeNull();
    leftwardDrag(head!);

    expect(onnavigate).not.toHaveBeenCalled();
  });

  it("tags only .vp-body with data-swipe-page; all top chrome is outside the allow-list", async () => {
    const onnavigate = vi.fn();
    const { container } = await renderMobile(onnavigate);

    const body = container.querySelector(".vp-body");
    expect(body, ".vp-body should render").not.toBeNull();
    // .vp-body itself carries the allow-list marker, and its terminal mount resolves to it
    expect(body!.matches("[data-swipe-page]")).toBe(true);
    expect(body!.querySelector(".term-mount")?.closest("[data-swipe-page]")).toBe(body);

    // each chrome container renders and is OUTSIDE the page-swipe allow-list
    for (const sel of [".vp-head", ".vp-git-strip", ".bqp"]) {
      const el = container.querySelector(sel);
      expect(el, `${sel} should render`).not.toBeNull();
      expect(
        el!.closest("[data-swipe-page]"),
        `${sel} must not be inside data-swipe-page`,
      ).toBeNull();
    }
  });

  it("does NOT page when a drag starts on a [data-swipe-ignore] surface inside the body", async () => {
    const onnavigate = vi.fn();
    const { container } = await renderMobile(onnavigate);

    const body = container.querySelector(".vp-body");
    expect(body, ".vp-body should render").not.toBeNull();
    // stand in for DiffFileBlock's horizontally-scrollable `.hunks`: an in-body
    // surface that opts out so a sideways drag scrolls it instead of paging agents
    const optOut = document.createElement("div");
    optOut.setAttribute("data-swipe-ignore", "");
    body!.appendChild(optOut);
    // it IS inside the allow-list, so only the within-body deny check can suppress
    // paging — this isolates that branch (distinct from the out-of-body chrome case)
    expect(optOut.closest("[data-swipe-page]")).toBe(body);

    leftwardDrag(optOut);

    expect(onnavigate).not.toHaveBeenCalled();
  });
});

// ── Armed decommission icon-only: solid red fill, no "?" adornment (#776 fix) ──
// Regression guard: the three icon-only decom buttons must NOT render a
// .decom-confirm child when armed, and the armed button must have a solid red
// background (not the faint tint of .decom.armed, which is overridden by
// .decom.icon-btn.armed for the icon-only forms).
describe("Viewport armed decommission icon-only rendering", () => {
  it("armed compact decom button has no .decom-confirm child and has solid red background", async () => {
    // mobile=true + readyToMerge=false → the git-strip icon-only decom button renders.
    // Viewport.svelte CSS is scoped; app.css (imported at test top) provides tokens.
    const { container } = await render(Viewport, {
      session: session({ id: "dc-compact", readyToMerge: false }),
      mobile: true,
      previewPort: null,
      openPreviewTick: 0,
    });

    // Find the compact decom button
    const decomBtn = container.querySelector<HTMLButtonElement>("button.decom.icon-btn.compact");
    expect(decomBtn, "compact decom button should render").not.toBeNull();

    // Pre-arm: no .decom-confirm child
    expect(decomBtn!.querySelector(".decom-confirm"), "no .decom-confirm before arming").toBeNull();

    // Arm it: direct DOM click (same pattern as stop-preview test above)
    decomBtn!.click();

    // Wait for Svelte reactivity to settle and the .armed class to appear
    await vi.waitFor(() =>
      expect(decomBtn!.classList.contains("armed"), "button gains .armed class after click").toBe(
        true,
      ),
    );

    // After arming: still no .decom-confirm child (the "?" adornment must not exist)
    expect(decomBtn!.querySelector(".decom-confirm"), "no .decom-confirm after arming").toBeNull();

    // Armed state CSS: background resolves to --color-red (solid fill).
    // Resolve the token value by probing a temp element with color: var(--color-red).
    const probe = document.createElement("div");
    probe.style.color = "var(--color-red)";
    document.body.appendChild(probe);
    const expectedRgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);

    // Assert the token actually resolved — fail loudly if the test environment is
    // misconfigured (rather than silently skipping the solid-fill assertion).
    expect(
      expectedRgb && expectedRgb !== "rgba(0, 0, 0, 0)" && expectedRgb !== "",
      "--color-red must resolve to a real color in the test environment",
    ).toBe(true);
    // Wait for the 0.12s CSS transition to complete before sampling the computed style.
    await vi.waitFor(
      () => {
        const bg = getComputedStyle(decomBtn!).backgroundColor;
        expect(bg, "armed icon-btn decom background is solid --color-red").toBe(expectedRgb);
      },
      { timeout: 500 },
    );
  });

  it("armed quiet desktop decom button has no .decom-confirm child", async () => {
    // compact=false + readyToMerge=false → the desktop quiet icon-only decom button
    const { container } = await render(Viewport, {
      session: session({ id: "dc-quiet", readyToMerge: false }),
      previewPort: null,
      openPreviewTick: 0,
    });

    const decomBtn = container.querySelector<HTMLButtonElement>("button.decom.quiet.icon-btn");
    expect(decomBtn, "quiet decom button should render").not.toBeNull();

    // Arm it
    decomBtn!.click();

    // Wait for .armed class
    await vi.waitFor(() =>
      expect(decomBtn!.classList.contains("armed"), "quiet button gains .armed after click").toBe(
        true,
      ),
    );

    expect(
      decomBtn!.querySelector(".decom-confirm"),
      "no .decom-confirm after arming quiet form",
    ).toBeNull();
  });
});

// ── Activity tab A/B switch: live feed vs inline recap ────────────────────────
// The Activity tab shows ActivityFeed while the session is running (even if a
// recap exists), and switches to the inline SessionRecap once the session is
// settled (idle/done) AND the recap state is "ready". The bottom SessionRecap
// card is suppressed on the Activity tab so the recap never shows twice.
describe("Viewport Activity tab A/B switch", () => {
  const readyRecap = (sessionId: string): Recap => ({
    sessionId,
    state: "ready",
    headSha: "abc123",
    verdict: "ready",
    headline: "Inline recap body",
    body: "recap body text",
    openItems: [],
    changedFiles: [],
    spawnSessionId: "sp1",
    cwd: "/repo/a",
    model: null,
    spawnedAt: 0,
    generatedAt: 1000,
    updatedAt: 1000,
    blocks: [],
  });

  beforeEach(() => {
    // clear the recaps store between tests
    recaps.map = {};
  });

  it("settled (idle) + ready recap: shows inline recap, bottom card suppressed", async () => {
    const id = "ar-idle";
    recaps.map = { [id]: readyRecap(id) };

    const { container } = await render(Viewport, {
      session: session({ id, status: "idle" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    // Click the Activity tab
    const activityTab = page.getByRole("tab", { name: "Activity", exact: true });
    await expect.element(activityTab).toBeInTheDocument();
    await activityTab.click();
    await expect.element(activityTab).toHaveClass(/active/);

    // Inline recap headline must appear
    await expect.element(page.getByText("Inline recap body")).toBeInTheDocument();

    // Bottom collapsed-card toggle must NOT exist on the Activity tab:
    // the non-inline SessionRecap renders a button.recap-header; it must be absent.
    const bottomCard = container.querySelector("button.recap-header");
    expect(bottomCard, "bottom recap card toggle absent on Activity tab").toBeNull();
  });

  it("running + ready recap: shows live feed, NOT the inline recap", async () => {
    const id = "ar-running";
    recaps.map = { [id]: readyRecap(id) };

    const { container } = await render(Viewport, {
      session: session({ id, status: "running" }),
      previewPort: null,
      openPreviewTick: 0,
    });

    // Click the Activity tab
    const activityTab = page.getByRole("tab", { name: "Activity", exact: true });
    await activityTab.click();
    await expect.element(activityTab).toHaveClass(/active/);

    // The live feed must be present (.activity-feed-fill wrapper)
    await vi.waitFor(() => {
      const feedEl = container.querySelector(".activity-feed-fill");
      expect(feedEl, "activity-feed-fill should render while running").not.toBeNull();
    });

    // The inline recap headline must NOT appear
    expect(
      container.querySelector(".activity-recap-fill"),
      "activity-recap-fill absent while running",
    ).toBeNull();
  });
});

// ── Phone back control glyph (two-left-chevron regression) ────────────────────
// On phone the .back control collapses from the desktop "‹ Herd" text to a bare
// glyph. It must NOT be the left chevron "‹" — that made it visually identical to
// the adjacent needs-you pager's prev button (also "‹"), yielding two ambiguous
// left chevrons. It renders as the list glyph "☰" (back to the herd list), which
// the pager never uses. The .back button only mounts when `onback` is supplied.
// ── Terminal dim while a review runs off-screen (in-flight tier only) ─────────
// The ReviewInFlightBanner binds out an `inflight` signal that is true ONLY on its in-flight
// tier (a review runs in a separate worktree/PTY; this session's PTY is idle). Viewport uses it
// to dim .term-mount (visual-only "hands off"). It must NOT dim during addressing (agent works
// in THIS PTY), conclusion (review done), or when the critic banner is suppressed (auto-address
// off). Verified for both Plan-Gate and Critic.
describe("Viewport terminal dim on in-flight review", () => {
  function clearReviewState() {
    reviews.map = {};
    reviews.reviewing = {};
    reviews.activity = {};
    planGates.map = {};
    planGates.reviewing = {};
    planGates.activity = {};
    repoConfig.autoAddress = {};
  }
  beforeEach(clearReviewState);
  afterEach(clearReviewState);

  const termDimmed = (container: HTMLElement) =>
    container.querySelector(".term-mount")?.classList.contains("reviewing");

  it("plan-gate in-flight: dims the terminal", async () => {
    const id = "dim-plan";
    planGates.applyReviewing(id, true);
    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.element(page.getByText(m.reviewbanner_calm())).toBeInTheDocument();
    await expect.poll(() => termDimmed(container)).toBe(true);
  });

  it("critic in-flight (auto-address on): dims the terminal", async () => {
    const id = "dim-critic";
    repoConfig.autoAddress = { "/repo/a": true };
    reviews.setReviewing(id, true);
    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "executing" }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.element(page.getByText(m.reviewbanner_calm())).toBeInTheDocument();
    await expect.poll(() => termDimmed(container)).toBe(true);
  });

  it("addressing phase: does NOT dim (agent works in this PTY)", async () => {
    const id = "dim-addressing";
    planGates.map = { [id]: planGate({ sessionId: id, round: 1, cap: 5 }) };
    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      activity: activity("edited .shepherd-plan.md"),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect
      .element(page.getByText("REWORK · 1/5 · edited .shepherd-plan.md"))
      .toBeInTheDocument();
    expect(termDimmed(container)).toBe(false);
  });

  it("critic in-flight with auto-address OFF: banner suppressed, so NO dim", async () => {
    const id = "dim-critic-off";
    repoConfig.autoAddress = { "/repo/a": false };
    reviews.setReviewing(id, true);
    const { container } = await render(Viewport, {
      session: session({ id, status: "idle", planPhase: "executing" }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.poll(() => container.querySelector(".review-banner")).toBeNull();
    expect(termDimmed(container)).toBe(false);
  });

  it("conclusion phase: does NOT dim once the verdict lands", async () => {
    const id = "dim-conclusion";
    planGates.applyReviewing(id, true);
    const { container } = await render(Viewport, {
      session: session({ id, status: "running", planPhase: "planning" }),
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.poll(() => termDimmed(container)).toBe(true); // in-flight → dimmed
    // land an approved verdict and end the review → the brief conclusion tier
    planGates.map = {
      [id]: planGate({
        sessionId: id,
        decision: "approved",
        approved: true,
        round: 0,
        findings: [],
      }),
    };
    planGates.applyReviewing(id, false);
    await expect
      .poll(() => container.querySelector(".review-banner")?.getAttribute("data-phase"))
      .toBe("conclusion");
    expect(termDimmed(container)).toBe(false);
  });
});

describe("Viewport phone back glyph", () => {
  it("phone back control renders the list glyph ☰, not the left chevron ‹", async () => {
    const { container } = await render(Viewport, {
      session: session({ id: "back-glyph" }),
      mobile: true,
      onback: vi.fn(),
      previewPort: null,
      openPreviewTick: 0,
    });

    const back = container.querySelector(".back");
    expect(back, ".back control should render on phone when onback is supplied").not.toBeNull();
    const glyph = back!.textContent?.trim();
    expect(glyph, "phone back glyph is the list glyph").toBe("☰");
    expect(glyph, "phone back glyph must not be the left chevron").not.toBe("‹");
  });
});

// ── task-info popover reveal (tap-and-hold on touch; hover/keyboard-focus on
// desktop) ──────────────────────────────────────────────────────────────────
// Runs against real Chromium (vite.config: provider playwright()), so every
// locator action moves a genuine pointer. The reveal is driven from component
// state (.desig-wrap.meta-open .desig-pop), not CSS :hover/:focus-within.
describe("Viewport task info reveal", () => {
  // Park the shared real Playwright cursor in a neutral corner before each test so a
  // stray pointerenter can't set hoverOpen when a component renders/updates under
  // where the cursor happens to sit (prior describes move it via .hover()/.click()).
  // hoverOpen is otherwise driven only by explicit synthetic pointer events here.
  beforeEach(async () => {
    localStorage.removeItem("shepherd-vp-header-collapsed");
    const park = document.createElement("div");
    park.style.cssText = "position:fixed;bottom:0;right:0;width:2px;height:2px;z-index:99999";
    document.body.appendChild(park);
    await userEvent.hover(park);
    park.remove();
  });

  const POINTER_FOCUS_MS = 600;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // small settle so a state→class→CSS reactive update has flushed before a
  // *negative* assertion (a positive one uses expect.poll to wait).
  const settle = () => delay(60);

  // .desig-pop is always in the DOM (display:none when hidden), so read its
  // computed display rather than relying on role resolution of a hidden node.
  const popDisplay = (c: Element) => {
    const pop = c.querySelector<HTMLElement>(".desig-pop");
    return pop ? getComputedStyle(pop).display : "absent";
  };
  const isOpen = (c: Element) => popDisplay(c) === "flex";

  // longPress uses a REAL 500ms setTimeout; fakeTouch dispatches touch* only (no
  // click), so this opens the popover without ever running onTitleTap.
  async function hold(el: Element) {
    el.dispatchEvent(fakeTouch("touchstart", 0, 0));
    await delay(600);
  }

  async function renderMeta(props: Record<string, unknown> = {}) {
    const r = render(Viewport, {
      session: session({ id: "meta", name: "meta title" }),
      previewPort: null,
      openPreviewTick: 0,
      // suppress the terminal's mount auto-focus: otherwise xterm's helper textarea
      // steals focus from .desig shortly after focus(), firing a real focusout
      // (relatedTarget outside the wrap) that would race the focus assertions.
      consumeAutoFocusTerm: () => false,
      ...props,
    });
    // flush the mount $effect that binds the window-capture pointerdown/keydown
    // listeners, so a synchronously-dispatched pointerdown stamps lastPointerDownAt.
    await tick();
    return r;
  }
  const folded = (c: Element) =>
    c.querySelector(".vp-fold")?.getAttribute("aria-expanded") !== "true";

  it("hold on the desktop trigger opens the popover and does not fold", async () => {
    const { container } = await renderMeta({ touch: true });
    const desig = container.querySelector<HTMLElement>(".desig")!;
    expect(folded(container)).toBe(false);
    await hold(desig);
    expect(isOpen(container)).toBe(true);
    expect(folded(container)).toBe(false); // hold ran no onTitleTap
  });

  it("mobile: hold on .ctx-trigger opens the popover and does not fold", async () => {
    const { container } = await renderMeta({ mobile: true });
    const trigger = container.querySelector<HTMLElement>(".ctx-trigger")!;
    expect(folded(container)).toBe(false);
    await hold(trigger);
    expect(isOpen(container)).toBe(true);
    expect(folded(container)).toBe(false);
  });

  it("mobile: a click while held closes it and does not fold (phone desigWrapEl bind)", async () => {
    const { container } = await renderMeta({ mobile: true });
    const trigger = container.querySelector<HTMLElement>(".ctx-trigger")!;
    await hold(trigger);
    expect(isOpen(container)).toBe(true);
    // Real closing gesture: pointerdown (capture-phase dismissal listener sees it —
    // insideTitle(e.target) must resolve true, which requires the phone desigWrapEl
    // bind) followed by the click (fakeTouch fires no click; .click() would move a
    // real pointer and contaminate hoverOpen) — the re-tap's onTitleTap swallows.
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(isOpen(container)).toBe(false);
    expect(folded(container)).toBe(false); // swallowed → no fold
  });

  it("a pointerenter with pointerType touch does not open it", async () => {
    const { container } = await renderMeta({ touch: true });
    const wrap = container.querySelector<HTMLElement>(".desig-wrap")!;
    wrap.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
    await settle();
    expect(isOpen(container)).toBe(false);
  });

  it("a pointerenter with pointerType mouse opens it", async () => {
    const { container } = await renderMeta();
    const wrap = container.querySelector<HTMLElement>(".desig-wrap")!;
    wrap.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await expect.poll(() => isOpen(container)).toBe(true);
  });

  it("the hover bridge covers the 4px band below the chip (elementFromPoint)", async () => {
    // The bridge is a .desig-wrap.hovering:not(.editing)::after that extends the
    // wrap's hit area over the 4px gap to .desig-pop, so a mouse crossing it never
    // fires pointerleave. Playwright's position-hover multiplies by an iframe scale
    // and can't reliably land a 4px strip (see the step-2 spike), so pin the bridge
    // deterministically: elementFromPoint in the band must resolve to the wrap
    // (a pseudo-element's hit target is its origin element). Fails against unbridged
    // CSS — without the ::after, the point resolves to the header row/body.
    const { container } = await renderMeta();
    const wrap = container.querySelector<HTMLElement>(".desig-wrap")!;
    wrap.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await expect.poll(() => isOpen(container)).toBe(true); // .hovering set → ::after armed
    const r = wrap.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 8, r.bottom + 2);
    expect(el, "band point resolves inside the wrap via the ::after bridge").not.toBeNull();
    expect(wrap.contains(el) || el === wrap).toBe(true);
  });

  it("a full touch sequence (pointerdown/up, mousedown, focus) leaves it hidden", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    desig.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    desig.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    desig.focus(); // fires focusin on the wrap; recent pointerdown ⇒ pointer-driven
    await settle();
    expect(isOpen(container)).toBe(false);
  });

  it("focus with no preceding pointerdown reveals it (keyboard/AT path)", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus(); // lastPointerDownAt is -Infinity → not pointer-driven → focusOpen
    await expect.poll(() => isOpen(container)).toBe(true);
  });

  it("a focus long after a hold+close still reveals it (no stranded flag)", async () => {
    // Pins the rejected sticky-boolean design: after a hold (touchend
    // preventDefault'd → no focus consumes the flag) the boolean stranded forever,
    // suppressing a later AT focus. The timestamp design ages out instead. Uses
    // vi.setSystemTime to advance Date past the recency window; only Date is faked
    // (toFake:["Date"]) so longPress's REAL 500ms setTimeout still fires.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container } = await renderMeta({ touch: true });
      const desig = container.querySelector<HTMLElement>(".desig")!;
      // a real pointerdown arms both designs (timestamp + the old sticky flag)
      window.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      await hold(desig); // real-time wait; Date stays frozen
      expect(isOpen(container)).toBe(true);
      desig.dispatchEvent(new MouseEvent("click", { bubbles: true })); // close → holdOpen false
      await settle();
      expect(isOpen(container)).toBe(false);
      vi.setSystemTime(Date.now() + POINTER_FOCUS_MS + 100); // age the timestamp out
      desig.focus();
      await settle();
      expect(isOpen(container)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a focusout to a relatedTarget inside the wrap keeps it open (AT mid-read)", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus(); // opens via focusOpen
    await expect.poll(() => isOpen(container)).toBe(true);
    const inside = container.querySelector<HTMLElement>(".desig-pop")!; // inside the wrap
    desig.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: inside }));
    await settle();
    expect(isOpen(container)).toBe(true);
  });

  it("Escape closes a focus-opened popover", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus();
    await expect.poll(() => isOpen(container)).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect.poll(() => isOpen(container)).toBe(false);
  });

  it("Escape does not close a hover-opened popover", async () => {
    const { container } = await renderMeta();
    const wrap = container.querySelector<HTMLElement>(".desig-wrap")!;
    wrap.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await expect.poll(() => isOpen(container)).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(isOpen(container)).toBe(true); // hoverOpen is live tracking, not a latch
  });

  it("a click while held closes it and does not fold (desktop .desig)", async () => {
    const { container } = await renderMeta({ touch: true });
    const desig = container.querySelector<HTMLElement>(".desig")!;
    await hold(desig);
    expect(isOpen(container)).toBe(true);
    desig.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(isOpen(container)).toBe(false);
    expect(folded(container)).toBe(false);
  });

  it("a closing re-tap (pointerdown + click + focus) does not reopen via focus", async () => {
    const { container } = await renderMeta({ touch: true });
    const desig = container.querySelector<HTMLElement>(".desig")!;
    await hold(desig);
    expect(isOpen(container)).toBe(true);
    // the closing tap: its pointerdown makes the trailing focus pointer-driven
    desig.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    desig.dispatchEvent(new MouseEvent("click", { bubbles: true })); // swallow → holdOpen false
    desig.focus(); // pointer-driven ⇒ focusOpen stays false
    await settle();
    expect(isOpen(container)).toBe(false);
  });

  it("a click while held on .vp-name closes it and does not fold (sibling)", async () => {
    const { container } = await renderMeta({ touch: true });
    const name = container.querySelector<HTMLElement>(".vp-name")!;
    await hold(name); // longPress on the sibling opens the wrap-anchored popover
    expect(isOpen(container)).toBe(true);
    name.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(isOpen(container)).toBe(false);
    expect(folded(container)).toBe(false);
  });

  it("an outside pointerdown closes it", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus();
    await expect.poll(() => isOpen(container)).toBe(true);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.poll(() => isOpen(container)).toBe(false);
  });

  it("a renameRequest prop bump while open closes it", async () => {
    const { container, rerender } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus();
    await expect.poll(() => isOpen(container)).toBe(true);
    await rerender({
      session: session({ id: "meta", name: "meta title" }),
      renameRequest: { id: "meta", tick: 1 },
      previewPort: null,
      openPreviewTick: 0,
    });
    await expect.poll(() => isOpen(container)).toBe(false);
  });

  it("Enter → rename → commit leaves the popover not visible", async () => {
    const { container } = await renderMeta();
    const desig = container.querySelector<HTMLElement>(".desig")!;
    desig.focus();
    await expect.poll(() => isOpen(container)).toBe(true);
    desig.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const input = page.getByRole("textbox", { name: m.viewport_rename_aria() });
    await expect.element(input).toBeInTheDocument();
    const inputEl = input.element() as HTMLInputElement;
    inputEl.value = "renamed via enter";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // commit resolves (renameSession mocked) → renaming=false → .desig + metaPop
    // remount; the $effect on renaming reset the flags, so it must not remount open.
    await expect.poll(() => container.querySelector(".desig") !== null).toBe(true);
    await settle();
    expect(isOpen(container)).toBe(false);
  });

  // Kept LAST: the only case that moves the *real* Playwright pointer. It parks the
  // cursor over the chip, which would fire a stray pointerenter (hoverOpen) on the
  // next test's render — so no hidden-asserting case may follow it.
  it("a real click toggles the git rail and does not latch the popover open", async () => {
    const { container } = await renderMeta(); // pure mouse desktop → tap toggles git rail
    const wrap = container.querySelector<HTMLElement>(".desig-wrap")!;
    expect(container.querySelector(".vp-git-strip")).toBeNull();
    // real Playwright click: moves the pointer (pointerenter → hoverOpen), focuses
    // .desig with a preceding pointerdown (pointer-driven → focusOpen stays false),
    // and runs onTitleTap → gitOpen.
    await page.getByText("TASK-01").click();
    await expect.poll(() => container.querySelector(".vp-git-strip")).not.toBeNull();
    // move the pointer off → hoverOpen clears; nothing else latches → hidden.
    wrap.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await expect.poll(() => isOpen(container)).toBe(false);
  });
});
