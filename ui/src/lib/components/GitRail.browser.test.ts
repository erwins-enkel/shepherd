import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { GitState } from "$lib/types";

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

// Deterministic measurement: pin the rail's font so CI (no Berkeley Mono) and
// local agree. The rail mounts into a fixed-width host cell (a session row's git
// column); overflow within that cell is the failure we guard against.
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
// exactly what we want so assertControlsWithin can catch overflows directly.
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
  const cellRect = cell.getBoundingClientRect();
  const controls = wrap!.querySelectorAll<HTMLElement>("button, a[href]");
  expect(controls.length, "rail has controls").toBeGreaterThan(0);
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const label = c.getAttribute("aria-label") || c.textContent?.trim() || c.className;
    // Labels may ellipsis-truncate, but the clickable element must stay sized
    // and within the cell's left and right edges (2px slack for borders/rounding).
    expect(r.width, `${label} zero width`).toBeGreaterThan(0);
    expect(r.height, `${label} zero height`).toBeGreaterThan(0);
    expect(r.left, `${label} escapes cell left edge`).toBeGreaterThanOrEqual(cellRect.left - 2);
    expect(r.right, `${label} escapes cell right edge`).toBeLessThanOrEqual(cellRect.right + 2);
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
    assertControlsWithin(h);
  });

  it("mobile 360px — open, mergeable:false → Merge button disabled, all controls in-bounds", async () => {
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
  it("mobile 360px — open, Merge armed → 'confirm ✓' label fits in cell (key stressor)", async () => {
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

    // Assert all controls (including the now-armed "confirm ✓" button) stay in-bounds.
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
