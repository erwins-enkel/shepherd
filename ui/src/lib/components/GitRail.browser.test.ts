import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rawRender } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { GitState, ReviewVerdict } from "$lib/types";
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
const setPrDraftStateFn = vi.fn(async (_id: string, draft: boolean) => ({
  ...openPrState,
  isDraft: draft,
}));

// Preserve the real module (the wider graph — reviews store, AutomationPanel —
// pulls other named exports like getRepoConfig/getReviews) and override only the
// PR-state fetch GitRail makes on mount. The real network calls never fire under
// test: gitState is stubbed, and no other call path is exercised.
// reviewPrFn drives the manual critic-trigger handler; per-test we resolve it to
// "started"/"skipped"/"error" or reject it to exercise the fail-closed toast paths.
const reviewPrFn = vi.fn(async () => "started" as "started" | "skipped" | "error");
// reviewPlanFn drives the manual plan-review trigger handler; same resolution options.
const reviewPlanFn = vi.fn(
  async () =>
    "started" as
      "started" | "skipped" | "plan-unavailable" | "error-spawn" | "error-worktree" | "error-auth",
);

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    gitState: gitStateFn,
    setPrDraftState: setPrDraftStateFn,
    openPr: vi.fn(),
    mergePr: vi.fn(),
    redeploy: vi.fn(),
    replySession: vi.fn(),
    reviewPr: reviewPrFn,
    reviewPlan: reviewPlanFn,
  };
});

// Mock the shared toast store so the manual-review handler's fail-closed/skipped
// toasts can be asserted without rendering the real toast UI.
const toastsInfo = vi.fn();
vi.mock("$lib/toasts.svelte", () => ({
  toasts: { info: toastsInfo },
}));

// Mock pull-offer so the combined decommission+update action doesn't issue real fetch calls.
vi.mock("$lib/pull-offer", () => ({ pullMainAndToast: vi.fn() }));

// Import the component AFTER the mock is registered.
const { default: GitRail } = await import("./GitRail.svelte");
// Test-only wrapper that flips ONLY autopilotOn (sessionId stable) — see the
// "Open PR hidden under autopilot" describe for why rerender() can't do this.
const { default: GitRailAutopilotHarness } = await import("./GitRailAutopilotHarness.svelte");
// The plan-gate reviewing store drives the auto-pill pulse for plan reviews,
// mirroring the critic (reviews) store. Imported from the same module the
// component reads so toggling it reactively updates the rendered pill.
// repoConfig drives the critic-enabled flag the manual-review button gates on.
const { planGates, reviews, repoConfig } = await import("$lib/reviews.svelte");
// Mocked pull-offer fn — imported for assertions in the post-merge suite.
const { pullMainAndToast } = await import("$lib/pull-offer");

const mounted: Array<{ unmount: () => void | Promise<void> }> = [];
async function render(
  ...args: Parameters<typeof rawRender>
): Promise<Awaited<ReturnType<typeof rawRender>>> {
  const result = await rawRender(...args);
  mounted.push(result);
  return result;
}

// Deterministic measurement: pin the rail's font so CI (no Berkeley Mono) and
// local agree. The rail mounts into a fixed-width host cell. On desktop the
// failure we guard against is overflow past that cell; on mobile the rail is a
// single horizontally-scrollable row, so there the guard is that it stays one
// line high (no vertical stacking) with no squished-to-zero controls.
let fontStyle: HTMLStyleElement;
beforeEach(() => {
  setPrDraftStateFn.mockClear();
  setPrDraftStateFn.mockImplementation(async (_id: string, draft: boolean) => ({
    ...openPrState,
    isDraft: draft,
  }));
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(async () => {
  for (const instance of mounted.splice(0).reverse()) {
    await instance.unmount();
  }
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
    const expectedTouchHeight = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );
    const touchButtons = rail!.querySelectorAll<HTMLElement>(
      "button.gbtn, button.verdict-chip, button.ready-toggle",
    );
    expect(expectedTouchHeight, "mobile actionbar height token").toBeGreaterThan(0);
    expect(touchButtons.length, "mobile rail has touch buttons").toBeGreaterThan(0);
    for (const button of touchButtons) {
      const label =
        button.getAttribute("aria-label") || button.textContent?.trim() || button.className;
      expect(button.getBoundingClientRect().height, `${label} uses mobile touch height`).toBe(
        expectedTouchHeight,
      );
    }
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

describe("GitRail — shortened issue & PR labels", () => {
  // The PR control now discloses an action menu, so only the explicit menu item
  // keeps the external-link arrow. The issue control remains a direct link.
  it("PR menu trigger: short visible text, no ↗, full ref in title + accessible name", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect
      .element(
        screen.getByRole("button", {
          name: m.prbadge_button_title({ label: m.prbadge_open({ number: 12345 }) }),
        }),
      )
      .toBeVisible();
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const rail = h.querySelector<HTMLElement>(".rail")!;
    expect(rail.textContent).toContain("PR");
    expect(rail.textContent).not.toContain("PR ↗");
    expect(rail.textContent).not.toContain("#12345");
  });

  it("issue link: short visible text, ↗ kept, full ref in title + accessible name", async () => {
    gitStateFn.mockResolvedValue({
      ...openPrState,
      issueUrl: "https://github.com/acme/shepherd/issues/855",
    });
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, issueNumber: 855 },
    });
    await expect.element(screen.getByRole("link", { name: "Issue #855" })).toBeVisible();
    await expect.element(screen.getByTitle("Issue #855")).toBeVisible();
    const rail = h.querySelector<HTMLElement>(".rail")!;
    expect(rail.textContent).toContain("Issue ↗");
    expect(rail.textContent).not.toContain("#855");
  });
});

