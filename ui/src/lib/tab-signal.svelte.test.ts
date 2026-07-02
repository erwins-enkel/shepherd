import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveTabState, planQuestionsUnanswered } from "./tab-signal.svelte";
import type { Session, GitState, SessionStatus, ChecksState, PlanGate } from "./types";

const sess = (id: string, status: SessionStatus, readyToMerge = false): Session =>
  ({ id, status, readyToMerge }) as unknown as Session;

const git = (checks: ChecksState, handoff?: "reviewer" | "merger"): GitState =>
  ({ checks, handoff }) as unknown as GitState;

/** A planning-phase session (plan-question is guarded on planPhase === "planning"). */
const planningSess = (id: string): Session =>
  ({ id, status: "running", readyToMerge: false, planPhase: "planning" }) as unknown as Session;

/** A plan gate carrying one unanswered question-form question, unless keys are supplied. */
const formGate = (answeredQuestionKeys: string[] = []): PlanGate =>
  ({
    blocks: [
      {
        type: "question-form",
        id: "qf1",
        questions: [{ id: "q1", prompt: "Which?", kind: "single", options: ["a", "b"] }],
      },
    ],
    answeredQuestionKeys,
  }) as unknown as PlanGate;

test("no sessions → count 0, severity none", () => {
  expect(deriveTabState([], {}, {})).toMatchObject({ count: 0, severity: "none" });
});

test("blocked session counts as amber", () => {
  expect(deriveTabState([sess("s1", "blocked")], {}, {})).toMatchObject({
    count: 1,
    severity: "amber",
  });
});

test("working-blocked session (mid-turn) is excluded — renders as running", () => {
  expect(deriveTabState([sess("s1", "blocked")], {}, { s1: true })).toMatchObject({
    count: 0,
    severity: "none",
  });
});

test("ci-red (git.checks === failure) counts as red", () => {
  expect(deriveTabState([sess("s1", "running")], { s1: git("failure") }, {})).toMatchObject({
    count: 1,
    severity: "red",
  });
});

test("blocked + CI-red on one session reads red, not amber (no primary-hold masking)", () => {
  // The whole point of reading git.checks directly rather than the primary-only
  // store.holds: a blocked session that is ALSO CI-red must surface red.
  expect(deriveTabState([sess("s1", "blocked")], { s1: git("failure") }, {})).toMatchObject({
    count: 1,
    severity: "red",
  });
});

test("ready-to-merge counts as green", () => {
  expect(deriveTabState([sess("s1", "done", true)], {}, {})).toMatchObject({
    count: 1,
    severity: "green",
  });
});

test("ready-to-merge handed to a merger is excluded (awaiting-merge, not ready)", () => {
  expect(
    deriveTabState([sess("s1", "done", true)], { s1: git("success", "merger") }, {}),
  ).toMatchObject({
    count: 0,
    severity: "none",
  });
});

test("ready-to-merge handed to a reviewer still counts as green", () => {
  expect(
    deriveTabState([sess("s1", "done", true)], { s1: git("success", "reviewer") }, {}),
  ).toMatchObject({ count: 1, severity: "green" });
});

test("critic-rework / plain running sessions are not counted", () => {
  // deriveTabState never inspects review verdicts, so an agent-turn session
  // (e.g. critic-rework) with no blocked/ci-red/ready signal produces nothing.
  expect(deriveTabState([sess("s1", "running")], {}, {})).toMatchObject({
    count: 0,
    severity: "none",
  });
});

test("severity precedence across sessions: red > amber > green; count is distinct sessions", () => {
  const sessions = [sess("green", "done", true), sess("amber", "blocked"), sess("red", "running")];
  const g = { red: git("failure") };
  expect(deriveTabState(sessions, g, {})).toMatchObject({ count: 3, severity: "red" });
});

