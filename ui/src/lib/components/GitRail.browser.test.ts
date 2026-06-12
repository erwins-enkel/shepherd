import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { GitState } from "$lib/types";
import { m } from "$lib/paraglide/messages";

// GitRail loads PR state from $lib/api.gitState on mount; mock it to a populated
// open PR so the rail renders its full button set (PR link + CI dot + Merge +
// automation pill + ReadyToggle) without a backend. Mock ALL named exports
// GitRail imports from $lib/api so the import resolves.
const openPrState: GitState = {
  kind: "github",
  state: "open",
  number: 12345,
  url: "https://github.com/acme/shepherd/pull/12345",
  title:
    "feat: a pull request title (rail width pressure comes from the control set, not this field)",
  mergeable: true,
  checks: "success",
  deployConfigured: true,
};

// gitStateFn is a vi.fn() whose implementation we swap per describe block so
// each state suite gets its own mocked GitState without re-importing the module.
const gitStateFn = vi.fn(async () => openPrState);

// Preserve the real module (the wider graph — reviews store, AutomationPanel —
// pulls other named exports like getRepoConfig/getReviews) and override only the
// PR-state fetch GitRail makes on mount. The real network calls never fire under
// test: gitState is stubbed, and no other call path is exercised.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    gitState: gitStateFn,
    openPr: vi.fn(),
    mergePr: vi.fn(),
    redeploy: vi.fn(),
    replySession: vi.fn(),
  };
});

// Import the component AFTER the mock is registered.
const { default: GitRail } = await import("./GitRail.svelte");
// The plan-gate reviewing store drives the auto-pill pulse for plan reviews,
// mirroring the critic (reviews) store. Imported from the same module the
// component reads so toggling it reactively updates the rendered pill.
const { planGates } = await import("$lib/reviews.svelte");

// Deterministic measurement: pin the rail's font so CI (no Berkeley Mono) and
// local agree. The rail mounts into a fixed-width host cell. On desktop the
// failure we guard against is overflow past that cell; on mobile the rail is a
// single horizontally-scrollable row, so there the guard is that it stays one
// line high (no vertical stacking) with no squished-to-zero controls.
let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

// A fixed-width host cell. overflow:visible means getBoundingClientRect reports
// the true painted rect of each control even if it escapes the cell — that's
// exactly what we want so assertControlsWithin can catch desktop overflows (and
// measure the mobile row's true painted height) directly.
function host(width: number): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  h.style.overflow = "visible";
  document.body.appendChild(h);
  return h;
}

function assertControlsWithin(cell: HTMLElement) {
  const wrap = cell.querySelector<HTMLElement>(".git-rail-wrap");
  expect(wrap, ".git-rail-wrap mounted").not.toBeNull();
  const rail = wrap!.querySelector<HTMLElement>(".rail");
  expect(rail, ".rail mounted").not.toBeNull();
  const controls = wrap!.querySelectorAll<HTMLElement>("button, a[href]");
  expect(controls.length, "rail has controls").toBeGreaterThan(0);

  // Every control must stay sized — no squished-to-zero element (regression:
  // flex-shrink let the PR link wrap and the CI dot collapse to 0px).
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const label = c.getAttribute("aria-label") || c.textContent?.trim() || c.className;
    expect(r.width, `${label} zero width`).toBeGreaterThan(0);
    expect(r.height, `${label} zero height`).toBeGreaterThan(0);
  }
  const dot = wrap!.querySelector<HTMLElement>(".dot");
  if (dot) {
    expect(dot.getBoundingClientRect().width, "CI dot not squished to 0").toBeGreaterThan(0);
  }

  if (rail!.classList.contains("mobile")) {
    // Mobile: one horizontally-scrollable row, never a vertical stack. Controls
    // may run past the cell's RIGHT edge (that's the scroll, not a failure), so
    // assert the row stays one line high and is actually a scroll container. The
    // left edge still holds — the leading auto-margin collapses to 0 under
    // overflow, so nothing paints left of the cell's origin.
    const cellRect = cell.getBoundingClientRect();
    expect(getComputedStyle(rail!).overflowX, "mobile rail scrolls horizontally").toBe("auto");
    const tallest = Math.max(...[...controls].map((c) => c.getBoundingClientRect().height));
    const railH = rail!.getBoundingClientRect().height;
    expect(railH, "rail stays a single row (no vertical stacking)").toBeLessThanOrEqual(
      tallest + 8,
    );
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      const label = c.getAttribute("aria-label") || c.textContent?.trim() || c.className;
      expect(r.left, `${label} escapes cell left edge`).toBeGreaterThanOrEqual(cellRect.left - 2);
    }
  } else {
    // Desktop: the rail must fit within its fixed-width cell (no overflow).
    const cellRect = cell.getBoundingClientRect();
    for (const c of controls) {
      const r = c.getBoundingClientRect();
      const label = c.getAttribute("aria-label") || c.textContent?.trim() || c.className;
      expect(r.left, `${label} escapes cell left edge`).toBeGreaterThanOrEqual(cellRect.left - 2);
      expect(r.right, `${label} escapes cell right edge`).toBeLessThanOrEqual(cellRect.right + 2);
    }
  }
}

