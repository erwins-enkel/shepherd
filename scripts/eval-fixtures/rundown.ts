// Labelled fixtures for the rundown eval (issue #2156).
//
// Each fixture is a hand-authored `AssembledHerdState` — the EXACT input `buildRundownPrompt`
// consumes. Deliberately NOT routed through `assembleHerdState()`: that function is deterministic
// and already unit-tested in `test/rundown-core.test.ts`, so putting it in front would test the
// assembler rather than the prompt, and would force every fixture to construct full `Session`
// rows. The subject here is the PROMPT.
//
// Correctness is a predicate set, not a single label — the rundown's verdict is structured prose,
// so what can be scored is its DECIDABLE contracts: which sessions it surfaces, which it must not,
// which sections it must fill, and the epics it must not echo. See `docs/eval-harness.md`.

import type { AssembledHerdState, AssembledSession } from "../../src/rundown-core";
import type { OperatorLanguage } from "../../src/operator-language";
import type { EvalFixtureBase } from "../eval-core";

/** The decidable assertions one fixture makes about the verdict. All must hold for a trial to
 *  count as correct. Every field is optional; an empty object asserts only that a verdict parsed. */
export interface RundownExpectations {
  /** Session ids that MUST appear in `decisions` or `ciRework` (the "needs a human now" set). */
  mustSurface?: string[];
  /**
   * Session ids that must not appear in `decisions` or `ciRework` — the two "needs a human now"
   * buckets. Deliberately NOT checked against `focusNext`: the prompt defines that section as
   * "what the operator should look at next once blockers clear", so routine in-flight work
   * belongs there. The first live run failed four fixtures on exactly this — the model put a
   * routine session in `focusNext` and the predicate called it a leak, scoring the prompt for
   * obeying its own contract.
   */
  mustNotSurface?: string[];
  /** Sections that must be non-empty. */
  nonEmpty?: ("decisions" | "ciRework" | "focusNext" | "overnight" | "train")[];
  /** Sections that must be empty — a quiet herd must not be padded with manufactured items. */
  empty?: ("decisions" | "ciRework")[];
  /** Epic parent numbers that must not be echoed into any item label (they are surfaced
   *  separately as Tier-1 items; the prompt forbids repeating them). */
  noEpicEcho?: number[];
  /** With Tier-1 work present the verdict must surface SOMETHING: `decisions` + `ciRework`
   *  non-empty between them. The decidable form of the prompt's "do NOT claim all clear". */
  mustSurfaceSomething?: boolean;
}

export interface RundownFixture extends EvalFixtureBase {
  state: AssembledHerdState;
  lang: OperatorLanguage;
  expect: RundownExpectations;
}

// --- small builders, so a fixture reads as the situation it encodes ----------

function session(over: Partial<AssembledSession> & Pick<AssembledSession, "sessionId">) {
  const base: AssembledSession = {
    desig: over.sessionId.toUpperCase(),
    sessionId: over.sessionId,
    repo: "/home/op/work/shepherd",
    tier: 3,
    signals: ["in-flight"],
    ageMs: 45 * 60_000,
    backlogRank: 0,
  };
  return { ...base, ...over };
}

function state(over: Partial<AssembledHerdState>): AssembledHerdState {
  return {
    generatedFor: "2026-09-02T07:00:00.000Z",
    overnightDelta: { mergedPrs: [], archivedSessions: [] },
    sessions: [],
    epics: [],
    truncatedTier2: 0,
    truncatedTier3: 0,
    ...over,
  };
}

