import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { overwriteGetLocale } from "$lib/paraglide/runtime";
import type { BuildQueue, GitState, PlanGate, ReviewVerdict, Session } from "$lib/types";

// Runs in the `browser-touch` vitest project (ui/vite.config.ts), the only one with
// `hasTouch: true` — without it `@media (pointer: coarse)` never matches and every
// touch-only rule under test would be silently absent.
//
// What this guards (docs/design/mobile-herd): the mobile list screen used to carry six
// interactive elements below the iOS HIG 44x44 floor — five badges stacked in each card
// (PR / plan gate / critic / build queue / preview, all ~15px tall) plus the ~18x19px repo
// emoji, and the header's 44x24 status tallies. Five of those missed even the hard WCAG 2.5.8
// (AA) floor of 24x24. D4/D5/D6 resolved them by relocation, not by inflation: each action
// still exists, at a conformant size, on the detail screen the card tap already opens.
//
// The sweep below is deliberately generic — it measures whatever renders rather than a
// hand-maintained list of selectors, so a newly added control cannot slip past it. Every
// exception must be named HERE, with its justification, which is what makes the exception
// list itself the audit trail.

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getReviews: vi.fn(async () => ({})),
    getReviewingIds: vi.fn(async () => []),
    getProjectIcons: vi.fn(async () => ({})),
    releasePlanGate: vi.fn(async () => true),
    resumeQuota: vi.fn(async () => ({ status: "resumed" as const })),
    retryCi: vi.fn(async () => ({ ok: true })),
  };
});

const { default: UnitRow } = await import("./UnitRow.svelte");
const { default: TopBarTallies } = await import("./top-bar/TopBarTallies.svelte");
const { reviews, planGates, repoConfig } = await import("$lib/reviews.svelte");
const { buildQueues } = await import("$lib/buildQueues.svelte");
const { projectIcons } = await import("$lib/projectIcons.svelte");

/** iOS HIG 44x44 — the binding floor here: Shepherd runs as an iPhone PWA. Material's 48x48 is
 *  the aspiration (met where vertical budget allows, e.g. sheet rows), not this gate. */
const HIG = 44;
/** Sub-pixel slack, matching the house pattern in TopBar.browser.test.ts. */
const SLACK = 0.5;

const INTERACTIVE = [
  "button",
  '[role="button"]',
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

type Target = { el: HTMLElement; w: number; h: number };

/** Everything in `host` that can actually receive a tap. An element with
 *  `pointer-events: none` is not a pointer target at all (it cannot be tapped; the event
 *  goes to whatever sits behind it), so the target-size rule does not apply to it — but it
 *  may still be keyboard-focusable, which is not size-constrained. */
function pointerTargets(host: HTMLElement): Target[] {
  return [...host.querySelectorAll<HTMLElement>(INTERACTIVE)]
    .filter((el) => getComputedStyle(el).pointerEvents !== "none")
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, w: r.width, h: r.height };
    });
}

function describeTarget({ el, w, h }: Target): string {
  const cls = String(el.className)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join("");
  return `${el.tagName.toLowerCase()}${cls} ${Math.round(w)}x${Math.round(h)}`;
}

/** Named exceptions. Each entry must carry the reason it is allowed to be undersized —
 *  an unexplained entry here is a bug, not a waiver. */
const EXCEPTIONS: Array<{ why: string; match: (t: Target) => boolean }> = [
  {
    // WCAG 2.5.8 "Inline" exception, verbatim: "the target is in a sentence or its size is
    // otherwise constrained by the line-height of non-target text". The task designation is
    // literally inline in the footer sentence `TASK-754 · GPT-5.6 Sol · Hoch`, sized by that
    // line's line-height (TaskIdButton, rendered inside `.meta-text` in UnitRow).
    //
    // It is NOT relocated like the D4 badges, because its menu (copy the task id, recommend a
    // next prompt) exists nowhere else — moving it would remove a function rather than relocate
    // one. Growing it instead would add ~28px to EVERY card (the D4 badges' 0.5-card cost, paid
    // eight times over), and expanding its hit area to 44px would bleed into either the prompt
    // band above (arming the wrong control) or the next card below (worse). So it stays inline
    // and keeps the residual iOS HIG gap, which is a recommendation rather than a conformance
    // criterion — the WCAG floor is met by the exception.
    why: "task designation: WCAG 2.5.8 Inline exception — inline in the footer sentence",
    match: (t) => t.el.classList.contains("desig-btn"),
  },
  {
    // WCAG 2.5.8 "Equivalent" exception, verbatim: the function is available through another
    // control on the same page that meets the criterion. The stepper's click is
    // `onactivate={() => onselect(session.id)}` (UnitRow) — exactly what tapping the card's own
    // >=44px hit-target does. Its hover/focus legend is not a pointer affordance.
    why: "stepper: click only selects the row, which the >=44px card hit-target already does",
    match: (t) => t.el.classList.contains("stepper"),
  },
];