describe("GitRail — PR actions menu", () => {
  beforeEach(() => {
    toastsInfo.mockClear();
  });

  it("opens the PR URL only from the explicit menu action", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });

    const trigger = screen.getByRole("button", {
      name: m.prbadge_button_title({ label: m.prbadge_open({ number: 12345 }) }),
    });
    await trigger.click();
    expect(open).not.toHaveBeenCalled();

    await page.getByRole("menuitem", { name: m.prbadge_open_pr() }).click();
    expect(open).toHaveBeenCalledWith(openPrState.url, "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("sets a draft PR Ready for Review and refreshes the next menu", async () => {
    gitStateFn.mockResolvedValue({ ...openPrState, isDraft: true });
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    const trigger = screen.getByRole("button", {
      name: m.prbadge_button_title({ label: m.prbadge_open({ number: 12345 }) }),
    });

    await trigger.click();
    await page.getByRole("menuitem", { name: m.prbadge_mark_ready() }).click();
    expect(setPrDraftStateFn).toHaveBeenCalledWith("sess-1", false);
    expect(toastsInfo).toHaveBeenCalledWith(m.prbadge_marked_ready(), {
      key: "pr-draft:sess-1",
    });

    await trigger.click();
    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_mark_draft() }))
      .toBeVisible();
  });

  it("sets a ready PR back to Draft and refreshes the next menu", async () => {
    gitStateFn.mockResolvedValue({ ...openPrState, isDraft: false });
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    const trigger = screen.getByRole("button", {
      name: m.prbadge_button_title({ label: m.prbadge_open({ number: 12345 }) }),
    });

    await trigger.click();
    await page.getByRole("menuitem", { name: m.prbadge_mark_draft() }).click();
    expect(setPrDraftStateFn).toHaveBeenCalledWith("sess-1", true);
    expect(toastsInfo).toHaveBeenCalledWith(m.prbadge_marked_draft(), {
      key: "pr-draft:sess-1",
    });

    await trigger.click();
    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_mark_ready() }))
      .toBeVisible();
  });

  it("keeps the menu open when changing Draft state fails", async () => {
    gitStateFn.mockResolvedValue({ ...openPrState, isDraft: true });
    setPrDraftStateFn.mockRejectedValueOnce(new Error("boom"));
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    const trigger = screen.getByRole("button", {
      name: m.prbadge_button_title({ label: m.prbadge_open({ number: 12345 }) }),
    });

    await trigger.click();
    const markReady = page.getByRole("menuitem", { name: m.prbadge_mark_ready() });
    await markReady.click();

    await expect.element(markReady).toBeVisible();
    expect(toastsInfo).toHaveBeenCalledWith(m.prbadge_draft_toggle_failed({ reason: "boom" }), {
      alert: true,
      key: "pr-draft:sess-1",
    });
  });
});