test("non-failure CI does not count", () => {
  const sessions = [sess("s1", "running"), sess("s2", "idle")];
  const g = { s1: git("success"), s2: git("pending") };
  expect(deriveTabState(sessions, g, {})).toMatchObject({ count: 0, severity: "none" });
});

test("tallies split by severity; running counted independently", () => {
  const sessions = [
    sess("green", "done", true), // ready
    sess("amber", "blocked"), // blocked
    sess("red", "running"), // ci-red
    sess("run", "running"), // plain running (not in count)
  ];
  const g = { red: git("failure") };
  expect(deriveTabState(sessions, g, {})).toEqual({
    count: 3,
    severity: "red",
    ci: 1,
    blocked: 1,
    ready: 1,
    running: 2, // "red" (running+failure) and "run" both render running
  });
});

test("empty herd → all tallies zero", () => {
  expect(deriveTabState([], {}, {})).toEqual({
    count: 0,
    severity: "none",
    ci: 0,
    blocked: 0,
    ready: 0,
    running: 0,
  });
});

test("ci+blocked+ready === count invariant on a mixed herd", () => {
  const sessions = [sess("a", "blocked"), sess("b", "done", true), sess("c", "running")];
  const g = { c: git("failure") };
  const s = deriveTabState(sessions, g, {});
  expect(s.ci + s.blocked + s.ready).toBe(s.count);
});

// ── plan-question: unanswered plan-gate question awaiting the operator (#1332) ──

test("planning session with an unanswered plan question counts as amber", () => {
  // A plan-question is amber, so it folds into the `blocked` tally → the ✋ glyph.
  expect(deriveTabState([planningSess("s1")], {}, {}, { s1: formGate() })).toEqual({
    count: 1,
    severity: "amber",
    ci: 0,
    blocked: 1,
    ready: 0,
    running: 1,
  });
});

test("plan question answered → not counted", () => {
  expect(deriveTabState([planningSess("s1")], {}, {}, { s1: formGate(["qf1 q1"]) })).toMatchObject({
    count: 0,
    severity: "none",
  });
});

test("unanswered plan question but not in planning phase → excluded (no execution leak)", () => {
  const s = {
    id: "s1",
    status: "running",
    readyToMerge: false,
    planPhase: "executing",
  } as unknown as Session;
  expect(deriveTabState([s], {}, {}, { s1: formGate() })).toMatchObject({
    count: 0,
    severity: "none",
  });
});

test("ci-red beats a co-occurring unanswered plan question (red, not amber)", () => {
  expect(
    deriveTabState([planningSess("s1")], { s1: git("failure") }, {}, { s1: formGate() }),
  ).toMatchObject({ count: 1, severity: "red" });
});

test("multi-question form with only one answered still counts (partial → pending)", () => {
  const gate = {
    blocks: [
      {
        type: "question-form",
        id: "qf1",
        questions: [
          { id: "q1", prompt: "Which?", kind: "single", options: ["a", "b"] },
          { id: "q2", prompt: "Notes?", kind: "freeform" },
        ],
      },
    ],
    answeredQuestionKeys: ["qf1 q1"],
  } as unknown as PlanGate;
  expect(deriveTabState([planningSess("s1")], {}, {}, { s1: gate })).toMatchObject({
    count: 1,
    severity: "amber",
  });
});

test("planQuestionsUnanswered matches the shared parity fixtures (client ↔ server drift lock)", () => {
  // Same fixtures asserted by the server's test/rundown-core.test.ts against its implementation;
  // any drift between the two predicates fails one suite. Mirrors the MERGE_MARK_BACKSTOP_MS lock.
  const cases = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/plan-question-parity.json", import.meta.url),
      "utf8",
    ),
  ) as Array<{ name: string; gate: Partial<PlanGate>; expected: boolean }>;
  for (const c of cases) {
    expect({ name: c.name, r: planQuestionsUnanswered(c.gate as PlanGate) }).toEqual({
      name: c.name,
      r: c.expected,
    });
  }
});