function allowed(t: Target): string | null {
  return EXCEPTIONS.find((e) => e.match(t))?.why ?? null;
}

function assertAllTargetsConform(host: HTMLElement, ctx: string) {
  const undersized = pointerTargets(host)
    .filter((t) => t.w < HIG - SLACK || t.h < HIG - SLACK)
    .filter((t) => allowed(t) === null);
  expect(
    undersized.map(describeTarget),
    `${ctx}: pointer targets below ${HIG}x${HIG} with no named exception`,
  ).toEqual([]);
}

// ── fixtures ────────────────────────────────────────────────────────────────────

const ID = "touch-target-row";
const REPO = "/repo/a";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-754",
    name: "feat/313-outlook-explicit-mailbox",
    prompt: "Ja. Genau jetzt ist der richtige Zeitpunkt für den Fork.",
    repoPath: REPO,
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: "opus",
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
    planPhase: "planning",
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: 313,
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

const openPr: GitState = {
  kind: "github",
  state: "open",
  number: 314,
  url: "https://example.com/pull/314",
  checks: "success",
  deployConfigured: false,
};

const gate: PlanGate = {
  sessionId: ID,
  planHash: "h",
  decision: "changes_requested",
  summary: "tighten scope",
  body: "",
  findings: ["tighten scope"],
  round: 1,
  cap: 3,
  approved: false,
  plan: "# Plan",
  blocks: [],
  updatedAt: Date.now(),
};

const verdict: ReviewVerdict = {
  sessionId: ID,
  headSha: "abc",
  decision: "changes_requested",
  summary: "",
  body: "## findings",
  findings: ["x"],
  addressRound: 0,
  addressCap: 5,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: Date.now(),
};

const queue: BuildQueue = {
  sessionId: ID,
  steps: [
    { id: "b1", title: "one", status: "done", position: 0 },
    { id: "b2", title: "two", status: "pending", position: 1 },
  ],
  approved: true,
};

/** A faithful mini-`.units.flow` (mirrors Herd.svelte's mobile list panel). */
function unitsFlow(width: number): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  h.style.containerType = "inline-size";
  h.style.containerName = "herd";
  h.style.overflow = "visible";
  document.body.appendChild(h);
  return h;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

beforeEach(() => {
  reviews.reviewing = {};
  reviews.map = { [ID]: verdict };
  planGates.reviewing = {};
  planGates.map = { [ID]: gate };
  buildQueues.map = { [ID]: queue };
  projectIcons.map = { [REPO]: "🏛" };
  repoConfig.previewOpenMode = {};
  repoConfig.loaded = {};
  repoConfig.settled = {};
});

afterEach(() => {
  overwriteGetLocale(() => "en");
  reviews.map = {};
  planGates.map = {};
  buildQueues.map = {};
  projectIcons.map = {};
  document.querySelectorAll("body > div").forEach((n) => n.remove());
});

// ── the sweep ───────────────────────────────────────────────────────────────────

describe("mobile list: every tap target clears the iOS HIG 44x44 floor", () => {
  // A row loaded with every badge at once — the worst case the real list can produce.
  for (const width of [360, 393, 430]) {
    for (const locale of ["en", "de"] as const) {
      it(`fully loaded row @ ${width}px [${locale}]`, async () => {
        overwriteGetLocale(() => locale);
        const host = unitsFlow(width);
        render(UnitRow, {
          target: host,
          props: {
            session: session({ id: ID }),
            git: openPr,
            selected: false,
            nowMs: Date.now(),
            onselect: () => {},
            previewPort: 5173,
            onpreview: () => {},
            onrepofilter: () => {},
            ondecommission: () => {},
          },
        });
        await frame();
        assertAllTargetsConform(host, `loaded row @ ${width}px [${locale}]`);
      });
    }
  }
});