describe("GitRail — controls stay within the cell", () => {
  // ── open PR (original suite, two widths) ──────────────────────────────────
  it("desktop cell 600px — open PR, long title", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    assertControlsWithin(h);
  });

  it("mobile cell 360px — open PR, long title", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    assertControlsWithin(h);
  });

  it("mobile rail buttons share the actionbar touch height with a verdict present", async () => {
    const sessionId = "touch-height";
    const verdict: ReviewVerdict = {
      sessionId,
      headSha: "deadbeef",
      decision: "commented",
      summary: "Ready to merge.",
      body: "No findings.",
      findings: [],
      addressRound: 0,
      addressCap: 2,
      finalRoundPending: false,
      finalRoundTimeoutMs: 900000,
      updatedAt: Date.now(),
    };
    reviews.apply({ id: sessionId, review: verdict });

    try {
      gitStateFn.mockResolvedValue(openPrState);
      await page.viewport(400, 900);
      const h = host(360);
      const screen = await render(GitRail, {
        target: h,
        props: { ...baseProps, sessionId, mobile: true },
      });
      await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
      await vi.waitFor(() =>
        expect(h.querySelector("button.verdict-chip"), "verdict button present").not.toBeNull(),
      );
      assertControlsWithin(h);
    } finally {
      reviews.drop(sessionId);
    }
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
    const screen = await render(GitRail, {
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    expect(mergeBtn!.title, "protected tooltip").toBe(m.gitrail_merge_blocked_protected());
    assertControlsWithin(h);
  });

  it("desktop 600px — open, mergeStateStatus:behind → Merge disabled with behind-base tooltip", async () => {
    const behindState: GitState = {
      ...openPrState,
      checks: "success",
      mergeable: true,
      mergeStateStatus: "behind",
    };
    gitStateFn.mockResolvedValue(behindState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    expect(mergeBtn!.title, "behind-base tooltip").toBe(m.gitrail_merge_blocked_behind());
    assertControlsWithin(h);
  });

  // `unknown` is GitHub's transient "merge-eligibility not computed yet" state —
  // not a reliable signal, so it must be treated as ABSENT and defer to the checks
  // rollup (exactly like a forge without mergeStateStatus, e.g. Gitea). Without the
  // fix, the truthy `"unknown"` string took the ternary's signal branch, skipped the
  // checks fallback, and left a failing-check PR's Merge button wrongly ENABLED.
  it("desktop 600px — open, mergeStateStatus:unknown + checks:failure → Merge disabled with checks tooltip", async () => {
    const unknownFailState: GitState = {
      ...openPrState,
      checks: "failure",
      mergeable: true,
      mergeStateStatus: "unknown",
    };
    gitStateFn.mockResolvedValue(unknownFailState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    // unknown defers to checks: failing check → checks-fallback block reason.
    expect(mergeBtn!.title, "checks fallback tooltip").toBe(m.gitrail_merge_blocked_checks());
    assertControlsWithin(h);
  });

  it("desktop 600px — open, mergeStateStatus:unknown + checks:success → Merge ENABLED", async () => {
    const unknownOkState: GitState = {
      ...openPrState,
      checks: "success",
      mergeable: true,
      mergeStateStatus: "unknown",
    };
    gitStateFn.mockResolvedValue(unknownOkState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    // unknown defers to checks: green checks → no over-block during the unknown window.
    expect(mergeBtn!.disabled, "Merge button enabled while unknown + checks green").toBe(false);
    assertControlsWithin(h);
  });

  it("desktop 600px — open, isDraft:true → Merge disabled with draft tooltip", async () => {
    const draftState: GitState = {
      ...openPrState,
      checks: "success",
      mergeable: true,
      isDraft: true,
    };
    gitStateFn.mockResolvedValue(draftState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    const mergeBtn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
    expect(mergeBtn, "Merge button present").not.toBeNull();
    expect(mergeBtn!.disabled, "Merge button disabled").toBe(true);
    expect(mergeBtn!.title, "draft tooltip").toBe(m.gitrail_merge_blocked_draft());
    assertControlsWithin(h);
  });

  // ── open + ReadyToggle hidden (status:running) ────────────────────────────
  it("desktop 600px — open, status:running → ReadyToggle absent, rail in-bounds", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, status: "running", showReady: true },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
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
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: true, status: "running", showReady: true },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const mergeBtn = screen.getByRole("button", { name: /^Merge$/i });
    await mergeBtn.click();
    await expect.element(screen.getByRole("button", { name: /confirm/i })).toBeVisible();

    assertControlsWithin(h);
  });
});

describe("GitRail — forge-error fallback (no silent-empty rail)", () => {
  // Regression: a thrown gitState (forge 502 — e.g. GitHub rate-limited) used to set
  // git=null and render NOTHING — no PR link, no error, no retry. The desktop PR
  // disclosure strip then showed only the surrounding autopilot control, so the
  // operator saw "missing buttons" and couldn't open the PR. The fetch retry was also
  // gated on git?.state === "open", so a null (failed) state never recovered.
  it("desktop — gitState rejects → shows error + Retry instead of an empty rail", async () => {
    gitStateFn.mockRejectedValue(new Error("forge 502"));
    await page.viewport(600, 900);
    const h = host(600);
    await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    // the error fallback appears (not a blank rail)
    await vi.waitFor(() =>
      expect(h.querySelector<HTMLElement>(".err")?.textContent?.trim()).toBe(
        m.gitrail_status_failed(),
      ),
    );
    // a Retry button is present and the full PR control set is NOT rendered
    const retry = [...h.querySelectorAll<HTMLButtonElement>("button.gbtn")].find(
      (b) => b.textContent?.trim() === m.common_retry(),
    );
    expect(retry, "Retry button present").not.toBeUndefined();
    expect(h.querySelector("a[href]"), "no PR link while load failed").toBeNull();
  });

  it("desktop — Retry after the forge recovers renders the full PR rail", async () => {
    gitStateFn.mockRejectedValue(new Error("forge 502"));
    await page.viewport(600, 900);
    const h = host(600);
    await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await vi.waitFor(() => expect(h.querySelector(".err")).not.toBeNull());

    // forge recovers; clicking Retry re-fetches and the rail self-heals
    gitStateFn.mockResolvedValue(openPrState);
    const retry = [...h.querySelectorAll<HTMLButtonElement>("button.gbtn")].find(
      (b) => b.textContent?.trim() === m.common_retry(),
    )!;
    retry.click();
    await vi.waitFor(() => {
      const trigger = h.querySelector<HTMLButtonElement>("button.status-chip.info");
      expect(trigger, "PR menu trigger rendered after retry").not.toBeNull();
      expect(trigger!.getAttribute("aria-haspopup")).toBe("menu");
    });
    expect(h.querySelector(".err"), "error cleared after successful retry").toBeNull();
  });
});

describe("GitRail — mobile scroll affordance", () => {
  it("mobile 360px — overflowing rail fades its trailing edge to cue the scroll", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(400, 900);
    const h = host(360);
    // Emulate the real .vp-git-strip (display:flex; min-width:0) so the
    // .git-rail-wrap.mobile (flex:1 1 auto; min-width:0) clamps to the cell and
    // the rail scrolls — a plain block host only clamps while content fits.
    h.style.display = "flex";
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

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
    // flex host mirrors the real .vp-git-strip so the wrap clamps and the rail scrolls
    h.style.display = "flex";
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

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
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    // rail (and the pill) only renders once the mocked gitState resolves on mount
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

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

describe("GitRail — review popover is a modal dialog with real focus semantics", () => {
  // A changes_requested verdict whose body contains a markdown link, so the
  // Tab-trap's DYNAMIC enumeration must include the rendered <a> (the body is
  // sanitized markdown → it lands inside .rv-body as a real focusable link).
  const verdict: ReviewVerdict = {
    sessionId: baseProps.sessionId,
    headSha: "deadbeef",
    decision: "changes_requested",
    summary: "Two issues to address before merge.",
    body: "See [the failing case](https://example.com/issue) and fix the guard.",
    findings: ["fix the guard"],
    addressRound: 0,
    addressCap: 2,
    finalRoundPending: false,
    finalRoundTimeoutMs: 900000,
    updatedAt: Date.now(),
  };

  beforeEach(() => {
    reviews.apply({ id: baseProps.sessionId, review: verdict });
  });
  afterEach(() => {
    reviews.drop(baseProps.sessionId);
  });

  // Open the popover by clicking the REVIEWED/CHANGES verdict chip; returns the
  // chip (opener), the dialog, and the host. Waits a microtask flush so the
  // dynamically-imported marked+DOMPurify body render resolves before asserting.
  async function openReview(h: HTMLElement) {
    const chip = h.querySelector<HTMLButtonElement>("button.verdict-chip");
    expect(chip, "verdict chip present").not.toBeNull();
    chip!.click();
    const dialog = await vi.waitFor(() => {
      const d = h.querySelector<HTMLElement>(".review-pop");
      expect(d, "review dialog opened").not.toBeNull();
      return d!;
    });
    // give the markdown-rendering $effect a tick to render the body
    await vi.waitFor(
      () => {
        expect(dialog.querySelector(".rv-body a"), "body link rendered").not.toBeNull();
      },
      { timeout: 5000 },
    );
    return { chip: chip!, dialog };
  }

  it("dialog has role=dialog AND aria-modal=true", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openReview(h);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus into the dialog on open", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openReview(h);
    await vi.waitFor(() => {
      expect(dialog.contains(document.activeElement), "focus inside the dialog").toBe(true);
    });
  });

  it("restores focus to the opener chip when closed via the ✕ button", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { chip, dialog } = await openReview(h);
    const closeBtn = dialog.querySelector<HTMLButtonElement>(
      `button[aria-label="${m.common_close()}"]`,
    );
    expect(closeBtn, "close button present").not.toBeNull();
    closeBtn!.click();
    await vi.waitFor(() => {
      expect(h.querySelector(".review-pop"), "dialog closed").toBeNull();
      expect(document.activeElement, "focus restored to opener").toBe(chip);
    });
  });

  it("restores focus to the opener chip when closed via Escape", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { chip } = await openReview(h);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => {
      expect(h.querySelector(".review-pop"), "dialog closed").toBeNull();
      expect(document.activeElement, "focus restored to opener").toBe(chip);
    });
  });

  it("Tab from the last focusable node wraps to the first (trap stays inside)", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openReview(h);
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    expect(focusables.length, "more than one focusable").toBeGreaterThan(1);
    // the rendered body link must be in the enumerated set
    expect(
      [...focusables].some((n) => n.matches(".rv-body a")),
      "body link in trap set",
    ).toBe(true);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement, "Tab wraps last → first").toBe(first);
  });

  it("Shift+Tab from the first focusable node wraps to the last", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openReview(h);
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first.focus();
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement, "Shift+Tab wraps first → last").toBe(last);
  });
});

