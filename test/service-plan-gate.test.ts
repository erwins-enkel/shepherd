import { expect, test } from "bun:test";
import {
  composeSystemPrompt,
  PLAN_GATE_DIRECTIVE_INTERACTIVE,
  PLAN_GATE_DIRECTIVE_AUTO,
  planBlockInstructions,
} from "../src/service";

test("plan-gate interactive directive replaces autopilot directive", () => {
  const p = composeSystemPrompt(null, true, { planGate: "interactive" });
  expect(p).toContain("plan-gate-directive");
  expect(p).toContain(".shepherd-plan.md");
  expect(p).not.toContain("autopilot-directive"); // suppressed during planning
});
test("plan-gate auto variant skips human Q&A", () => {
  const p = composeSystemPrompt(null, true, { planGate: "auto" });
  expect(p).toContain(PLAN_GATE_DIRECTIVE_AUTO.slice(0, 24));
  expect(p).not.toContain("autopilot-directive");
});
test("no plan gate → unchanged autopilot behavior", () => {
  const p = composeSystemPrompt(null, true);
  expect(p).toContain("autopilot-directive");
  expect(p).not.toContain("plan-gate-directive");
});
test("interactive directive references both reviewer and not-implementing-yet", () => {
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE).toContain("reviewer");
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("aligned");
});
test("interactive directive makes the agent ask actively, not park questions in the plan", () => {
  // names AskUserQuestion as the choice-style mechanism (but not the exclusive channel)
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE).toContain("AskUserQuestion");
  // forbids parking open/unresolved questions in the plan file
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("unresolved");
  // but explicitly still permits stated assumptions / resolved decisions
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("assumption");
});

// ─── planBlockInstructions helper ───────────────────────────────────────────

test("planBlockInstructions(AUTO) contains question-form and sidecar filename", () => {
  const t = planBlockInstructions({ allowQuestionForm: true });
  expect(t).toContain("question-form");
  expect(t).toContain(".shepherd-plan-blocks.json");
});

test("planBlockInstructions(INTERACTIVE) has no question-form, has same-turn coupling + no-park phrase", () => {
  const t = planBlockInstructions({ allowQuestionForm: false });
  expect(t).not.toContain("question-form");
  expect(t).toContain(".shepherd-plan-blocks.json");
  // same-turn write coupling — load-bearing
  expect(t).toContain("same turn");
  // questions asked live, not parked
  expect(t.toLowerCase()).toContain("ask questions live");
});

test("PLAN_GATE_DIRECTIVE_INTERACTIVE does NOT contain question-form", () => {
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE).not.toContain("question-form");
});

test("PLAN_GATE_DIRECTIVE_AUTO DOES contain question-form", () => {
  expect(PLAN_GATE_DIRECTIVE_AUTO).toContain("question-form");
});

test("both directives contain sidecar filename and same-turn coupling phrase", () => {
  for (const d of [PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO]) {
    expect(d).toContain(".shepherd-plan-blocks.json");
    expect(d).toContain("same turn");
  }
});

test("planBlockInstructions instructs against diff and code blocks (no-diff-blocks guard)", () => {
  // both variants share the same no-diff guidance
  for (const allowQuestionForm of [true, false]) {
    const t = planBlockInstructions({ allowQuestionForm });
    // must say not to use diff/code blocks
    expect(t.toLowerCase()).toContain("do not use");
    expect(t).toContain("diff");
    expect(t).toContain("annotated-code");
  }
});

// ─── Provider-aware directive delivery (TASK-413) ────────────────────────────

test("agentProvider:'claude' is byte-identical to the default (Claude regression)", () => {
  // The new opt must NOT perturb any existing Claude caller's system prompt.
  for (const opts of [
    { research: true },
    { planGate: "interactive" as const },
    { planGate: "auto" as const },
    {},
  ]) {
    expect(composeSystemPrompt(null, true, { ...opts, agentProvider: "claude" })).toBe(
      composeSystemPrompt(null, true, opts),
    );
  }
});

test("codex research directive drops the 'sub-agents' phrasing; claude keeps it", () => {
  const codex = composeSystemPrompt(null, false, { research: true, agentProvider: "codex" });
  const claude = composeSystemPrompt(null, false, { research: true, agentProvider: "claude" });
  expect(codex).toContain("<research-directive>");
  expect(codex).toContain("attended RESEARCH task");
  expect(codex).not.toContain("sub-agents");
  expect(claude).toContain("sub-agents");
});

test("codex interactive plan-gate hardens the stop clause and omits AskUserQuestion", () => {
  const codex = composeSystemPrompt(null, false, {
    planGate: "interactive",
    agentProvider: "codex",
  });
  expect(codex).toContain("<plan-gate-directive>");
  expect(codex).toContain("Do NOT write or modify ANY code this turn");
  expect(codex).not.toContain("AskUserQuestion");
  // Claude keeps the original AskUserQuestion phrasing and has no extra stop clause.
  expect(
    composeSystemPrompt(null, false, { planGate: "interactive", agentProvider: "claude" }),
  ).toContain("AskUserQuestion");
});

test("codex auto plan-gate also gets the hardened stop clause (unattended path, no human backstop)", () => {
  const codex = composeSystemPrompt(null, false, { planGate: "auto", agentProvider: "codex" });
  expect(codex).toContain("<plan-gate-directive>");
  expect(codex).toContain("running unattended");
  expect(codex).toContain("Do NOT write or modify ANY code this turn");
  // Claude's auto variant keeps the original phrasing — no extra stop clause.
  expect(
    composeSystemPrompt(null, false, { planGate: "auto", agentProvider: "claude" }),
  ).not.toContain("Do NOT write or modify ANY code this turn");
});

test("planBlockInstructions(INTERACTIVE) drops AskUserQuestion for codex, keeps it for claude", () => {
  expect(planBlockInstructions({ allowQuestionForm: false, agentProvider: "codex" })).not.toContain(
    "AskUserQuestion",
  );
  expect(planBlockInstructions({ allowQuestionForm: false, agentProvider: "claude" })).toContain(
    "AskUserQuestion",
  );
});