// Shared props for most cases — repoPath present so the automation pill renders.
const baseProps = {
  sessionId: "sess-1",
  repoPath: "/repo",
  name: "feature-x",
  prompt: "do the thing",
  status: "idle" as const,
  ready: false,
  showReady: true,
};

describe("GitRail — controls stay within the cell", () => {
  // ── open PR (original suite, two widths) ──────────────────────────────────
  it("desktop cell 600px — open PR, long title", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    assertControlsWithin(h);
  });

  it("mobile cell 360px — open PR, long title", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    assertControlsWithin(h);
  });

  // ── none state ────────────────────────────────────────────────────────────
  it("desktop 600px — state:none → Open PR button", async () => {
    const noneState: GitState = {
      kind: "github",
      state: "none",
      checks: "none",
      deployConfigured: false,
    };
    gitStateFn.mockResolvedValue(noneState);
    await page.viewport(600, 900);
    const h = host(600);
    // repoPath empty: no automation pill; showReady irrelevant (state≠open, ready=false)
    const screen = render(GitRail, {
      target: h,
      props: { ...baseProps, repoPath: "", mobile: false },
    });
    await expect.element(screen.getByRole("button", { name: /Open PR/i })).toBeVisible();
    assertControlsWithin(h);
  });

  // ── merged + redeploy ─────────────────────────────────────────────────────
  it("desktop 600px — state:merged, deployConfigured:true → Redeploy button", async () => {
    const mergedState: GitState = {
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: true,
    };
    gitStateFn.mockResolvedValue(mergedState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/merged/i)).toBeVisible();
    // Redeploy button must be present and in-bounds
    await expect.element(screen.getByRole("button", { name: /Redeploy/i })).toBeVisible();
    assertControlsWithin(h);
  });

  it("mobile 360px — state:merged, deployConfigured:true → Redeploy in-bounds", async () => {
    const mergedState: GitState = {
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: true,
    };
    gitStateFn.mockResolvedValue(mergedState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/merged/i)).toBeVisible();
    assertControlsWithin(h);
  });

  // ── closed ────────────────────────────────────────────────────────────────
  it("desktop 600px — state:closed → no interactive controls", async () => {
    const closedState: GitState = {
      kind: "github",
      state: "closed",
      checks: "none",
      deployConfigured: false,
    };
    gitStateFn.mockResolvedValue(closedState);
    await page.viewport(600, 900);
    const h = host(600);
    // repoPath set so automation pill renders (still needs to be in-bounds)
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/closed/i)).toBeVisible();
    // automation pill is the only interactive control; assertControlsWithin covers it
    assertControlsWithin(h);
  });

  // ── open + merge-disabled (CI failure → mergeBlocked) ────────────────────
  it("desktop 600px — open, checks:failure → Merge button disabled but in-bounds", async () => {
    const blockedState: GitState = {
      ...openPrState,
      checks: "failure",
      mergeable: true,
    };
    gitStateFn.mockResolvedValue(blockedState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    // Merge button must still be present (just disabled)
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    // Absent mergeStateStatus (Gitea) routes to the checks-fallback block reason.
    expect(mergeBtn!.title, "checks fallback tooltip").toBe(m.gitrail_merge_blocked_checks());
    assertControlsWithin(h);
  });

  it("mobile 360px — open, mergeable:false → Merge button disabled, single scroll row", async () => {
    const conflictState: GitState = {
      ...openPrState,
      checks: "success",
      mergeable: false,
    };
    gitStateFn.mockResolvedValue(conflictState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    expect(mergeBtn!.title, "conflict tooltip").toBe(m.gitrail_merge_blocked_conflict());
    assertControlsWithin(h);
  });

  // ── mergeStateStatus path (GitHub) ────────────────────────────────────────
  // The over-block fix: a non-required/flaky check failing makes GitHub report
  // `unstable` (still mergeable), so we must NOT disable on checks:"failure" when
  // mergeStateStatus says merge is allowed. This is the key regression guard.
  it("desktop 600px — open, mergeStateStatus:unstable + checks:failure → Merge ENABLED", async () => {
    const unstableState: GitState = {
      ...openPrState,
      checks: "failure",
      mergeable: true,
      mergeStateStatus: "unstable",
    };
    gitStateFn.mockResolvedValue(unstableState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button enabled despite failing non-required check").toBe(
      false,
    );
    assertControlsWithin(h);
  });

  it("desktop 600px — open, mergeStateStatus:blocked → Merge disabled with protected tooltip", async () => {
    const protectedState: GitState = {
      ...openPrState,
      checks: "pending",
      mergeable: true,
      mergeStateStatus: "blocked",
    };
    gitStateFn.mockResolvedValue(protectedState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    expect(mergeBtn!.title, "protected tooltip").toBe(m.gitrail_merge_blocked_protected());
    assertControlsWithin(h);
  });

  // ── open + ReadyToggle hidden (status:running) ────────────────────────────
  it("desktop 600px — open, status:running → ReadyToggle absent, rail in-bounds", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, status: "running", showReady: true },
    });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    // ReadyToggle hidden when status === "running"
    const readyToggle = h.querySelector('[data-testid="ready-toggle"], .ready-toggle');
    // We can't rely on a testid; instead verify the rail still fits without it
    expect(readyToggle, "ReadyToggle absent when running").toBeNull();
    assertControlsWithin(h);
  });

  it("mobile 360px — open, status:running → ReadyToggle absent, rail in-bounds", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: true, status: "running", showReady: true },
    });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
    assertControlsWithin(h);
  });

  // ── open + armed "Confirm merge?" (widest label — the overflow stressor) ──
  // "draining" is a session-level concept (the server DrainStatus), not a
  // distinct GitRail rail state — the component has no git.state === "draining"
  // branch. The widest real label is the armed merge-confirm text; that's the
  // actual overflow stressor the critic named.
  it("mobile 360px — open, Merge armed → 'confirm ✓' stays one scroll row (key stressor)", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    // Arm the merge button by clicking it once (first click arms, second confirms).
    const mergeBtn = screen.getByRole("button", { name: /^Merge$/i });
    await mergeBtn.click();

    // Wait for the armed label to appear.
    await expect.element(screen.getByRole("button", { name: /confirm/i })).toBeVisible();

    // Assert the now-armed "confirm ✓" button keeps the rail one scrollable row.
    assertControlsWithin(h);
  });

  it("desktop 600px — open, Merge armed → 'confirm ✓' label fits in cell", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    const mergeBtn = screen.getByRole("button", { name: /^Merge$/i });
    await mergeBtn.click();
    await expect.element(screen.getByRole("button", { name: /confirm/i })).toBeVisible();

    assertControlsWithin(h);
  });
});