describe("GitRail — manual critic-review trigger", () => {
  // The button gates on git open + checks success + repo critic enabled. critic
  // defaults to enabled (repoConfig.isEnabled → true when unknown); we set it
  // explicitly so the gate is deterministic and the disabled-critic case is real.
  beforeEach(() => {
    reviewPrFn.mockResolvedValue("started");
    toastsInfo.mockClear();
    reviewPrFn.mockClear();
    repoConfig.enabled = { ...repoConfig.enabled, [baseProps.repoPath]: true };
  });
  afterEach(() => {
    reviews.drop(baseProps.sessionId);
    // reset critic flag so it can't leak across suites
    const next = { ...repoConfig.enabled };
    delete next[baseProps.repoPath];
    repoConfig.enabled = next;
  });

  // The manual-review button is a .gbtn with one of the Review/Re-review/Restart
  // labels; the Merge button is also a .gbtn, so select by accessible name.
  function reviewBtn(h: HTMLElement): HTMLButtonElement | null {
    return (
      [...h.querySelectorAll<HTMLButtonElement>("button.gbtn:not(.auto-pill)")].find((b) =>
        /^(Review|Re-review|Restart|confirm)/.test(b.textContent?.trim() ?? ""),
      ) ?? null
    );
  }

  // ── visibility ─────────────────────────────────────────────────────────────
  it("renders the Review button when open + checks success + critic enabled", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    // start state: no verdict, not reviewing → "Review" label (the new no-verdict path)
    await vi.waitFor(() => expect(reviewBtn(h), "review button present").not.toBeNull());
    expect(reviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_review());
  });

  it("hides the Review button when CI is not success", async () => {
    gitStateFn.mockResolvedValue({ ...openPrState, checks: "pending" });
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    expect(reviewBtn(h), "no review button without green CI").toBeNull();
  });

  it("hides the Review button when the PR is not open", async () => {
    gitStateFn.mockResolvedValue({
      kind: "github",
      state: "merged",
      checks: "success",
      deployConfigured: false,
    });
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByText(/merged/i)).toBeVisible();
    expect(reviewBtn(h), "no review button when not open").toBeNull();
  });

  it("hides the Review button when the repo critic is disabled", async () => {
    repoConfig.enabled = { ...repoConfig.enabled, [baseProps.repoPath]: false };
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }).element()).toBeTruthy(),
    );
    expect(reviewBtn(h), "no review button when critic disabled").toBeNull();
  });

  // ── arm → confirm → call ─────────────────────────────────────────────────────
  it("first click arms (no call), second click calls reviewPr once", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(reviewBtn(h)).not.toBeNull());

    const btn = reviewBtn(h)!;
    btn.click();
    // armed → label becomes confirm, reviewPr NOT yet called
    await vi.waitFor(() =>
      expect(reviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    expect(reviewPrFn, "not called on first (arming) click").not.toHaveBeenCalled();

    reviewBtn(h)!.click();
    await vi.waitFor(() => expect(reviewPrFn).toHaveBeenCalledTimes(1));
    expect(reviewPrFn).toHaveBeenCalledWith(baseProps.sessionId);
  });

  // ── fail-closed + skipped + started toasts ───────────────────────────────────
  async function armAndConfirm(h: HTMLElement) {
    await vi.waitFor(() => expect(reviewBtn(h)).not.toBeNull());
    reviewBtn(h)!.click();
    await vi.waitFor(() =>
      expect(reviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    reviewBtn(h)!.click();
  }

  it("'error' status raises the persistent, keyed failure toast", async () => {
    reviewPrFn.mockResolvedValue("error");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirm(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(
      m.gitrail_review_failed(),
      expect.objectContaining({
        alert: true,
        key: `review-pr:${baseProps.sessionId}`,
      }),
    );
  });

  it("a rejected reviewPr raises the failure toast", async () => {
    reviewPrFn.mockRejectedValue(new Error("boom"));
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirm(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(
      m.gitrail_review_failed(),
      expect.objectContaining({ alert: true }),
    );
  });

  it("'skipped' status raises a transient info toast", async () => {
    reviewPrFn.mockResolvedValue("skipped");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirm(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(m.gitrail_review_skipped());
  });

  it("'started' status raises NO toast (the REVIEWING badge is the feedback)", async () => {
    reviewPrFn.mockResolvedValue("started");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirm(h);
    await vi.waitFor(() => expect(reviewPrFn).toHaveBeenCalledTimes(1));
    // give any (incorrect) toast a tick to fire, then assert silence
    await new Promise((r) => setTimeout(r, 20));
    expect(toastsInfo, "no toast on started").not.toHaveBeenCalled();
  });
});

describe("GitRail — manual plan-review trigger", () => {
  beforeEach(() => {
    reviewPlanFn.mockResolvedValue("started");
    reviewPlanFn.mockClear();
    toastsInfo.mockClear();
  });
  afterEach(() => {
    planGates.drop(baseProps.sessionId);
  });

  // Find the plan-review button: a .gbtn whose text starts with "Review plan"
  // (or "Re-review plan" / "Reviewing…" / "confirm ✓" once armed/reviewing).
  function planReviewBtn(h: HTMLElement): HTMLButtonElement | null {
    return (
      [...h.querySelectorAll<HTMLButtonElement>("button.gbtn:not(.auto-pill)")].find((b) => {
        const text = b.textContent?.trim() ?? "";
        return (
          text.startsWith("Review plan") ||
          text.startsWith("Re-review plan") ||
          text === m.gitrail_reviewing_plan() ||
          text === m.gitrail_confirm_review()
        );
      }) ?? null
    );
  }

  // arm and confirm the plan-review button (two clicks)
  async function armAndConfirmPlan(h: HTMLElement) {
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());
    planReviewBtn(h)!.click();
    await vi.waitFor(() =>
      expect(planReviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    planReviewBtn(h)!.click();
  }

  // 1. renders the Review-plan button when planPhase === "planning"
  it("renders the Review-plan button when planPhase === 'planning'", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());
    expect(planReviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_review_plan());
  });

  // 2. hides the button when planPhase is null or "executing"
  it("hides the button when planPhase is null", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: null },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }).element()).toBeTruthy(),
    );
    expect(planReviewBtn(h), "no plan-review button when planPhase null").toBeNull();
  });

  it("hides the button when planPhase is 'executing'", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "executing" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: /^Merge$/i }).element()).toBeTruthy(),
    );
    expect(planReviewBtn(h), "no plan-review button when planPhase executing").toBeNull();
  });

  // 3. shows Re-review plan when a prior verdict exists in planGates.map
  it("shows Re-review plan label when a prior plan-gate verdict exists", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    // seed a prior plan gate verdict
    planGates.apply(baseProps.sessionId, {
      sessionId: baseProps.sessionId,
      planHash: "abc123",
      decision: "approved",
      summary: "looks good",
      body: "all good",
      findings: [],
      round: 0,
      cap: 3,
      approved: true,
      plan: "do stuff",
      updatedAt: Date.now(),
    });
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());
    expect(planReviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_rereview_plan());
  });

  // 4. first click arms (no call), second calls reviewPlan once
  it("first click arms (no call); second click calls reviewPlan once with session id", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());

    const btn = planReviewBtn(h)!;
    btn.click();
    // armed → label becomes confirm, reviewPlan NOT yet called
    await vi.waitFor(() =>
      expect(planReviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    expect(reviewPlanFn, "not called on first (arming) click").not.toHaveBeenCalled();

    planReviewBtn(h)!.click();
    await vi.waitFor(() => expect(reviewPlanFn).toHaveBeenCalledTimes(1));
    expect(reviewPlanFn).toHaveBeenCalledWith(baseProps.sessionId);
  });

  // 5. "skipped" (NOT reviewing) → transient info toast
  it("'skipped' (not reviewing) raises a transient info toast", async () => {
    reviewPlanFn.mockResolvedValue("skipped");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirmPlan(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(m.gitrail_review_plan_skipped());
  });

  it("'plan-unavailable' raises the specific plan artifact toast", async () => {
    reviewPlanFn.mockResolvedValue("plan-unavailable");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirmPlan(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(m.gitrail_review_plan_unavailable());
  });

  // 6. "skipped" WHILE isReviewing is true → toasts.info NOT called.
  // NOTE: Chromium disables click events on disabled buttons even via dispatchEvent,
  // so we cannot reach doReviewPlan's planReviewing guard through the DOM. Instead,
  // we verify the observable invariant: when planGates.isReviewing is true the button
  // becomes disabled, preventing any interaction — which transitively means no toast
  // can fire (the disabled state IS the guard at the DOM level). The in-handler
  // `if (planReviewing) return` acts as belt-and-suspenders for programmatic callers.
  it("'skipped' while planGates.isReviewing is true → button disabled → no interaction possible", async () => {
    reviewPlanFn.mockResolvedValue("skipped");
    gitStateFn.mockResolvedValue(openPrState);
    planGates.applyReviewing(baseProps.sessionId, true);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());
    // button must be disabled → no clicks can reach the handler → no toast
    expect(planReviewBtn(h)!.disabled, "button disabled while reviewing").toBe(true);
    // try clicking — handler must not fire because button is disabled
    planReviewBtn(h)!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(
      reviewPlanFn,
      "reviewPlan not called on click of disabled button",
    ).not.toHaveBeenCalled();
    expect(toastsInfo, "no toast when button disabled").not.toHaveBeenCalled();
  });

  // 7. any error-* status AND rejected → persistent keyed toast
  it("an error-* status raises the persistent, keyed failure toast", async () => {
    reviewPlanFn.mockResolvedValue("error-spawn");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirmPlan(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(
      m.gitrail_review_plan_failed(),
      expect.objectContaining({
        alert: true,
        key: `review-plan:${baseProps.sessionId}`,
      }),
    );
  });

  it("a rejected reviewPlan raises the failure toast", async () => {
    reviewPlanFn.mockRejectedValue(new Error("boom"));
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirmPlan(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    expect(toastsInfo).toHaveBeenCalledWith(
      m.gitrail_review_plan_failed(),
      expect.objectContaining({
        alert: true,
        key: `review-plan:${baseProps.sessionId}`,
      }),
    );
  });

  // 8. "started" → toasts.info NOT called
  it("'started' status raises NO toast", async () => {
    reviewPlanFn.mockResolvedValue("started");
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await armAndConfirmPlan(h);
    await vi.waitFor(() => expect(reviewPlanFn).toHaveBeenCalledTimes(1));
    // give any (incorrect) toast a tick to fire, then assert silence
    await new Promise((r) => setTimeout(r, 20));
    expect(toastsInfo, "no toast on started").not.toHaveBeenCalled();
  });

  // 9. button is disabled while planGates.isReviewing is true
  it("button is disabled while planGates.isReviewing is true", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    planGates.applyReviewing(baseProps.sessionId, true);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();
    await vi.waitFor(() => expect(planReviewBtn(h)).not.toBeNull());
    expect(planReviewBtn(h)!.disabled, "button disabled while reviewing").toBe(true);
  });

  // 10. Co-render arm isolation: both buttons mounted, arm one, other stays unarmed.
  // Captures stable DOM node references before any clicking to avoid re-querying
  // ambiguously when both may show "confirm ✓" text.
  it("arming plan-review button does not arm the critic button (arm isolation)", async () => {
    // enable critic so both buttons render
    repoConfig.enabled = { ...repoConfig.enabled, [baseProps.repoPath]: true };
    gitStateFn.mockResolvedValue(openPrState); // open + checks:success + critic enabled
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, mobile: false, planPhase: "planning" },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    // Capture stable DOM node references while both buttons show initial unarmed labels.
    // The critic button starts as "Review" (no prior verdict); plan button as "Review plan".
    let criticNode: HTMLButtonElement;
    let planNode: HTMLButtonElement;
    await vi.waitFor(() => {
      const allBtns = [...h.querySelectorAll<HTMLButtonElement>("button.gbtn:not(.auto-pill)")];
      const critic = allBtns.find((b) =>
        /^(Review|Re-review|Restart)$/.test(b.textContent?.trim() ?? ""),
      );
      const plan = allBtns.find((b) => (b.textContent?.trim() ?? "").startsWith("Review plan"));
      expect(critic, "critic button present").not.toBeNull();
      expect(plan, "plan button present").not.toBeNull();
      criticNode = critic!;
      planNode = plan!;
    });

    // Click plan button once → plan button armed ("confirm ✓"), critic NOT armed
    planNode!.click();
    await vi.waitFor(() => expect(planNode!.textContent?.trim()).toBe(m.gitrail_confirm_review()));
    expect(
      criticNode!.textContent?.trim(),
      "critic button NOT armed after plan button click",
    ).not.toBe(m.gitrail_confirm_review());

    // Click critic button once → critic button armed ("confirm ✓"), plan disarmed
    criticNode!.click();
    await vi.waitFor(() =>
      expect(criticNode!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    // plan button should show its unarmed "Review plan" label (NOT "confirm ✓")
    expect(
      planNode!.textContent?.trim(),
      "plan button NOT armed after critic button click",
    ).not.toBe(m.gitrail_confirm_review());

    // cleanup
    const next = { ...repoConfig.enabled };
    delete next[baseProps.repoPath];
    repoConfig.enabled = next;
  });
});

// The strip always mounts GitRail with mobile=true (Viewport.svelte), so the autopilot
// gating is asserted on that shipped path. Pre-fix, the Open PR button always rendered
// under state:none and the compose popover ignored autopilot — both cases below fail
// against pre-fix code.
describe("GitRail — Open PR hidden under autopilot", () => {
  const noneState: GitState = {
    kind: "github",
    state: "none",
    checks: "none",
    deployConfigured: false,
  };

  // find the Open PR trigger by its label text (↟ Open PR), or null when absent
  function openPrBtn(h: HTMLElement): HTMLButtonElement | null {
    return (
      [...h.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /Open PR/i.test(b.textContent ?? ""),
      ) ?? null
    );
  }

  it("shows Open PR when autopilot is off (state:none)", async () => {
    gitStateFn.mockResolvedValue(noneState);
    await page.viewport(400, 900);
    const h = host(360);
    await render(GitRail, { target: h, props: { ...baseProps, mobile: true, autopilotOn: false } });
    await vi.waitFor(() =>
      expect(openPrBtn(h), "Open PR button present when AP off").not.toBeNull(),
    );
  });

  it("hides Open PR when autopilot is on (state:none)", async () => {
    gitStateFn.mockResolvedValue(noneState);
    await page.viewport(400, 900);
    const h = host(360);
    // repoPath present → the automation pill still renders, so only the Open-PR slot
    // is empty, not the rail. Wait for the pill, then assert Open PR is absent.
    await render(GitRail, { target: h, props: { ...baseProps, mobile: true, autopilotOn: true } });
    await vi.waitFor(() =>
      expect(h.querySelector(".auto-pill"), "automation pill renders").not.toBeNull(),
    );
    expect(openPrBtn(h), "Open PR button hidden when AP on").toBeNull();
  });

  // Uses the harness (NOT rerender): the live app flips autopilot via a session:autopilot
  // WS event with the SAME sessionId, so only the autopilotOn prop changes. rerender()
  // would swap the whole prop bag and incidentally re-run GitRail's sessionId-keyed
  // session-reset effect, closing the popover regardless of the fix (vacuous). The harness
  // flips ONLY autopilotOn, so this fails against pre-fix code (popover would dangle).
  it("closes the compose popover when autopilot flips on (sessionId stable)", async () => {
    gitStateFn.mockResolvedValue(noneState);
    await page.viewport(400, 900);
    const h = host(360);
    const { component } = await render(GitRailAutopilotHarness, {
      target: h,
      props: { ...baseProps, mobile: true },
    });
    // open the popover (autopilot starts off)
    const btn = await vi.waitFor(() => {
      const b = openPrBtn(h);
      expect(b, "Open PR button present").not.toBeNull();
      return b!;
    });
    btn.click();
    await vi.waitFor(() => expect(h.querySelector(".pr-pop"), "popover open").not.toBeNull());
    // autopilot flips on (WS event) → popover must close, no submit path left
    component.setAutopilot(true);
    await vi.waitFor(() =>
      expect(h.querySelector(".pr-pop"), "popover closed after AP flips on").toBeNull(),
    );
  });
});

describe("GitRail — post-merge decommission offer", () => {
  const mergePrFn = vi.fn();

  beforeEach(() => {
    toastsInfo.mockClear();
    mergePrFn.mockClear();
    (pullMainAndToast as ReturnType<typeof vi.fn>).mockClear();
  });

  // Helper: arm and confirm the merge button (two-click pattern used across the suite)
  async function armAndConfirmMerge(h: HTMLElement) {
    const mergeBtn = await vi.waitFor(() => {
      const btn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
      expect(btn, "merge button present").not.toBeNull();
      return btn!;
    });
    mergeBtn.click();
    await vi.waitFor(() => {
      const btn = h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)");
      expect(btn?.textContent?.toLowerCase()).toMatch(/confirm/);
    });
    h.querySelector<HTMLButtonElement>("button.gbtn:not(.auto-pill)")!.click();
  }

  it("remote-forge merge (non-isolated) shows plain decommission offer with the merged session id", async () => {
    // mergePr returns a github-kind merged status; baseProps has isolated unset (→ false)
    const { mergePr: mergePrMock } = await import("$lib/api");
    (mergePrMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: false,
    });
    gitStateFn.mockResolvedValue(openPrState);

    const ondecommission = vi.fn();
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, sessionId: "sess-A", mobile: false, ondecommission },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    await armAndConfirmMerge(h);

    // Wait for toasts.info to be called
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));

    // The toast must have an action with the plain decommission label (not combo)
    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void }; duration?: number; key?: string },
    ];
    expect(opts?.action, "toast has action").toBeDefined();
    expect(opts?.action?.label, "plain decommission label").toBe(m.gitrail_decommission_action());
    expect(opts?.duration, "toast has 15s duration").toBe(15_000);
    expect(opts?.key, "toast has decommission key").toBe("decommission-offer:sess-A");

    // Invoking the action must call ondecommission with the CAPTURED id ("sess-A"),
    // not whatever session might be focused at click time.
    opts!.action!.run();
    expect(ondecommission, "ondecommission called with captured id").toHaveBeenCalledWith("sess-A");
    expect(pullMainAndToast, "pullMainAndToast NOT called for non-isolated").not.toHaveBeenCalled();
  });

  it("remote-forge merge (isolated) shows combo decommission & update offer", async () => {
    const { mergePr: mergePrMock } = await import("$lib/api");
    (mergePrMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: false,
    });
    gitStateFn.mockResolvedValue(openPrState);

    const ondecommission = vi.fn();
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: {
        ...baseProps,
        sessionId: "sess-A",
        mobile: false,
        isolated: true,
        baseBranch: "main",
        ondecommission,
      },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    await armAndConfirmMerge(h);

    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));

    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void }; duration?: number; key?: string },
    ];
    expect(opts?.action, "toast has action").toBeDefined();
    expect(opts?.action?.label, "combo label").toBe(m.gitrail_decommission_update_action());
    expect(opts?.duration, "toast has 15s duration").toBe(15_000);
    expect(opts?.key, "toast has decommission key").toBe("decommission-offer:sess-A");

    opts!.action!.run();
    expect(ondecommission, "ondecommission called with captured id").toHaveBeenCalledWith("sess-A");
    expect(
      pullMainAndToast,
      "pullMainAndToast called with repoPath and baseBranch",
    ).toHaveBeenCalledWith("/repo", "main");
  });

  it("combo action captures repoPath/baseBranch at merge time, not at click time", async () => {
    // Regression: GitRail is reused across session switches (no {#key} wrapper in Viewport).
    // Merging session A (repoPath "/repo"), then switching to session B (repoPath "/other")
    // within the 15s toast window must still FF "/repo", not "/other".
    const { mergePr: mergePrMock } = await import("$lib/api");
    (mergePrMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: false,
    });
    gitStateFn.mockResolvedValue(openPrState);

    const ondecommission = vi.fn();
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: {
        ...baseProps,
        sessionId: "sess-A",
        mobile: false,
        isolated: true,
        baseBranch: "main",
        ondecommission,
      },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    await armAndConfirmMerge(h);

    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));

    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void }; duration?: number; key?: string },
    ];
    expect(opts?.action, "toast has action").toBeDefined();

    // Simulate session switch: rebind the component to a different session (repo Y)
    // before the operator clicks the toast action — mirrors the live Viewport behaviour.
    await screen.rerender({
      ...baseProps,
      sessionId: "sess-B",
      mobile: false,
      isolated: true,
      repoPath: "/other",
      baseBranch: "release",
      ondecommission,
    });

    // Invoke the captured action — must use the values snapshotted at merge time.
    opts!.action!.run();
    expect(
      pullMainAndToast,
      "pullMainAndToast called with captured (/repo, main), not live (/other, release)",
    ).toHaveBeenCalledWith("/repo", "main");
    expect(
      pullMainAndToast,
      "pullMainAndToast NOT called with live props",
    ).not.toHaveBeenCalledWith("/other", "release");
  });

  it("combo action captures the isolated flag at merge time, not at click time", async () => {
    // Regression: the `isolated` flag must be snapshotted before the merge await alongside
    // the FF target. Merging an isolated session, then switching to a NON-isolated session
    // within the 15s window, must still fast-forward (captured isolated=true wins) rather
    // than reading the rebound live flag and silently skipping the pull.
    const { mergePr: mergePrMock } = await import("$lib/api");
    (mergePrMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "github",
      state: "merged",
      checks: "none",
      deployConfigured: false,
    });
    gitStateFn.mockResolvedValue(openPrState);

    const ondecommission = vi.fn();
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: {
        ...baseProps,
        sessionId: "sess-A",
        mobile: false,
        isolated: true,
        baseBranch: "main",
        ondecommission,
      },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    await armAndConfirmMerge(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));

    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void } },
    ];

    // Switch to a NON-isolated session before clicking the toast action.
    await screen.rerender({
      ...baseProps,
      sessionId: "sess-B",
      mobile: false,
      isolated: false,
      ondecommission,
    });

    opts!.action!.run();
    expect(
      pullMainAndToast,
      "pull still fires with captured isolated=true despite live isolated=false",
    ).toHaveBeenCalledWith("/repo", "main");
  });

  it("local-forge merge → no decommission offer action", async () => {
    const { mergePr: mergePrMock } = await import("$lib/api");
    (mergePrMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "local",
      state: "merged",
      checks: "none",
      deployConfigured: false,
    });
    gitStateFn.mockResolvedValue(openPrState);

    const ondecommission = vi.fn();
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, {
      target: h,
      props: { ...baseProps, sessionId: "sess-B", mobile: false, ondecommission },
    });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    await armAndConfirmMerge(h);

    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));

    const call = toastsInfo.mock.calls[0] as [string, ({ action?: unknown } | undefined)?];
    // local-forge toast: plain call with no action opts, OR opts without action
    const opts = call[1];
    expect(opts?.action ?? undefined, "no action on local-forge toast").toBeUndefined();
    expect(ondecommission, "ondecommission never invoked").not.toHaveBeenCalled();
  });
});

