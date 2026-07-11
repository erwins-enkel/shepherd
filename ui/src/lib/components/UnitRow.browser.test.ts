import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import UnitRow from "./UnitRow.svelte";
import { projectIcons } from "$lib/projectIcons.svelte";
import type { HoldReason, PlanGate, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import type { ReviewVerdict } from "$lib/types";

// Mock api so the reviews store's load() never fires real network calls, and so the
// hold-row CTA's three fail-closed calls (releasePlanGate/reviewPlan/resumeQuota) are
// under test control instead of hitting the network.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getReviews: vi.fn(async () => ({})),
    getReviewingIds: vi.fn(async () => []),
    releasePlanGate: vi.fn(async () => true),
    reviewPlan: vi.fn(async () => "started" as const),
    resumeQuota: vi.fn(async () => ({ status: "resumed" as const })),
    retryCi: vi.fn(
      async () => ({ ok: true }) as { ok: boolean; reason?: "unsupported" | "no-run" },
    ),
  };
});

const { reviews, planGates, repoConfig } = await import("$lib/reviews.svelte");
const { releasePlanGate, reviewPlan, resumeQuota, retryCi } = await import("$lib/api");
const { toasts } = await import("$lib/toasts.svelte");

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

const baseVerdict: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "commented",
  summary: "",
  body: "## findings",
  findings: [],
  addressRound: 0,
  addressCap: 5,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: Date.now(),
};

const baseGate: PlanGate = {
  sessionId: "s1",
  planHash: "h",
  decision: "changes_requested",
  summary: "tighten scope",
  body: "",
  findings: ["tighten scope"],
  round: 3,
  cap: 3,
  approved: false,
  plan: "# Plan",
  blocks: [],
  updatedAt: Date.now(),
};

beforeEach(() => {
  reviews.reviewing = {};
  reviews.map = {};
  planGates.reviewing = {};
  planGates.map = {};
  repoConfig.previewOpenMode = {};
  repoConfig.loaded = {};
  repoConfig.settled = {};
  toasts.items = [];
  vi.mocked(releasePlanGate).mockReset().mockResolvedValue(true);
  vi.mocked(reviewPlan).mockReset().mockResolvedValue("started");
  vi.mocked(resumeQuota).mockReset().mockResolvedValue({ status: "resumed" });
  vi.mocked(retryCi).mockReset().mockResolvedValue({ ok: true });
});

function loadPreviewMode(repoPath: string, mode: "ask" | "inline" | "tab" = "ask") {
  repoConfig.previewOpenMode = { ...repoConfig.previewOpenMode, [repoPath]: mode };
  repoConfig.loaded = { ...repoConfig.loaded, [repoPath]: true };
  repoConfig.settled = { ...repoConfig.settled, [repoPath]: true };
}