export const RUNDOWN_FIXTURES: RundownFixture[] = [
  {
    id: "tier1-blocked-decision",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "A single Tier-1 session blocked on an operator decision — the core surface case.",
    state: state({
      sessions: [
        session({
          sessionId: "s-auth-01",
          desig: "AUTH",
          tier: 1,
          signals: ["blocked-decision"],
          ageMs: 3 * 3600_000,
          prNumber: 118,
        }),
        session({ sessionId: "s-docs-02", desig: "DOCS" }),
      ],
    }),
    expect: {
      mustSurface: ["s-auth-01"],
      mustNotSurface: ["s-docs-02"],
      mustSurfaceSomething: true,
    },
  },
  {
    id: "tier1-ci-red",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "CI red and unaddressed — must land in the stuck bucket, not be treated as in-flight.",
    state: state({
      sessions: [
        session({
          sessionId: "s-rate-03",
          desig: "RATE",
          tier: 1,
          signals: ["ci-red"],
          ageMs: 5 * 3600_000,
          prNumber: 121,
          prUrl: "https://github.com/acme/shepherd/pull/121",
        }),
      ],
    }),
    expect: { mustSurface: ["s-rate-03"], mustSurfaceSomething: true },
  },
  {
    id: "tier1-plan-question",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "Unanswered plan-gate question — forward progress is blocked on the operator's answer.",
    state: state({
      sessions: [
        session({
          sessionId: "s-epic-04",
          desig: "EPIC",
          tier: 1,
          signals: ["plan-question"],
          ageMs: 90 * 60_000,
          planRound: 2,
        }),
        session({ sessionId: "s-lint-05", desig: "LINT", signals: ["in-flight"] }),
      ],
    }),
    expect: {
      mustSurface: ["s-epic-04"],
      mustNotSurface: ["s-lint-05"],
      mustSurfaceSomething: true,
    },
  },
  {
    id: "critic-rework-over-budget",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "REWORK past its retry budget — a stalled autonomous loop, not routine review traffic.",
    state: state({
      sessions: [
        session({
          sessionId: "s-view-06",
          desig: "VIEW",
          tier: 1,
          signals: ["critic-rework"],
          ageMs: 8 * 3600_000,
          prNumber: 130,
          findings: [
            "ui/src/lib/components/Viewport.svelte: the resize observer is never disconnected",
            "src/store.ts: the migration drops the column before copying it",
          ],
        }),
      ],
    }),
    expect: { mustSurface: ["s-view-06"], mustSurfaceSomething: true },
  },
  {
    id: "quiet-herd-no-manufacture",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "Only routine in-flight work — the prompt forbids surfacing it, so both buckets stay empty.",
    state: state({
      sessions: [
        session({ sessionId: "s-a-07", desig: "AAA", ageMs: 20 * 60_000 }),
        session({ sessionId: "s-b-08", desig: "BBB", ageMs: 35 * 60_000 }),
        session({ sessionId: "s-c-09", desig: "CCC", ageMs: 12 * 60_000 }),
      ],
    }),
    expect: {
      empty: ["decisions", "ciRework"],
      mustNotSurface: ["s-a-07", "s-b-08", "s-c-09"],
    },
  },
  {
    id: "epics-not-echoed",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "Epics awaiting landing are surfaced separately — echoing them into the verdict is the bug.",
    state: state({
      sessions: [
        session({
          sessionId: "s-mig-10",
          desig: "MIGR",
          tier: 1,
          signals: ["blocked-decision"],
          ageMs: 2 * 3600_000,
        }),
      ],
      epics: [
        {
          repo: "/home/op/work/shepherd",
          parent: 1904,
          title: "Rundown digest",
          landingPr: 1911,
          stranded: false,
        },
        {
          repo: "/home/op/work/shepherd",
          parent: 1877,
          title: "Egress allowlist",
          landingPr: 1880,
          stranded: true,
          pausedReason: "conflict",
        },
      ],
    }),
    expect: {
      mustSurface: ["s-mig-10"],
      noEpicEcho: [1904, 1877],
      mustSurfaceSomething: true,
    },
  },
  {
    id: "truncated-tier2-no-all-clear",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "Tier-2 sessions were elided to fit the budget — an 'all clear' reading would be false.",
    state: state({
      sessions: [
        session({
          sessionId: "s-hold-11",
          desig: "HOLD",
          tier: 2,
          signals: ["stalled"],
          ageMs: 6 * 3600_000,
        }),
      ],
      truncatedTier2: 4,
      truncatedTier3: 9,
    }),
    expect: { mustSurfaceSomething: true },
  },
  {
    id: "overnight-delta-reported",
    origin: "synthetic",
    gating: true,
    lang: "en",
    note: "Work landed while the operator was away — `overnight` is exactly what that field is for.",
    state: state({
      sessions: [
        session({
          sessionId: "s-perf-12",
          desig: "PERF",
          tier: 1,
          signals: ["manual-steps"],
          ageMs: 4 * 3600_000,
          prNumber: 142,
        }),
      ],
      overnightDelta: {
        mergedPrs: [133, 135, 138],
        archivedSessions: [
          { id: "s-old-a", desig: "OLDA" },
          { id: "s-old-b", desig: "OLDB" },
        ],
      },
    }),
    expect: { nonEmpty: ["overnight"], mustSurface: ["s-perf-12"] },
  },
  {
    id: "backlog-rank-never-outranks-tier1",
    origin: "synthetic",
    // BASELINE: `focusNext` ordering is a soft preference in the prompt ("prefer items from
    // higher-priority repos"), not a hard contract, so a miss here is a signal to read rather than
    // a gate to trip. Kept for the before/after record.
    gating: false,
    lang: "en",
    note: "A top-ranked repo's routine work must not be promoted above a Tier-1 blocker.",
    state: state({
      sessions: [
        session({
          sessionId: "s-block-13",
          desig: "BLCK",
          repo: "/home/op/work/side-project",
          tier: 1,
          signals: ["blocked-decision"],
          backlogRank: 7,
          ageMs: 3 * 3600_000,
        }),
        session({
          sessionId: "s-top-14",
          desig: "TOPP",
          repo: "/home/op/work/shepherd",
          tier: 3,
          signals: ["in-flight"],
          backlogRank: 0,
        }),
      ],
    }),
    expect: { mustSurface: ["s-block-13"], mustNotSurface: ["s-top-14"] },
  },
  {
    id: "de-tier1-machine-fields-verbatim",
    origin: "synthetic",
    gating: true,
    lang: "de",
    note: "German operator language: prose translates, but sessionId/pr stay verbatim and deep-link.",
    state: state({
      sessions: [
        session({
          sessionId: "s-kasse-15",
          desig: "KASS",
          tier: 1,
          signals: ["pr-conflict"],
          ageMs: 5 * 3600_000,
          prNumber: 151,
        }),
        session({ sessionId: "s-ruhe-16", desig: "RUHE", signals: ["in-flight"] }),
      ],
    }),
    expect: {
      mustSurface: ["s-kasse-15"],
      mustNotSurface: ["s-ruhe-16"],
      mustSurfaceSomething: true,
    },
  },
];