describe("GitRail — automation panel close affordance + overflow fix", () => {
  // AutomationPanel additionally gates a full-screen-sheet layout on the REAL
  // `@media (pointer: coarse)` query, which this headless mouse-driven runner has
  // no way to force true (mocking `window.matchMedia` only fools JS reads of it —
  // the browser's own CSS engine still resolves the stylesheet's `@media` block
  // against the actual hardware pointer). So this suite covers what's verifiable
  // here: the `.auto-close` button's JS wiring (mocking matchMedia to flip the
  // component's `touch` state, which drives aria-modal/focus-trap/dialog
  // semantics), and the pointer-independent overflow-x fix. The `@media
  // (pointer: coarse)` visual layout itself mirrors `.review-pop`'s already-shipped
  // touch sheet in this same file, verified only by manual/device testing.
  let matchMediaSpy: ReturnType<typeof vi.spyOn> | undefined;
  function mockPointer(coarse: boolean) {
    const real = window.matchMedia.bind(window);
    matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      if (query === "(pointer: coarse)") {
        return {
          matches: coarse,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null,
        } as unknown as MediaQueryList;
      }
      return real(query);
    });
  }
  afterEach(() => {
    matchMediaSpy?.mockRestore();
  });

  async function openAutomation(h: HTMLElement) {
    const pill = h.querySelector<HTMLButtonElement>("button.auto-pill");
    expect(pill, "auto-pill present").not.toBeNull();
    pill!.click();
    const dialog = await vi.waitFor(() => {
      const d = h.querySelector<HTMLElement>(".auto-pop");
      expect(d, "automation panel opened").not.toBeNull();
      return d!;
    });
    return { pill: pill!, dialog };
  }

  it("clips horizontal overflow instead of letting the whole panel be dragged sideways", async () => {
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(600, 900);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openAutomation(h);
    // Regression: `overflow-y: auto` alone left `overflow-x` computed as "auto"
    // too (per the CSS overflow spec — visible on one axis + non-visible on the
    // other isn't renderable), so a row a hair wider than the box made the WHOLE
    // panel horizontally pannable instead of just clipping.
    expect(getComputedStyle(dialog).overflowX, "overflow-x pinned to hidden").toBe("hidden");
  });

  it("close button's click handler dismisses the panel (touch dialog semantics)", async () => {
    mockPointer(true);
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(390, 844);
    const h = host(390);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: true } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openAutomation(h);
    expect(dialog.getAttribute("aria-modal"), "touch dialog is modal").toBe("true");
    const closeBtn = dialog.querySelector<HTMLButtonElement>(
      `button[aria-label="${m.common_close()}"]`,
    );
    expect(closeBtn, "close button present").not.toBeNull();
    closeBtn!.click();
    await vi.waitFor(() => {
      expect(h.querySelector(".auto-pop"), "panel closed").toBeNull();
    });
  });

  it("desktop (fine pointer) keeps the non-modal anchored popover, close head hidden", async () => {
    mockPointer(false);
    gitStateFn.mockResolvedValue(openPrState);
    await page.viewport(1024, 800);
    const h = host(600);
    const screen = await render(GitRail, { target: h, props: { ...baseProps, mobile: false } });
    await expect.element(screen.getByTitle("PR #12345")).toBeVisible();

    const { dialog } = await openAutomation(h);
    expect(dialog.getAttribute("aria-modal"), "desktop popover stays non-modal").toBeNull();
    const head = dialog.querySelector<HTMLElement>(".auto-pop-head");
    expect(head, "head element present in DOM").not.toBeNull();
    expect(getComputedStyle(head!).display, "close-button head hidden on desktop").toBe("none");
  });
});