describe("UnitRow merging badge", () => {
  it("shows MERGING for a merging session, not READY", async () => {
    const now = Date.now();
    render(UnitRow, {
      session: session({
        id: "a",
        readyToMerge: true,
        mergingSince: now - 1000,
        mergingTrainId: "t",
      }),
      selected: false,
      nowMs: now,
      onselect: () => {},
    });
    await expect.element(page.getByText("MERGING")).toBeInTheDocument();
    await expect.element(page.getByText("READY")).not.toBeInTheDocument();
  });

  it("shows READY for a ready-to-merge session that is not merging", async () => {
    render(UnitRow, {
      session: session({ id: "b", readyToMerge: true }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText("READY")).toBeInTheDocument();
    await expect.element(page.getByText("MERGING")).not.toBeInTheDocument();
  });
});

describe("UnitRow preview badge", () => {
  // The badge text bubbles into the row button's accessible name too, so match the
  // badge precisely by its title attribute rather than the ambiguous role+name.
  it("renders the Preview badge only when a preview port is bound", async () => {
    loadPreviewMode("/repo/a");
    render(UnitRow, {
      session: session({ id: "p1" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8001,
    });
    await expect.element(page.getByTitle("Preview")).toBeInTheDocument();
  });

  it("omits the Preview badge when no preview port is bound", async () => {
    render(UnitRow, {
      session: session({ id: "p2" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: null,
    });
    await expect.element(page.getByTitle("Preview")).not.toBeInTheDocument();
  });

  it("clicking the badge calls onpreview with the session id (not onselect twice)", async () => {
    loadPreviewMode("/repo/a", "inline");
    let previewed: string | null = null;
    let target: "inline" | "tab" | undefined;
    let selects = 0;
    render(UnitRow, {
      session: session({ id: "p3" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => selects++,
      previewPort: 8002,
      onpreview: (id: string, t?: "inline" | "tab") => {
        previewed = id;
        target = t;
      },
    });
    await page.getByTitle("Preview").click();
    expect(previewed).toBe("p3");
    expect(target).toBe("inline");
    // the badge stops propagation, so the row's own select doesn't also fire
    expect(selects).toBe(0);
  });

  it("keeps the badge above the row hit overlay for real pointer targeting", async () => {
    loadPreviewMode("/repo/a", "inline");
    render(UnitRow, {
      session: session({ id: "p3b" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: () => {},
    });
    const badge = page.getByTitle("Preview").element() as HTMLElement;
    const rect = badge.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(hit).toBe(badge);
  });

  it("ask mode opens a chooser and routes each choice", async () => {
    loadPreviewMode("/repo/a", "ask");
    const calls: Array<[string, "inline" | "tab" | undefined]> = [];
    render(UnitRow, {
      session: session({ id: "p4" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: (id: string, target?: "inline" | "tab") => calls.push([id, target]),
    });
    await page.getByTitle("Preview").click();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .toBeInTheDocument();
    expect(document.querySelector(".preview-choice")?.closest(".unit")).toBeNull();
    await page.getByRole("button", { name: "Open inline" }).click();
    expect(calls).toEqual([["p4", "inline"]]);
  });

  it("ask mode closes the chooser when the preview port unbinds", async () => {
    loadPreviewMode("/repo/a", "ask");
    const props = {
      session: session({ id: "p4a" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: () => {},
    };
    const screen = await render(UnitRow, props);
    await page.getByTitle("Preview").click();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .toBeInTheDocument();

    await screen.rerender({ ...props, previewPort: null });

    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .not.toBeInTheDocument();
  });

  it("ask mode keeps the chooser inside the viewport near the bottom edge", async () => {
    loadPreviewMode("/repo/a", "ask");
    render(UnitRow, {
      session: session({ id: "p4b" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: () => {},
    });
    const badge = page.getByTitle("Preview").element();
    const anchor = badge.parentElement as HTMLElement;
    const anchorRect = DOMRect.fromRect({
      x: 120,
      y: window.innerHeight - 12,
      width: 80,
      height: 8,
    });
    const rectSpy = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(anchorRect);

    await page.getByTitle("Preview").click();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .toBeInTheDocument();
    const choice = document.querySelector(".preview-choice") as HTMLElement;
    const top = Number.parseFloat(choice.style.top);
    expect(top).toBeLessThan(anchorRect.top);
    expect(top + choice.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
    rectSpy.mockRestore();
  });

  it("ask mode closes the chooser on Escape while focus is inside it", async () => {
    loadPreviewMode("/repo/a", "ask");
    render(UnitRow, {
      session: session({ id: "p4c" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: () => {},
    });
    await page.getByTitle("Preview").click();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .toBeInTheDocument();
    const inline = page.getByRole("button", { name: "Open inline" }).element();
    inline.focus();
    inline.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .not.toBeInTheDocument();
  });

  it("tab mode bypasses the chooser", async () => {
    loadPreviewMode("/repo/a", "tab");
    const calls: Array<[string, "inline" | "tab" | undefined]> = [];
    render(UnitRow, {
      session: session({ id: "p5" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: (id: string, target?: "inline" | "tab") => calls.push([id, target]),
    });
    await page.getByTitle("Preview").click();
    expect(calls).toEqual([["p5", "tab"]]);
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .not.toBeInTheDocument();
  });

  it("does not fall back to ask while repo config is not loaded", async () => {
    const onpreview = vi.fn();
    render(UnitRow, {
      session: session({ id: "p6" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview,
    });
    await page.getByTitle("Loading repo preview setting").click({ force: true });
    expect(onpreview).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .not.toBeInTheDocument();
  });

  it("falls back to ask after repo config loading fails", async () => {
    repoConfig.settled = { "/repo/a": true };
    const calls: Array<[string, "inline" | "tab" | undefined]> = [];
    render(UnitRow, {
      session: session({ id: "p7" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      previewPort: 8002,
      onpreview: (id: string, target?: "inline" | "tab") => calls.push([id, target]),
    });
    await page.getByTitle("Preview").click();
    await expect
      .element(page.getByRole("dialog", { name: "Choose preview target" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Open inline" }).click();
    expect(calls).toEqual([["p7", "inline"]]);
  });
});

describe("UnitRow context menu", () => {
  function openMenu(rowName: string) {
    const hit = page.getByRole("button", { name: m.unit_open_aria({ name: rowName }) });
    hit
      .element()
      .dispatchEvent(
        new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
      );
  }

  it("offers Rename and calls the row rename handler", async () => {
    const onrename = vi.fn();
    render(UnitRow, {
      session: session({ id: "rename-row", name: "rename row" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      onrename,
    });

    openMenu("rename row");

    await page.getByRole("menuitem", { name: m.cardmenu_rename() }).click();

    expect(onrename).toHaveBeenCalledWith("rename-row");
  });

  it("offers Continue with for an open-PR in-flight row", async () => {
    const onreplace = vi.fn();
    render(UnitRow, {
      session: session({ id: "replace-row", name: "replace row", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      git: { state: "open" } as never,
      onreplace,
    });

    openMenu("replace row");

    await page.getByRole("menuitem", { name: m.cardmenu_replace_with() }).click();
    expect(onreplace).toHaveBeenCalledWith("replace-row", { x: 40, y: 40 });
  });

  it("does not offer Continue with for concluded rows", async () => {
    render(UnitRow, {
      session: session({ id: "merged-row", name: "merged row", readyToMerge: true }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      git: { state: "merged" } as never,
      onreplace: vi.fn(),
    });

    openMenu("merged row");

    await expect.element(page.getByText(m.cardmenu_replace_with())).not.toBeInTheDocument();
  });
});

describe("UnitRow inline repo emoji filter", () => {
  // The emoji's title carries the repo name (hover reveal); match it precisely.
  it("clicking the emoji scopes the filter to this repo (non-additive) without selecting the row", async () => {
    projectIcons.apply({ "/repo/a": "🐑" });
    const onrepofilter = vi.fn();
    let selects = 0;
    render(UnitRow, {
      session: session({ id: "f1" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => selects++,
      repoFilter: new Set<string>(),
      onrepofilter,
    });
    await page.getByTitle("a", { exact: true }).click();
    // the card emoji is always a plain (non-additive) select — Shift multi-select lives on the pills
    expect(onrepofilter).toHaveBeenCalledWith("/repo/a", false);
    expect(selects).toBe(0);
  });

  it("shows the emoji as pressed when this repo is in the active filter", async () => {
    projectIcons.apply({ "/repo/a": "🐑" });
    const onrepofilter = vi.fn();
    render(UnitRow, {
      session: session({ id: "f2" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      repoFilter: new Set(["/repo/a"]),
      onrepofilter,
    });
    const icon = page.getByTitle("a", { exact: true });
    await expect.element(icon).toHaveAttribute("aria-pressed", "true");
    await icon.click();
    // clicking still reports (path, false) — the page's nextRepoFilter clears the sole selection
    expect(onrepofilter).toHaveBeenCalledWith("/repo/a", false);
  });

  it("renders a non-interactive emoji when no onrepofilter is wired", async () => {
    projectIcons.apply({ "/repo/a": "🐑" });
    render(UnitRow, {
      session: session({ id: "f3" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    // the emoji still renders, but as plain decoration — no filter button
    await expect.element(page.getByText("🐑")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /repo/i })).not.toBeInTheDocument();
  });
});

describe("UnitRow working-while-blocked (full working treatment)", () => {
  // What the FULL working treatment looks like on a row — asserted identically
  // for a raw-running session and a blocked+flagged one, so the two renders
  // can't drift apart: the working pip (not the red "!" alarm badge), the typing
  // caret, and the live activity line. The amber StatusPip carries the running
  // state on a row, so there's no separate working-line element to assert.
  async function expectWorkingAffordances(root: HTMLElement) {
    await expect.element(page.getByText(m.status_blocked())).not.toBeInTheDocument();
    const pipLabel = m.statuspip_status_aria({ status: m.status_working() });
    await expect.element(page.getByRole("img", { name: pipLabel })).toBeInTheDocument();
    expect(root.querySelector(".pip.badge"), "no red ! alarm pip").toBeNull();
    expect(root.querySelector(".car"), "typing caret present").not.toBeNull();
    expect(
      root.querySelector(".unit")?.classList.contains("has-activity"),
      "live activity line",
    ).toBe(true);
  }

  it("a blocked session flagged working renders identical to a raw-running one", async () => {
    render(UnitRow, {
      session: session({ id: "wb", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      workingBlocked: { wb: true },
    });
    await expectWorkingAffordances(document.body);
  });

  it("baseline: a raw-running session shows the same affordances", async () => {
    render(UnitRow, {
      session: session({ id: "run", status: "running" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expectWorkingAffordances(document.body);
  });

  it("a blocked session WITHOUT the flag keeps the blocked treatment", async () => {
    render(UnitRow, {
      session: session({ id: "blk", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      workingBlocked: {},
    });
    // The status slot is empty for a blocked row (no text) — the red "!" alarm
    // StatusPip on the left carries the blocked state instead.
    expect(document.body.querySelector(".pip.badge"), "red ! alarm pip").not.toBeNull();
    expect(document.body.querySelector(".car"), "no typing caret").toBeNull();
  });
});

describe("UnitRow fine-pointer decommission ✕", () => {
  // vitest browser mode runs a real fine-pointer browser, so coarse.current is
  // false and the hover ✕ (not the swipe reveal) is the affordance under test.
  it("renders the ✕ button only when ondecommission is wired", async () => {
    render(UnitRow, {
      session: session({ id: "d0" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect
      .element(page.getByRole("button", { name: "decommission unit" }))
      .not.toBeInTheDocument();
  });

  it("two-step: first click arms (no fire), second click decommissions — never selects the row", async () => {
    let decommissioned: string | null = null;
    let selects = 0;
    render(UnitRow, {
      session: session({ id: "d1" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => selects++,
      ondecommission: (id: string) => (decommissioned = id),
    });
    const decom = page.getByRole("button", { name: "decommission unit" });
    await expect.element(decom).toBeInTheDocument();
    // the idle ✕ is invisible AND pointer-inert (pointer-events: none) — real CSS
    // applies here, so reveal it the way a user would: hover the row first, which
    // re-enables pointer events via the (hover:hover)+(pointer:fine) reveal rule
    await page.getByRole("button", { name: "Open task one" }).hover();
    await decom.click();
    expect(decommissioned).toBe(null); // armed, not fired
    // arming swaps the label to the confirm state; the second click fires
    await page.getByRole("button", { name: "confirm ✕" }).click();
    expect(decommissioned).toBe("d1");
    // the ✕ sits above the row overlay as a sibling — the row select never fires
    expect(selects).toBe(0);
  });
});

describe("UnitRow badge mutual-exclusion (reviewing vs autopilot/status)", () => {
  it("reviewing + autopilotPaused: REVIEWING… shown, Needs you and WAITING hidden", async () => {
    const s = session({ id: "mx1", status: "done", autopilotPaused: true });
    reviews.reviewing = { mx1: true };
    render(UnitRow, {
      session: s,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText(m.criticbadge_reviewing())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.session_autopilot_paused_label()))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(m.status_done())).not.toBeInTheDocument();
  });

  it("verdict + autopilotPaused (not reviewing): Needs you and verdict shown, WAITING hidden", async () => {
    const s = session({ id: "mx2", status: "done", autopilotPaused: true });
    reviews.map = { mx2: { ...baseVerdict, sessionId: "mx2", decision: "commented" } };
    render(UnitRow, {
      session: s,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText(m.session_autopilot_paused_label())).toBeInTheDocument();
    await expect.element(page.getByText(m.criticbadge_commented())).toBeInTheDocument();
    await expect.element(page.getByText(m.status_done())).not.toBeInTheDocument();
  });
});

describe("UnitRow quota-stalled badge", () => {
  it("shows the quota badge when quotaKind is set", async () => {
    render(UnitRow, {
      session: session({ id: "qb1", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      quotaKind: "rework",
    });
    await expect.element(page.getByText(m.unitrow_quota_rework())).toBeInTheDocument();
  });

  it("shows the correct label per quotaKind", async () => {
    render(UnitRow, {
      session: session({ id: "qb2", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      quotaKind: "review",
    });
    await expect.element(page.getByText(m.unitrow_quota_review())).toBeInTheDocument();
  });

  it("does NOT show the quota badge when quotaKind is null", async () => {
    render(UnitRow, {
      session: session({ id: "qb3", status: "idle" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByText(m.unitrow_quota_rework())).not.toBeInTheDocument();
    await expect.element(page.getByText(m.unitrow_quota_review())).not.toBeInTheDocument();
    await expect.element(page.getByText(m.unitrow_quota_error())).not.toBeInTheDocument();
    await expect.element(page.getByText(m.unitrow_quota_plan())).not.toBeInTheDocument();
  });

  it("badge has the correct title for accessibility", async () => {
    render(UnitRow, {
      session: session({ id: "qb4", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      quotaKind: "plan",
    });
    await expect.element(page.getByTitle(m.unitrow_quota_title())).toBeInTheDocument();
  });

  it("opens the stalled-plan menu from the Plan stalled quota chip", async () => {
    const id = "qb5";
    planGates.map = { [id]: { ...baseGate, sessionId: id } };

    render(UnitRow, {
      session: session({ id, status: "blocked", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      quotaKind: "plan",
    });

    await page.getByRole("button", { name: m.unitrow_quota_plan() }).click();
    await expect.element(page.getByRole("menu", { name: m.plangate_menu_label() })).toBeVisible();
  });
});

describe("UnitRow hold subline", () => {
  it("truncates a long hold line on the inner .u-hold-text span", async () => {
    render(UnitRow, {
      session: session({ id: "h1" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      hold: {
        code: "autopilot-paused",
        params: {
          question:
            "Should I use the existing retry helper or write a bespoke backoff loop for this new queue consumer?",
        },
      },
    });
    const holdEl = document.body.querySelector(".u-hold");
    const textEl = document.body.querySelector(".u-hold-text");
    expect(holdEl, ".u-hold present").not.toBeNull();
    expect(textEl, ".u-hold-text present").not.toBeNull();
    expect(textEl?.textContent).toContain("Should I use the existing retry helper");
    const style = getComputedStyle(textEl as HTMLElement);
    expect(style.overflow).toBe("hidden");
    expect(style.textOverflow).toBe("ellipsis");
    expect(style.whiteSpace).toBe("nowrap");
  });
});

describe("UnitRow plan-gate hold CTA", () => {
  it("headline: awaiting-rereview line + Re-review button", async () => {
    const id = "hc1";
    planGates.map = {
      [id]: {
        ...baseGate,
        sessionId: id,
        decision: "changes_requested",
        round: 1,
        cap: 3,
        dismissed: false,
        blocks: [],
        approved: false,
      },
    };
    render(UnitRow, {
      session: session({ id, status: "idle", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect
      .element(page.getByText(m.hold_awaiting_rereview({ round: 1, cap: 3 })))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.hold_cta_rereview() }))
      .toBeInTheDocument();
  });

  it("ready + Go arm: first click arms (Go?, no call yet), second click releases the gate", async () => {
    const id = "hc2";
    planGates.map = {
      [id]: {
        ...baseGate,
        sessionId: id,
        decision: "approved",
        approved: true,
        round: 0,
        cap: 3,
        dismissed: false,
        blocks: [],
      },
    };
    render(UnitRow, {
      session: session({ id, status: "idle", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByRole("button", { name: m.hold_cta_go() })).toBeInTheDocument();
    await page.getByRole("button", { name: m.hold_cta_go() }).click();
    await expect
      .element(page.getByRole("button", { name: m.hold_cta_go_arm() }))
      .toBeInTheDocument();
    expect(releasePlanGate).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.hold_cta_go_arm() }).click();
    expect(releasePlanGate).toHaveBeenCalledTimes(1);
    expect(releasePlanGate).toHaveBeenCalledWith(id);
  });

  it("no optimistic hide on a false release: Go CTA stays, persistent toast raised", async () => {
    const id = "hc3";
    vi.mocked(releasePlanGate).mockResolvedValue(false);
    planGates.map = {
      [id]: {
        ...baseGate,
        sessionId: id,
        decision: "approved",
        approved: true,
        round: 0,
        cap: 3,
        dismissed: false,
        blocks: [],
      },
    };
    render(UnitRow, {
      session: session({ id, status: "idle", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await page.getByRole("button", { name: m.hold_cta_go() }).click();
    await page.getByRole("button", { name: m.hold_cta_go_arm() }).click();
    await vi.waitFor(() => expect(releasePlanGate).toHaveBeenCalledTimes(1));
    // Never optimistically hidden: the CTA disappears only when the WS gate update
    // arrives (it never did here), so it must still be present — not disarmed-as-success.
    await expect.element(page.getByRole("button", { name: m.hold_cta_go() })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.hold_cta_go_failed())).toBe(true),
    );
    const t = toasts.items.find((x) => x.text === m.hold_cta_go_failed())!;
    expect(t.durationMs).toBe(12000); // 12s failure — auto-dismisses
  });

  it("ci-red hold: Retry CI arms then reruns via retryCi(repoPath, pr) (#1629)", async () => {
    const id = "hcci";
    render(UnitRow, {
      // non-planning session with a ci-red hold carrying its PR → R1b ci-retry
      session: session({ id, status: "idle", planPhase: "executing", repoPath: "/repo/z" }),
      hold: { code: "ci-red", params: { pr: 42 } },
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect
      .element(page.getByRole("button", { name: m.hold_cta_retry_ci() }))
      .toBeInTheDocument();
    // First click only arms (touches CI) — label swaps, no call yet.
    await page.getByRole("button", { name: m.hold_cta_retry_ci() }).click();
    await expect
      .element(page.getByRole("button", { name: m.hold_cta_retry_ci_arm() }))
      .toBeInTheDocument();
    expect(retryCi).not.toHaveBeenCalled();
    // Second click fires with the repo + PR from the hold.
    await page.getByRole("button", { name: m.hold_cta_retry_ci_arm() }).click();
    await vi.waitFor(() => expect(retryCi).toHaveBeenCalledTimes(1));
    expect(retryCi).toHaveBeenCalledWith("/repo/z", 42);
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.hold_cta_retry_ci_started())).toBe(true),
    );
  });

  it("ci-red hold: retryCi throwing raises a persistent alert toast (#1629)", async () => {
    const id = "hcci2";
    vi.mocked(retryCi).mockRejectedValue(new Error("boom"));
    render(UnitRow, {
      session: session({ id, status: "idle", planPhase: "executing" }),
      hold: { code: "ci-red", params: { pr: 7 } },
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await page.getByRole("button", { name: m.hold_cta_retry_ci() }).click();
    await page.getByRole("button", { name: m.hold_cta_retry_ci_arm() }).click();
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.hold_cta_retry_ci_failed())).toBe(true),
    );
    const t = toasts.items.find((x) => x.text === m.hold_cta_retry_ci_failed())!;
    expect(t.durationMs).toBe(12000); // 12s failure — auto-dismisses
  });

  it("busy: disables the CTA until the pending release settles", async () => {
    const id = "hc4";
    let resolve!: (v: boolean) => void;
    vi.mocked(releasePlanGate).mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r;
      }),
    );
    planGates.map = {
      [id]: {
        ...baseGate,
        sessionId: id,
        decision: "approved",
        approved: true,
        round: 0,
        cap: 3,
        dismissed: false,
        blocks: [],
      },
    };
    render(UnitRow, {
      session: session({ id, status: "idle", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await page.getByRole("button", { name: m.hold_cta_go() }).click(); // arm
    await page.getByRole("button", { name: m.hold_cta_go_arm() }).click(); // fire (disarms sync)
    const btn = page.getByRole("button", { name: m.hold_cta_go() });
    await expect.element(btn).toBeDisabled();
    resolve(true);
    await expect.element(btn).not.toBeDisabled();
  });
});

describe("UnitRow answer CTA (non-plan hold)", () => {
  it("renders an Answer CTA for an autopilot-paused row and click calls onselect", async () => {
    let selected: string | null = null;
    render(UnitRow, {
      session: session({ id: "ap1", planPhase: "executing", status: "idle" }),
      selected: false,
      nowMs: Date.now(),
      onselect: (id: string) => (selected = id),
      hold: { code: "autopilot-paused" },
    });
    const btn = page.getByTitle(m.hold_cta_answer_reply_title());
    await expect.element(btn).toBeInTheDocument();
    await btn.click();
    expect(selected).toBe("ap1");
  });
});

describe("UnitRow manual-steps chip", () => {
  // The chip's text content (the count) bubbles into the accessible name too, so match it
  // precisely by its title attribute rather than the ambiguous role+name (same pattern as the
  // Preview badge tests above).
  it("is a button and fires onshowowed with the session id, not onselect, when clicked", async () => {
    let shown: string | null = null;
    let selects = 0;
    render(UnitRow, {
      session: session({
        id: "ms1",
        manualSteps: [{ id: "m1", text: "do a thing", postMerge: true }],
      }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => selects++,
      onshowowed: (id: string) => (shown = id),
    });
    await page.getByTitle(m.unitrow_manual_steps_link()).click();
    expect(shown).toBe("ms1");
    // the chip stops propagation, so the row's own select doesn't also fire
    expect(selects).toBe(0);
  });

  it("stays a static span (no button) when onshowowed is not provided", async () => {
    render(UnitRow, {
      session: session({
        id: "ms2",
        manualSteps: [{ id: "m1", text: "do a thing", postMerge: true }],
      }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
    });
    await expect.element(page.getByTitle(m.unitrow_manual_steps_link())).not.toBeInTheDocument();
    await expect.element(page.getByText(m.unitrow_manual_steps({ count: 1 }))).toBeInTheDocument();
  });

  // #1478: on a merged/closed card the auto-merge gate the Ack CTA used to clear no longer
  // exists, so it must not render there; the count chip becomes the actual resolution route
  // and gets a verb label on merged cards to read as the action.
  it("open card: shows the Ack CTA and the neutral count-chip label", async () => {
    let acked: string | null = null;
    let shown: string | null = null;
    render(UnitRow, {
      session: session({
        id: "ms3",
        manualSteps: [{ id: "m1", text: "do a thing", postMerge: false }],
        manualStepsAckedAt: null,
      }),
      git: { state: "open" } as never,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      onackmanualsteps: (id: string) => (acked = id),
      onshowowed: (id: string) => (shown = id),
    });
    const ackBtn = page.getByTitle(m.unitrow_ack_manual_steps());
    await expect.element(ackBtn).toBeInTheDocument();
    await ackBtn.click();
    expect(acked).toBe("ms3");
    await expect.element(page.getByText(m.unitrow_manual_steps({ count: 1 }))).toBeInTheDocument();
    expect(shown).toBe(null);
  });

  it("merged card: hides the Ack CTA and verb-labels the count chip → onshowowed", async () => {
    let acked: string | null = null;
    let shown: string | null = null;
    render(UnitRow, {
      session: session({
        id: "ms4",
        manualSteps: [{ id: "m1", text: "do a thing", postMerge: false }],
        manualStepsAckedAt: null,
      }),
      git: { state: "merged" } as never,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      onackmanualsteps: (id: string) => (acked = id),
      onshowowed: (id: string) => (shown = id),
    });
    await expect.element(page.getByTitle(m.unitrow_ack_manual_steps())).not.toBeInTheDocument();
    const chip = page.getByText(m.unitrow_resolve_manual_steps({ count: 1 }));
    await expect.element(chip).toBeInTheDocument();
    await chip.click();
    expect(shown).toBe("ms4");
    expect(acked).toBe(null);
  });

  it("closed card: hides the Ack CTA and keeps the neutral count-chip label → onshowowed", async () => {
    let acked: string | null = null;
    let shown: string | null = null;
    render(UnitRow, {
      session: session({
        id: "ms5",
        manualSteps: [{ id: "m1", text: "do a thing", postMerge: false }],
        manualStepsAckedAt: null,
      }),
      git: { state: "closed" } as never,
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      onackmanualsteps: (id: string) => (acked = id),
      onshowowed: (id: string) => (shown = id),
    });
    await expect.element(page.getByTitle(m.unitrow_ack_manual_steps())).not.toBeInTheDocument();
    const chip = page.getByText(m.unitrow_manual_steps({ count: 1 }));
    await expect.element(chip).toBeInTheDocument();
    await chip.click();
    expect(shown).toBe("ms5");
    expect(acked).toBe(null);
  });
});

describe("UnitRow stepper bar", () => {
  // A running session makes showStepper true, so the .stepper <button> renders.
  function renderRunning(onselect: (id: string) => void): HTMLButtonElement {
    render(UnitRow, {
      session: session({ id: "step-1", status: "running" }),
      selected: false,
      nowMs: Date.now(),
      onselect,
    });
    return document.querySelector("button.stepper") as HTMLButtonElement;
  }

  it("is pointer-targetable above the .unit-hit overlay and opens the legend on hover", async () => {
    const stepper = renderRunning(() => {});
    expect(stepper, "stepper button renders for a running session").not.toBeNull();
    const r = stepper.getBoundingClientRect();

    // (a) TARGETING — at the bar centre the pointer lands on the raised stepper,
    // not the transparent .unit-hit click overlay (it did before the z-index fix).
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    ) as HTMLElement;
    expect(stepper.contains(hit) || hit === stepper, "centre targets the stepper").toBe(true);
    expect(hit.closest(".unit-hit"), "centre is not the overlay").toBeNull();

    // (b) OPENING — the hover entry the overlay used to swallow now opens the legend.
    stepper.dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }),
    );
    await vi.waitFor(() => {
      const tip = stepper.getAttribute("aria-describedby");
      expect(document.getElementById(tip!)?.matches(":popover-open"), "legend opens on hover").toBe(
        true,
      );
    });
  });

  it("clicking the bar selects the row exactly once, while hover does not select", async () => {
    const selected: string[] = [];
    const stepper = renderRunning((id) => selected.push(id));

    // Hover explains — it must NOT select the row.
    stepper.dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }),
    );
    expect(selected, "hover does not select").toEqual([]);

    // Click activates the row exactly once (no dead zone from the raise).
    stepper.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected, "click forwards exactly one onselect(session.id)").toEqual(["step-1"]);
  });

  it("the enlarged ::before halo (outside the visible 3px bar) targets the stepper and forwards one onselect on click", async () => {
    const selected: string[] = [];
    const stepper = renderRunning((id) => selected.push(id));
    const r = stepper.getBoundingClientRect();

    // A point 4px BELOW the 3px bar — inside the ::before halo (inset -8px), outside
    // the visible segments. Without the enlarged pseudo this resolves to .unit-hit.
    const hx = r.left + r.width / 2;
    const hy = r.bottom + 4;
    const halo = document.elementFromPoint(hx, hy) as HTMLElement;
    expect(halo?.closest(".stepper"), "halo point targets the stepper").toBe(stepper);
    expect(halo.closest(".unit-hit"), "halo is not the overlay").toBeNull();

    // Hovering the halo opens the legend.
    stepper.dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }),
    );
    await vi.waitFor(() => {
      const tip = stepper.getAttribute("aria-describedby");
      expect(document.getElementById(tip!)?.matches(":popover-open")).toBe(true);
    });

    // Clicking the halo selects the row exactly once.
    halo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected, "halo click forwards exactly one onselect").toEqual(["step-1"]);
  });
});

describe("UnitRow awaits-operator attention wash", () => {
  const unitEl = (id: string) => document.querySelector(`[data-unit-id="${id}"]`) as HTMLElement;

  // Resolve a CSS color expression to its computed rgb() so the composition test can
  // compare against the plain selected surface without pinning a literal value.
  function resolvedBackgroundColor(cssValue: string): string {
    const el = document.createElement("div");
    el.style.background = cssValue;
    document.body.appendChild(el);
    const color = getComputedStyle(el).backgroundColor;
    el.remove();
    return color;
  }

  const renderHold = (id: string, hold: HoldReason | undefined, extra: Partial<Session> = {}) =>
    render(UnitRow, {
      session: session({ id, status: "idle", ...extra }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      hold,
    });

  it("applies .awaits-operator for a parked plan-rework hold", () => {
    renderHold("aw-plan", { code: "plan-rework", params: { round: 2, cap: 5 } });
    expect(unitEl("aw-plan").classList.contains("awaits-operator")).toBe(true);
  });

  it("applies .awaits-operator for a blocked-menu hold", () => {
    render(UnitRow, {
      session: session({ id: "aw-menu", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      hold: { code: "blocked-menu" },
    });
    expect(unitEl("aw-menu").classList.contains("awaits-operator")).toBe(true);
  });

  it("does NOT apply for excluded holds (ci-red / critic-rework / merging)", () => {
    for (const [id, code] of [
      ["aw-ci", "ci-red"],
      ["aw-critic", "critic-rework"],
      ["aw-merging", "merging"],
    ] as const) {
      renderHold(id, { code });
      expect(unitEl(id).classList.contains("awaits-operator"), code).toBe(false);
    }
  });

  it("does NOT apply when there is no hold", () => {
    renderHold("aw-none", undefined);
    expect(unitEl("aw-none").classList.contains("awaits-operator")).toBe(false);
  });

  it("does NOT apply while running — the agent is the actor (e.g. active plan rework)", () => {
    // The server emits plan-rework for a still-running planning session that is
    // actively addressing changes; that is the agent's turn, not the operator's.
    render(UnitRow, {
      session: session({ id: "aw-running", status: "running", planPhase: "planning" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      hold: { code: "plan-rework", params: { round: 2, cap: 5 } },
    });
    expect(unitEl("aw-running").classList.contains("awaits-operator")).toBe(false);
  });

  it("does NOT apply to a working-while-blocked session (display-running, mid-turn)", () => {
    render(UnitRow, {
      session: session({ id: "aw-wb", status: "blocked" }),
      selected: false,
      nowMs: Date.now(),
      onselect: () => {},
      hold: { code: "blocked-menu" },
      workingBlocked: { "aw-wb": true },
    });
    expect(unitEl("aw-wb").classList.contains("awaits-operator")).toBe(false);
  });

  it("does NOT apply to a readyToMerge card even under an otherwise-included hold (green ✓ guard)", () => {
    renderHold("aw-ready", { code: "plan-rework" }, { readyToMerge: true });
    expect(unitEl("aw-ready").classList.contains("awaits-operator")).toBe(false);
  });

  it("composes with selection: keeps both classes and a wash-tinted background", () => {
    render(UnitRow, {
      session: session({ id: "aw-sel", status: "idle" }),
      selected: true,
      nowMs: Date.now(),
      onselect: () => {},
      hold: { code: "plan-rework", params: { round: 2, cap: 5 } },
    });
    const unit = unitEl("aw-sel");
    expect(unit.classList.contains("awaits-operator")).toBe(true);
    expect(unit.classList.contains("sel")).toBe(true);
    // the wash is composited INTO the selected background, so it differs from the
    // plain selected surface (--color-sel) and is not transparent.
    const bg = getComputedStyle(unit).backgroundColor;
    expect(bg).not.toBe(resolvedBackgroundColor("var(--color-sel)"));
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  });
});
