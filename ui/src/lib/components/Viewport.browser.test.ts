import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";

// Mock startPreview so it resolves to "ok" without a backend. All other
// named exports from $lib/api are preserved (getSessionUsage etc. are used
// by subcomponents; they can fail silently under test — existing tests pass
// without mocking them).
// The fn is declared BEFORE vi.mock so vitest's hoisting can close over it.
const startPreviewFn = vi.fn(async () => ({ ok: true as const, command: "npm run dev" }));
const stopPreviewFn = vi.fn(async () => ({ killed: 1 }) as { killed: number } | { notBound: true });

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, startPreview: startPreviewFn, stopPreview: stopPreviewFn };
});

// Component must be imported AFTER the mock is registered.
const { default: Viewport } = await import("./Viewport.svelte");
// Dynamic import AFTER the $lib/api mock: reviews.svelte imports $lib/api, so a static
// (hoisted) import would pull the real module in before the mock registers and break it.
const { reviews } = await import("$lib/reviews.svelte");
import { toasts } from "$lib/toasts.svelte";
import { m } from "$lib/paraglide/messages";
import type { Session, BuildQueue } from "$lib/types";

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
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...partial,
  };
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
    const { rerender } = render(Viewport, {
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
    const { rerender } = render(Viewport, {
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
    const { rerender } = render(Viewport, {
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
    const { rerender } = render(Viewport, {
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
  // a bubbling Event carries our chosen target up to that root listener.
  function fakeTouch(type: string, x: number, y: number): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", {
      value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      configurable: true,
    });
    return e;
  }

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
    const { container } = renderMobile(onnavigate);

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
    const { container } = renderMobile(onnavigate);

    const head = container.querySelector(".vp-head");
    expect(head, ".vp-head should render").not.toBeNull();
    leftwardDrag(head!);

    expect(onnavigate).not.toHaveBeenCalled();
  });

  it("tags only .vp-body with data-swipe-page; all top chrome is outside the allow-list", async () => {
    const onnavigate = vi.fn();
    const { container } = renderMobile(onnavigate);

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
    const { container } = renderMobile(onnavigate);

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
    const { container } = render(Viewport, {
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
    const { container } = render(Viewport, {
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
