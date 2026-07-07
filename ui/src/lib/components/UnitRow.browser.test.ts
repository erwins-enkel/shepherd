import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import UnitRow from "./UnitRow.svelte";
import { projectIcons } from "$lib/projectIcons.svelte";
import type { PlanGate, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import type { ReviewVerdict } from "$lib/types";

// Mock api so the reviews store's load() never fires real network calls.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getReviews: vi.fn(async () => ({})), getReviewingIds: vi.fn(async () => []) };
});

const { reviews, planGates, repoConfig } = await import("$lib/reviews.svelte");

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
    await page.getByRole("button", { name: "Open inline" }).click();
    expect(calls).toEqual([["p4", "inline"]]);
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
});