describe("D4/D5: the undersized card controls are readouts on touch, not tap targets", () => {
  it("badges and the repo emoji render, but none of them is interactive", async () => {
    const host = unitsFlow(393);
    render(UnitRow, {
      target: host,
      props: {
        session: session({ id: ID }),
        git: openPr,
        selected: false,
        nowMs: Date.now(),
        onselect: () => {},
        previewPort: 5173,
        onpreview: () => {},
        onrepofilter: () => {},
        ondecommission: () => {},
      },
    });
    await frame();

    // The information is still on screen — this is a relocation of the ACTION, not of the
    // status. A missing readout here would mean D4 removed information, which it must not.
    for (const sel of [
      ".pr-badge",
      ".pg-badge",
      ".critic-badge",
      ".queue-badge",
      ".preview-badge",
    ]) {
      expect(host.querySelector(sel), `${sel} still renders as a readout`).not.toBeNull();
    }
    expect(host.querySelector(".name-icon"), "repo emoji still renders").not.toBeNull();

    // …but none of them is a control any more.
    for (const sel of [
      ".pr-badge",
      ".pg-badge",
      ".critic-badge",
      ".queue-badge",
      ".preview-badge",
    ]) {
      const el = host.querySelector<HTMLElement>(sel)!;
      expect(el.tagName.toLowerCase(), `${sel} is not a <button> on touch`).not.toBe("button");
      expect(el.getAttribute("role"), `${sel} does not claim the button role on touch`).not.toBe(
        "button",
      );
    }
    expect(
      host.querySelector(".name-icon.actionable"),
      "D5: the repo emoji drops its tap role on touch",
    ).toBeNull();
    // The fine-pointer ✕ never renders on a coarse pointer at all.
    expect(host.querySelector(".row-decom"), "decommission ✕ is fine-pointer only").toBeNull();
  });
});

describe("D6: the header status tallies are 44x44 on a phone", () => {
  it("each compact tally clears 44x44", async () => {
    const host = document.createElement("div");
    host.style.width = "430px";
    document.body.appendChild(host);
    render(TopBarTallies, {
      target: host,
      props: {
        mobile: true,
        total: 16,
        working: 0,
        idle: 2,
        blocked: 1,
        statusFilter: "blocked" as const,
        onstatusfilter: () => {},
        clickStatus: () => {},
      },
    });
    await frame();

    const tallies = [...host.querySelectorAll<HTMLElement>(".ctally")];
    expect(tallies.length, "all four compact tallies render").toBe(4);
    for (const t of tallies) {
      const r = t.getBoundingClientRect();
      expect(r.width, `tally width (was 24px before D6)`).toBeGreaterThanOrEqual(HIG - SLACK);
      expect(r.height, `tally height`).toBeGreaterThanOrEqual(HIG - SLACK);
    }
  });

  // The one surviving exception, and the only one: below a 360px viewport TopBarTallies keeps its
  // documented 24px width, because four 44px targets genuinely break that line on a fold cover.
  // Asserted rather than asserted-to-be-true: the point is that the exception is BOUNDED — it
  // applies below 360px and nowhere else, and it still clears the WCAG 2.5.8 (AA) 24x24 minimum.
  it("below 360px the documented 24px width compromise stands, and stays above the WCAG floor", async () => {
    await page.viewport(320, 800);
    const host = document.createElement("div");
    host.style.width = "320px";
    document.body.appendChild(host);
    render(TopBarTallies, {
      target: host,
      props: {
        mobile: true,
        total: 16,
        working: 0,
        idle: 2,
        blocked: 1,
        statusFilter: null,
        onstatusfilter: () => {},
        clickStatus: () => {},
      },
    });
    await frame();

    const tallies = [...host.querySelectorAll<HTMLElement>(".ctally")];
    expect(tallies.length).toBe(4);
    for (const t of tallies) {
      const r = t.getBoundingClientRect();
      // Below the HIG floor on the narrow axis — deliberately, and only here…
      expect(r.width, "fold-cover width stays at the documented compromise").toBeLessThan(HIG);
      // …but never below the hard WCAG 2.5.8 (AA) minimum.
      expect(r.width, "still clears WCAG 2.5.8 24x24").toBeGreaterThanOrEqual(24 - SLACK);
      expect(r.height, "height keeps the 44px floor even on a fold cover").toBeGreaterThanOrEqual(
        HIG - SLACK,
      );
    }
    await page.viewport(1280, 720);
  });
});