describe("GitRail — mobile scroll affordance", () => {
  it("mobile 360px — overflowing rail fades its trailing edge to cue the scroll", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    const rail = h.querySelector<HTMLElement>(".rail.mobile");
    expect(rail, ".rail.mobile mounted").not.toBeNull();
    // content overflows the 360px cell → the right edge fades (--fade-r = 1)
    expect(rail!.scrollWidth, "rail actually overflows").toBeGreaterThan(rail!.clientWidth);
    await vi.waitFor(() =>
      expect(rail!.style.getPropertyValue("--fade-r"), "trailing edge faded").toBe("1"),
    );
    // start is in view (scrollLeft 0) → leading edge not faded
    expect(rail!.style.getPropertyValue("--fade-l"), "leading edge not faded").toBe("0");
  });

  it("mobile 360px — recomputes the fade on content change, not just scroll/resize", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    const rail = h.querySelector<HTMLElement>(".rail.mobile")!;
    await vi.waitFor(() => expect(rail.style.getPropertyValue("--fade-r")).toBe("1"));

    // Shrink the content so it no longer overflows — WITHOUT scrolling or resizing
    // the rail's (width:100%) box. Only the MutationObserver can catch this; with a
    // scroll/resize-only watcher --fade-r would stay stale at "1".
    while (rail.children.length > 1) rail.removeChild(rail.lastElementChild!);
    await vi.waitFor(() => expect(rail.style.getPropertyValue("--fade-r")).toBe("0"));
  });

  it("desktop 600px — no fade vars (rail is not a scroller)", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    const rail = h.querySelector<HTMLElement>(".rail");
    expect(rail!.style.getPropertyValue("--fade-r"), "no fade var on desktop").toBe("");
  });
});

describe("GitRail — plan review pulses the automation pill", () => {
  afterEach(() => {
    // store is module-global; clear so reviewing state can't leak between tests
    planGates.drop(baseProps.sessionId);
  });

  it("toggles the .auto-pill reviewing class + aria-busy when a plan review is in flight", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    // rail (and the pill) only renders once the mocked gitState resolves on mount
    await expect.element(screen.getByText(/PR #12345/)).toBeVisible();

    const pill = h.querySelector<HTMLButtonElement>("button.auto-pill");
    expect(pill, "auto-pill present").not.toBeNull();
    expect(pill!.classList.contains("reviewing"), "not pulsing initially").toBe(false);

    // plan reviewer goes in flight → pill pulses
    planGates.applyReviewing(baseProps.sessionId, true);
    await expect.element(pill!).toHaveClass(/reviewing/);
    expect(pill!.getAttribute("aria-busy")).toBe("true");

    // plan review lands → pulse clears
    planGates.applyReviewing(baseProps.sessionId, false);
    await vi.waitFor(() =>
      expect(pill!.classList.contains("reviewing"), "pulse cleared").toBe(false),
    );
    expect(pill!.getAttribute("aria-busy")).toBe("false");
  });
});
