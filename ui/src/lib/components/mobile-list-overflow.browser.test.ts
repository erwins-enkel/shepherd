import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import UnitRow from "./UnitRow.svelte";
import { overwriteGetLocale } from "$lib/paraglide/runtime";
import type { HoldReason, LivenessState, PlanGate, Session, SessionActivity } from "$lib/types";

// The mobile session list is a full-bleed document-scroll app-shell: `.units.flow`
// is `overflow: visible` and `container-type: inline-size`, so it CANNOT absorb a row
// wider than itself — an over-wide `.unit` escapes straight to the document and drags
// the sticky header + fixed ActionBar sideways (the reported bug). This test mounts a
// row inside a faithful mini-`.units.flow` and asserts the row never out-measures its
// container, across the `flex: none` chip clusters and both locales, down to 320px.
//
// The confirmed offender was the `loaded-meta-row` case: the `.meta` footer packed a
// manual-steps chip + Ack CTA + stage stepper (all `flex: none`) onto one line whose
// fixed widths exceeded the card even with `.meta-text` collapsed to zero. The other
// cases cover the plan-gate `.hold-cta` states so the whole footer stays guarded.

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getReviews: vi.fn(async () => ({})),
    getReviewingIds: vi.fn(async () => []),
    releasePlanGate: vi.fn(async () => true),
    reviewPlan: vi.fn(async (): Promise<import("$lib/api").PlanReviewTrigger> => "started"),
    resumeQuota: vi.fn(async () => ({ status: "resumed" as const })),
    retryCi: vi.fn(async () => ({ ok: true }) as { ok: boolean }),
  };
});

const { reviews, planGates, repoConfig } = await import("$lib/reviews.svelte");

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "auth-session-store",
    prompt: "Rework the auth session store to a rotating refresh-token scheme",
    repoPath: "/repo/a",
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
    issueNumber: 220,
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

const readyGate = (id: string): PlanGate => ({
  sessionId: id,
  planHash: "h",
  decision: "approved",
  summary: "",
  body: "",
  findings: [],
  round: 0,
  cap: 3,
  approved: true,
  plan: "# Plan",
  blocks: [],
  updatedAt: Date.now(),
});

const changesGate = (id: string, round: number, cap: number): PlanGate => ({
  ...readyGate(id),
  decision: "changes_requested",
  summary: "tighten scope",
  findings: ["tighten scope"],
  round,
  cap,
  approved: false,
});

// A faithful mini-`.units.flow`: same container context + overflow mode as the real
// mobile list panel (Herd.svelte:790-808), at a fixed inline-size so UnitRow's
// `@container herd` rules fire exactly as on-device.
function unitsFlow(width: number): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  h.style.containerType = "inline-size";
  h.style.containerName = "herd";
  h.style.overflow = "visible";
  document.body.appendChild(h);
  return h;
}

function assertRowFits(host: HTMLElement, ctx: string) {
  const unit = host.querySelector<HTMLElement>(".unit");
  expect(unit, `${ctx}: .unit mounted`).not.toBeNull();
  // 1px slack for sub-pixel rounding (house pattern, TopBar.browser.test.ts).
  expect(unit!.scrollWidth, `${ctx}: .unit overflows its container`).toBeLessThanOrEqual(
    unit!.clientWidth + 1,
  );
}

beforeEach(() => {
  reviews.reviewing = {};
  reviews.map = {};
  planGates.reviewing = {};
  planGates.map = {};
  repoConfig.previewOpenMode = {};
  repoConfig.loaded = {};
  repoConfig.settled = {};
});

afterEach(() => {
  overwriteGetLocale(() => "en");
  document.querySelectorAll("body > div").forEach((n) => n.remove());
});

// Each case renders the `flex: none` `.hold-cta` (or stranded revive chip) in a
// distinct row state. `props` is what feeds UnitRow beyond `session`.
const heartbeat = (now: number): SessionActivity => ({
  lastActivityTs: now,
  summary: "edited poller.ts",
  recentTs: Array.from({ length: 20 }, (_, i) => now - (20 - i) * 1000),
  recentErrTs: [],
});

const CASES: Array<{
  name: string;
  session: (id: string) => Partial<Session>;
  props?: (id: string) => Partial<{
    hold: HoldReason;
    liveness: LivenessState;
    activity: SessionActivity;
    onackmanualsteps: (id: string) => void;
  }>;
}> = [
  {
    // Explore's "Suspect B": the .meta footer packed with flex:none chips — manual-steps
    // count + ACK CTA + stage stepper — plus the heartbeat strip. The stepper is only
    // dropped below 300px, so at 320px every flex:none item stays.
    name: "loaded-meta-row",
    session: () => ({
      status: "blocked",
      model: "claude-opus-4-8[1m]",
      manualSteps: [
        { id: "m1", text: "Set FEATURE_X env var in production", postMerge: false },
        { id: "m2", text: "Run the data backfill once live", postMerge: true },
      ],
      manualStepsAckedAt: null,
    }),
    props: () => ({ activity: heartbeat(Date.now()), onackmanualsteps: () => {} }),
  },
  {
    name: "ready-Go",
    session: (id) => {
      planGates.map = { [id]: readyGate(id) };
      return { status: "idle", planPhase: "planning" };
    },
  },
  {
    name: "awaiting-rereview",
    session: (id) => {
      planGates.map = { [id]: changesGate(id, 1, 3) };
      return { status: "idle", planPhase: "planning" };
    },
  },
  {
    name: "quota-Resume",
    session: (id) => {
      planGates.map = { [id]: changesGate(id, 3, 3) };
      return { status: "blocked", planPhase: "planning" };
    },
  },
  {
    name: "ci-retry",
    session: () => ({ status: "idle", planPhase: "executing", repoPath: "/repo/z" }),
    props: () => ({ hold: { code: "ci-red", params: { pr: 42 } } }),
  },
  {
    name: "stranded-Revive",
    session: () => ({ status: "idle", planPhase: "executing" }),
    props: () => ({ liveness: "stranded" }),
  },
];

const WIDTHS = [320, 360, 393];
const LOCALES = ["en", "de"] as const;

describe("mobile list row never overflows its container", () => {
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      for (const c of CASES) {
        it(`${c.name} @ ${width}px [${locale}]`, async () => {
          overwriteGetLocale(() => locale);
          const id = `${c.name}-${width}-${locale}`.replace(/\W+/g, "");
          const sessionExtra = c.session(id);
          const extraProps = c.props?.(id) ?? {};
          const host = unitsFlow(width);
          render(UnitRow, {
            target: host,
            props: {
              session: session({ id, ...sessionExtra }),
              selected: false,
              nowMs: Date.now(),
              onselect: () => {},
              ...extraProps,
            },
          });
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          assertRowFits(host, `${c.name} @ ${width}px [${locale}]`);
        });
      }
    }
  }
});
