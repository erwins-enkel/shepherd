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
test("#1812 B/H: both plan-gate directives list Out-of-Scope + testing-seams schema sections", () => {
  // Content assertions on the RENDERED directive text (NOT the self-referential
  // planGateDirective*("claude") === constant guard, which stays green regardless).
  for (const d of [PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO]) {
    expect(d).toContain("out of scope");
    expect(d).toContain("testing seams + decisions");
    // pre-existing schema sections still present (additive change, nothing dropped)
    expect(d).toContain("success criteria");
  }
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

// ─── operator-language injection (Task 4, issue #1586) ──────────────────────

test("en is byte-identical: composeSystemPrompt with/without explicit operatorLanguage:'en'", () => {
  const representativeOpts = [
    { planGate: "interactive" as const },
    { planGate: "auto" as const },
    {},
    { agentProvider: "codex" as const },
    { planGate: "interactive" as const, agentProvider: "codex" as const },
  ];
  for (const opts of representativeOpts) {
    const withoutLang = composeSystemPrompt(null, false, opts);
    const withEnLang = composeSystemPrompt(null, false, { ...opts, operatorLanguage: "en" });
    expect(withEnLang).toBe(withoutLang);
    expect(withoutLang).not.toContain("operator-language");
    expect(withEnLang).not.toContain("operator-language");
  }
});

test("en is byte-identical: planBlockInstructions with/without explicit operatorLanguage:'en'", () => {
  for (const allowQuestionForm of [true, false]) {
    const withoutLang = planBlockInstructions({ allowQuestionForm });
    const withEnLang = planBlockInstructions({ allowQuestionForm, operatorLanguage: "en" });
    expect(withEnLang).toBe(withoutLang);
  }
});

test("import-time PLAN_GATE_DIRECTIVE constants render as 'en' regardless of env (import-time-constant trap)", () => {
  // These are computed at module-import time with the literal "en" default — never config.operatorLanguage.
  // This documents the contract: they must never carry the German directive or field-discipline text,
  // even when SHEPHERD_OPERATOR_LANGUAGE=de is set in the environment.
  for (const d of [PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO]) {
    expect(d).not.toContain("operator-language");
    // visualBlockLanguageLine("de")'s distinctive marker — must never appear in the "en"-rendered constant.
    expect(d).not.toContain("write ONLY these natural-language fields");
  }
});

test("de injects <operator-language> naming German, for both claude and codex", () => {
  const claude = composeSystemPrompt(null, false, { operatorLanguage: "de" });
  const codex = composeSystemPrompt(null, false, {
    operatorLanguage: "de",
    agentProvider: "codex",
  });
  for (const p of [claude, codex]) {
    expect(p).toContain("<operator-language>");
    expect(p).toContain("German");
  }
});

test("de plan sidecar instructions carry the field-discipline verbatim-fields line", () => {
  const t = planBlockInstructions({ allowQuestionForm: true, operatorLanguage: "de" });
  for (const field of [
    "type",
    "id",
    "tone",
    "change",
    "path",
    "mermaid.source",
    "method",
    "surface",
    "kind",
  ]) {
    expect(t).toContain(field);
  }
});

// Worktree git-stash safety notice (#1632) — a global git-mechanism invariant that must ride
// EVERY spawn, regardless of learnings / research / plan-gate / autopilot state.
test("worktree-stash-notice rides every spawn variant", () => {
  const variants = [
    composeSystemPrompt(null, false), // plain code spawn, no learnings
    composeSystemPrompt("<shepherd-house-rules>\n- x\n</shepherd-house-rules>", false), // with house rules
    composeSystemPrompt(null, true), // autopilot
    composeSystemPrompt(null, false, { research: true }), // research
    composeSystemPrompt(null, true, { planGate: "interactive" }), // plan gate
  ];
  for (const p of variants) {
    expect(p).toContain("<worktree-stash-notice>");
    expect(p).toContain("refs/stash");
  }
});

test("worktree-stash-notice recommends read-only + create/apply, never store or bare stash", () => {
  const p = composeSystemPrompt(null, false);
  // Read-only inspection is the primary safe path.
  expect(p).toContain("git show <ref>:<path>");
  expect(p).toContain("git diff <ref>");
  expect(p).toContain("git worktree add");
  // Safe shelve = create (tracked-only, prints a SHA) + apply <sha>.
  expect(p).toContain("git stash create");
  expect(p).toContain("git stash apply <sha>");
  // `git stash store` writes the shared stack — only ever named as the thing NOT to do.
  expect(p).toContain("never `git stash store`");
  expect(p).not.toContain("use `git stash store`");
  // Bare stash/pop explicitly prohibited.
  expect(p).toContain("never bare `git stash`");
});

test("both plan-gate directives tell the planner to reference code by path + symbol", () => {
  // The reviewer is barred from raising location findings, so a planner still emitting line
  // numbers produces noise that cannot be acted on. Both directives must carry the rule.
  for (const d of [PLAN_GATE_DIRECTIVE_INTERACTIVE, PLAN_GATE_DIRECTIVE_AUTO]) {
    expect(d).toContain("FILE PATH + SYMBOL");
    expect(d).toContain("never by line number");
    // The stripping claim must stay QUALIFIED: stripPlanLineRefs only removes refs bound to an
    // extension-bearing path, so `Makefile:88` and `foo.ts (line 411)` survive (pinned in
    // plan-gate-prompt.test.ts). An unqualified "line numbers are stripped" would promise a
    // guarantee the code does not make.
    expect(d).toContain("path-attached line refs are stripped");
    expect(d).not.toContain("line numbers are stripped");
  }
});
